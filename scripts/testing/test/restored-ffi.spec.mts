import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Miniflare } from 'miniflare';
import { repositoryRoot, textFile } from '../Support/cli.mts';

const foreignImport =
  /foreign import javascript (?:safe|unsafe)\s+(?:"""([\s\S]*?)"""|"([^"\n]*)")\s+(\w+)\s*::/g;

function bindImports(module: string, signatures: Record<string, string>): string {
  const source = textFile(
    join(repositoryRoot, 'cloudflare-workers/src/Cloudflare/Workers/Internal/FFI', module + '.hs'),
  );
  const snippets = new Map(
    [...source.matchAll(foreignImport)].map(([, multiline, single, name]) => [
      name,
      multiline ?? single,
    ]),
  );

  return Object.entries(signatures)
    .map(([name, args]) => {
      const expression = snippets.get(name);
      assert.ok(expression, 'Missing foreign import: ' + name);
      return `const ${name} = (${args}) => (${expression});`;
    })
    .join('\n');
}

const bindings = [
  bindImports('DurableObject', {
    jsDoNewUniqueIdJurisdictionEnveloped: '$1, $2',
    jsDoJurisdictionEnveloped: '$1, $2',
    jsDoAlarmRetryCount: '$1',
    jsDoAlarmIsRetry: '$1',
    jsDoAlarmScheduledTime: '$1',
    jsAlarmTimeMillis: '$1',
  }),
  bindImports('Abort', {
    jsNewAbortController: '',
    jsAbortSignal: '$1',
    jsAbort: '$1',
    jsAborted: '$1',
  }),
  bindImports('WorkersAI', { jsRunEnveloped: '$1, $2, $3, $4, $5, $6' }),
  bindImports('NativeResponse', {
    jsResponseWithHeaders: '$1, $2',
    jsResponseWithStatus: '$1, $2, $3, $4',
  }),
];

const worker = `
${bindings.join('\n')}

function unwrap(result) {
  if (!result.ok) {
    throw new Error(result.message);
  }

  return result.value;
}

function namespace() {
  const binding = {
    newUniqueId(options) {
      return { options, bound: this === binding };
    },
    jurisdiction(region) {
      if (region !== 'eu') {
        throw new Error('Jurisdiction rejected');
      }

      return { region, bound: this === binding };
    },
  };

  return {
    identifier: unwrap(jsDoNewUniqueIdJurisdictionEnveloped(binding, 'eu')),
    namespace: unwrap(jsDoJurisdictionEnveloped(binding, 'eu')),
    rejected: jsDoJurisdictionEnveloped(binding, 'unknown-jurisdiction'),
  };
}

function alarmInfo() {
  const alarm = { retryCount: 2, isRetry: true, scheduledTime: 12345 };

  return {
    retryCount: jsDoAlarmRetryCount(alarm),
    isRetry: jsDoAlarmIsRetry(alarm),
    scheduledTime: jsAlarmTimeMillis(jsDoAlarmScheduledTime(alarm)),
    initialRetryCount: jsDoAlarmRetryCount(undefined),
    initialIsRetry: jsDoAlarmIsRetry(undefined),
    missingScheduledTime: jsDoAlarmScheduledTime(undefined),
  };
}

async function abort() {
  const controller = jsNewAbortController();
  const signal = jsAbortSignal(controller);
  const before = jsAborted(signal);
  jsAbort(controller);
  const binding = {
    run(_model, _input, options) {
      return { sameSignal: options.signal === signal, aborted: options.signal.aborted };
    },
  };
  const result = unwrap(await jsRunEnveloped(binding, 'fixture', '{}', '{}', signal, false));

  return { before, after: jsAborted(signal), dispatched: JSON.parse(result) };
}

async function responseHeaders() {
  const original = new Response('payload', { status: 202, headers: { 'x-old': 'drop' } });
  const headers = JSON.stringify([
    ['set-cookie', 'first=1'],
    ['set-cookie', 'second=2'],
    ['x-new', 'keep'],
  ]);
  const result = unwrap(jsResponseWithHeaders({ original, body: original.body }, headers));

  return {
    status: result.status,
    body: await result.text(),
    oldHeader: result.headers.get('x-old'),
    newHeader: result.headers.get('x-new'),
    cookies: result.headers.getSetCookie(),
  };
}

async function responseStatus() {
  const snapshot = { body: 'payload', cf: { origin: 'test' } };
  const headers = JSON.stringify([['x-new', 'keep']]);
  const result = unwrap(jsResponseWithStatus(snapshot, 201, headers, true));

  return {
    status: result.status,
    header: result.headers.get('x-new'),
    body: await result.text(),
    cf: result.cf,
  };
}

function upgrade() {
  const [client] = Object.values(new WebSocketPair());
  const snapshot = { body: null, webSocket: client };
  const result = unwrap(jsResponseWithStatus(snapshot, 101, '[]', false));

  return { status: result.status, attached: result.webSocket === client };
}

const scenarios = {
  '/namespace': namespace,
  '/alarm': alarmInfo,
  '/abort': abort,
  '/response-headers': responseHeaders,
  '/response-status': responseStatus,
  '/upgrade': upgrade,
};

export default {
  async fetch(request) {
    return Response.json(await scenarios[new URL(request.url).pathname]());
  },
};
`;

const runtime = new Miniflare({
  workers: [
    {
      config: {
        name: 'restored-ffi',
        compatibilityDate: '2026-07-21',
        manifest: {
          mainModule: 'worker.mjs',
          modulesRoot: repositoryRoot,
          modules: { 'worker.mjs': { type: 'esm', contents: worker } },
        },
      },
    },
  ],
});
void after(async () => runtime.dispose());

async function scenario(path: string): Promise<unknown> {
  const response = await runtime.dispatchFetch('http://ffi.test' + path);

  if (response.status !== 200) {
    assert.fail(`${path} returned ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

void test('Durable Object jurisdiction forwards the region and preserves binding failures', async () => {
  assert.deepEqual(await scenario('/namespace'), {
    identifier: { options: { jurisdiction: 'eu' }, bound: true },
    namespace: { region: 'eu', bound: true },
    rejected: { ok: false, message: 'Error: Jurisdiction rejected' },
  });
});

void test('Durable Object alarm fields preserve retry metadata and defaults', async () => {
  assert.deepEqual(await scenario('/alarm'), {
    retryCount: 2,
    isRetry: true,
    scheduledTime: 12345,
    initialRetryCount: 0,
    initialIsRetry: false,
    missingScheduledTime: null,
  });
});

void test('Workers AI receives the same signal after its AbortController aborts', async () => {
  assert.deepEqual(await scenario('/abort'), {
    before: false,
    after: true,
    dispatched: { sameSignal: true, aborted: true },
  });
});

void test('native response header replacement keeps the body, status and distinct cookies', async () => {
  assert.deepEqual(await scenario('/response-headers'), {
    status: 202,
    body: 'payload',
    oldHeader: null,
    newHeader: 'keep',
    cookies: ['first=1', 'second=2'],
  });
});

void test('native response status reconstruction reads headers independently of the status', async () => {
  assert.deepEqual(await scenario('/response-status'), {
    status: 201,
    header: 'keep',
    body: 'payload',
    cf: { origin: 'test' },
  });
});

void test('native response status reconstruction attaches the WebSocket on an upgrade', async () => {
  assert.deepEqual(await scenario('/upgrade'), { status: 101, attached: true });
});
