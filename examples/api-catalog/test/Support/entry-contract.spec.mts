import type * as Module from 'node:module';
import {
  binaryValue,
  jsonArray,
  jsonObject,
  jsonSequence,
} from '../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  callTestMethod,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
/** Node-only routing contracts: WASM exports and platform bindings are boundary doubles. */
import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import { registerHooks } from 'node:module';
import * as runtime from '@cloudflare-workers-hs/runtime';

const hooks = registerHooks({
  resolve(
    specifier: string,
    context: Module.ResolveHookContext,
    next: (
      specifier: string,
      context?: Partial<Module.ResolveHookContext>,
    ) => Module.ResolveFnOutput,
  ): import('module').ResolveFnOutput {
    if (specifier === 'cloudflare:workers') {
      return {
        url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
        shortCircuit: true,
      };
    }

    if (specifier === 'cloudflare:sockets') {
      return {
        url: 'data:text/javascript,export function connect() { throw new Error("No native sockets in Node contract"); }',
        shortCircuit: true,
      };
    }

    if (
      specifier.startsWith('.') &&
      !specifier.endsWith('.mjs') &&
      !specifier.endsWith('.mts') &&
      !specifier.endsWith('.wasm') &&
      !specifier.endsWith('.ts')
    ) {
      return next(
        specifier.endsWith('.js') ? specifier.slice(0, -3) + '.ts' : specifier + '.ts',
        context,
      );
    }

    return next(specifier, context);
  },
  load(
    url: string,
    context: Module.LoadHookContext,
    next: (url: string, context?: Partial<Module.LoadHookContext>) => Module.LoadFnOutput,
  ): import('module').LoadFnOutput {
    if (url.endsWith('api-catalog.wasm')) {
      return {
        format: 'module',
        source: 'export default {};',
        shortCircuit: true,
      };
    }

    return next(url, context);
  },
});
const application: Record<string, unknown> = {};
const reactor: Record<string, unknown> = {};
const table: Record<string, unknown> = {};
const mocks = [
  mock.module(new URL('./runtime.ts', import.meta.url).href, {
    namedExports: { reactor },
  }),
  mock.module(new URL('../../worker/runtime.ts', import.meta.url).href, {
    namedExports: { reactor: application },
  }),
  mock.module(new URL('../../worker/api-catalog-jsffi.mjs', import.meta.url).href, {
    defaultExport: () => ({}),
  }),
  mock.module('@cloudflare-workers-hs/runtime', {
    namedExports: {
      ...runtime,
      async createReactor(
        _wasm: unknown,
        imports: (arg0: {}) => unknown,
        bind: (arg0: {}) => unknown,
      ): Promise<unknown> {
        assert.equal(typeof imports, 'function');
        assert.deepEqual(imports({}), {});
        return bind(table);
      },
    },
  }),
];
let serial = 0;
async function entry(coverage: boolean = true): Promise<unknown> {
  table.fetch = async () => new Response('fixture');

  if (coverage) {
    table.coverage = async () => 'fixture-coverage';
  } else {
    delete table.coverage;
  }
  return jsonObject(
    await callTestBoundary(loadTestModule, new URL(`./entry.ts?case=${++serial}`, import.meta.url)),
  ).default;
}
const request = (
  path: string,
  options?: RequestInit<CfProperties<unknown>> | undefined,
): Request<unknown, CfProperties<unknown>> => new Request(`https://fixture.test${path}`, options);
void after(() => {
  mocks.forEach((item) => item.restore());
  hooks.deregister();
});

void test('coverage endpoint requires all three instrumented reactors', async () => {
  for (const missing of ['application', 'reactor', 'fixture', 'none']) {
    application.coverage =
      missing === 'application' ? undefined : async () => 'application-coverage';
    reactor.coverage = missing === 'reactor' ? undefined : async () => 'support-coverage';
    const worker = await entry(missing !== 'fixture');
    const response = await callTestMethod(worker, 'fetch', request('/__fixture/coverage'), {}, {});

    if (missing === 'none') {
      assert.deepEqual(await callTestMethod(jsonObject(response), 'json'), [
        'application-coverage',
        'support-coverage',
        'fixture-coverage',
      ]);
    } else {
      assert.equal(jsonObject(response).status, 503);
      assert.equal(await callTestMethod(jsonObject(response), 'text'), 'Coverage build required');
    }
  }
});

void test('configuration fixture validates query before forwarding exact invalid values', async () => {
  const worker = await entry();
  const forwarded: { target: Request; env: unknown; ctx: unknown }[] = [];
  table.fetch = async (target: Request, env: unknown, ctx: unknown) => {
    callTestMethod(forwarded, 'push', { target, env, ctx });
    return new Response('handled');
  };
  // bindExport captures the table function at construction, so use another real entry instance.
  const configured = jsonObject(
    await callTestBoundary(loadTestModule, new URL(`./entry.ts?case=${++serial}`, import.meta.url)),
  ).default;
  for (const suffix of [
    '',
    '?binding=OTHER&kind=null',
    '?binding=EXAMPLE_SECRET',
    '?binding=EXAMPLE_MODE&kind=wat',
  ]) {
    assert.equal(
      jsonObject(
        await callTestMethod(
          configured,
          'fetch',
          request(`/__fixture/configuration-invalid${suffix}`),
          {},
          {},
        ),
      ).status,
      400,
    );
  }
  assert.equal(forwarded.length, 0);
  const bindings = { EXAMPLE_SECRET: 'original', EXAMPLE_MODE: 'original' },
    context = {};
  for (const binding of ['EXAMPLE_SECRET', 'EXAMPLE_MODE']) {
    for (const [kind, expected] of [
      ['missing', undefined],
      ['undefined', undefined],
      ['null', null],
      ['number', 123],
      ['boolean', false],
      ['object', {}],
    ] as const) {
      assert.equal(
        await callTestMethod(
          await callTestMethod(
            configured,
            'fetch',
            request(`/__fixture/configuration-invalid?binding=${binding}&kind=${kind}`),
            bindings,
            context,
          ),
          'text',
        ),
        'handled',
      );
      const call = forwarded.at(-1);
      assert.ok(call);
      assert.equal(new URL(call.target.url).pathname, '/configuration');
      assert.deepEqual(jsonObject(call.env)[binding], expected);
      assert.equal(Object.hasOwn(jsonObject(call.env), binding), kind !== 'missing');
      assert.equal(call.ctx, context);
    }
  }
  await callTestMethod(
    configured,
    'fetch',
    request('/__fixture/configuration-missing'),
    bindings,
    context,
  );
  assert.equal(Object.hasOwn(jsonObject(forwarded.at(-1)?.env), 'EXAMPLE_SECRET'), false);
  assert.deepEqual(bindings, {
    EXAMPLE_SECRET: 'original',
    EXAMPLE_MODE: 'original',
  });
  assert.equal(typeof jsonObject(worker).fetch, 'function');
});

void test('socket and HTTP ingress reject missing configuration and preserve selected arguments', async () => {
  const worker = await entry();
  for (const scenario of ['unknown', 'untrusted', 'peer-disconnect', 'close-race']) {
    assert.equal(
      jsonObject(
        await callTestMethod(worker, 'fetch', request(`/__fixture/socket/${scenario}`), {}, {}),
      ).status,
      400,
    );
  }
  for (const [scenario, variable] of [
    ['untrusted', 'UNTRUSTED_TLS_ADDRESS'],
    ['peer-disconnect', 'INTERRUPTED_TCP_ADDRESS'],
    ['close-race', 'TCP_ADDRESS'],
  ] as const) {
    reactor.socketBoundary = async (connect: unknown, name: unknown, address: unknown) => {
      assert.equal(typeof connect, 'function');
      assert.equal(name, scenario);
      assert.equal(address, 'host:443');
      return '{"checked":true}';
    };
    assert.deepEqual(
      await callTestMethod(
        await callTestMethod(
          worker,
          'fetch',
          request(`/__fixture/socket/${scenario}`),
          { [variable]: 'host:443' },
          {},
        ),
        'json',
      ),
      { checked: true },
    );
  }
  for (const [path, method] of [
    ['client-upload', 'clientUploadLifecycle'],
    ['client-http-stream', 'clientHTTPStreamLifecycle'],
  ] as const) {
    for (const origin of [undefined, null, 123]) {
      assert.equal(
        jsonObject(
          await callTestMethod(
            worker,
            'fetch',
            request(`/__fixture/${path}`),
            { CLIENT_ORIGIN: origin },
            {},
          ),
        ).status,
        500,
      );
    }
    reactor[method] = async (origin: unknown) => {
      assert.equal(origin, 'https://origin.test');
      return '{"ok":true}';
    };
    assert.deepEqual(
      await callTestMethod(
        await callTestMethod(
          worker,
          'fetch',
          request(`/__fixture/${path}`),
          { CLIENT_ORIGIN: 'https://origin.test' },
          {},
        ),
        'json',
      ),
      { ok: true },
    );
  }
});

void test('attachment capability reports each read failure and always cleans up', async () => {
  const worker = await entry();
  for (const mode of [
    'normal',
    'null',
    'wrong-body',
    'get-failure',
    'body-failure',
    'put-failure',
  ]) {
    const calls: unknown[][] = [];
    const bucket = {
      async put(
        key: unknown,
        body: unknown,
        options: { ssecKey: { byteLength: unknown } },
      ): Promise<{ ssecKeyMd5: string } | null> {
        jsonArray(calls).push('put');
        assert.equal(key, 'attachments/capability-probe');
        assert.equal(body, 'capability-probe');
        assert.equal(options.ssecKey.byteLength, 32);

        if (mode === 'put-failure') {
          throw new Error('put failed');
        }

        return mode === 'null' ? null : { ssecKeyMd5: 'md5' };
      },
      async get(
        key: unknown,
        options?: { ssecKey: AllowSharedBufferSource | undefined },
      ): Promise<{ text(): Promise<'capability-probe' | 'wrong'> } | null> {
        jsonArray(calls).push(options ? new TextDecoder().decode(options.ssecKey) : 'no-key');

        if (mode === 'null') {
          return null;
        }

        if (mode === 'get-failure') {
          throw new Error('get failed');
        }

        return {
          async text(): Promise<'capability-probe' | 'wrong'> {
            if (mode === 'body-failure') {
              throw new Error('body failed');
            }

            return mode === 'wrong-body' ? 'wrong' : 'capability-probe';
          },
        };
      },
      async delete(key: unknown): Promise<void> {
        assert.equal(key, 'attachments/capability-probe');
        jsonArray(calls).push('delete');
      },
    };
    const response = callTestMethod(
      worker,
      'fetch',
      request('/__fixture/attachments/capability'),
      { EXAMPLE_BUCKET: bucket },
      {},
    );

    if (mode === 'put-failure') {
      await assert.rejects(Promise.resolve(response), /put failed/);
      assert.deepEqual(calls, ['put', 'delete']);
    } else {
      assert.deepEqual(await callTestMethod(jsonObject(await response), 'json'), {
        keyMetadataPresent: mode !== 'null',
        correctKeyReadable: mode === 'normal',
        wrongKeyReadable: mode === 'normal',
        noKeyReadable: mode === 'normal',
      });
      assert.deepEqual(calls, [
        'put',
        '0123456789abcdef0123456789abcdef',
        'fedcba9876543210fedcba9876543210',
        'no-key',
        'delete',
      ]);
    }
  }
});

void test('attachment routing changes key only in copied bindings and preserves request', async () => {
  await entry();
  table.fetch = async (
    target: { url: string | URL; text: () => unknown; method: unknown },
    bindings: object,
    ctx: { marker: unknown },
  ) =>
    Response.json({
      path: new URL(target.url).pathname,
      query: new URL(target.url).search,
      body: await target.text(),
      method: target.method,
      key: jsonObject(bindings).ATTACHMENT_SSEC_KEY ?? null,
      hasKey: Object.hasOwn(bindings, 'ATTACHMENT_SSEC_KEY'),
      socket: typeof jsonObject(bindings).SOCKET_CONNECT,
      ctx: ctx.marker,
    });
  const worker = jsonObject(
    await callTestBoundary(loadTestModule, new URL(`./entry.ts?case=${++serial}`, import.meta.url)),
  ).default;
  const env = { ATTACHMENT_SSEC_KEY: 'original' };
  for (const [variant, key] of [
    ['missing-key', null],
    ['invalid-key', 'invalid'],
    ['valid-key', '0123456789abcdef0123456789abcdef'],
    ['wrong-key', 'fedcba9876543210fedcba9876543210'],
  ] as const) {
    assert.deepEqual(
      await callTestMethod(
        await callTestMethod(
          jsonObject(worker),
          'fetch',
          request(`/__fixture/attachments/${variant}/a?x=1`, {
            method: 'PUT',
            body: 'payload',
          }),
          env,
          { marker: 3 },
        ),
        'json',
      ),
      {
        path: '/attachments/a',
        query: '?x=1',
        method: 'PUT',
        body: 'payload',
        key,
        hasKey: variant !== 'missing-key',
        socket: 'function',
        ctx: 3,
      },
    );
  }
  assert.equal(env.ATTACHMENT_SSEC_KEY, 'original');
});

void test('stream route waits for cancellation and retains its completion observation', async () => {
  const worker = await entry();
  reactor.memory = new WebAssembly.Memory({ initial: 1 });
  for (const mode of [
    'normal',
    'failure',
    'limit',
    'cancel-failure',
    'cancel-delayed',
    'cancel-delayed-failure',
  ]) {
    reactor.drainStream = async (stream: { getReader: () => unknown }, limit: unknown) => {
      assert.equal(limit, 4);
      const reader = stream.getReader();
      try {
        if (mode === 'failure') {
          await assert.rejects(
            Promise.resolve(callTestMethod(jsonObject(reader), 'read')),
            /original stream failure/,
          );
        } else if (mode === 'normal') {
          assert.equal(
            binaryValue(jsonObject(await callTestMethod(jsonObject(reader), 'read')).value).length,
            0,
          );
          assert.deepEqual(
            jsonObject(await callTestMethod(jsonObject(reader), 'read')).value,
            new Uint8Array([0, 128, 255]),
          );
          assert.equal(jsonObject(await callTestMethod(jsonObject(reader), 'read')).done, true);
        } else {
          assert.equal(
            binaryValue(jsonObject(await callTestMethod(jsonObject(reader), 'read')).value).length,
            16 * 1024 * 1024,
          );

          if (mode.endsWith('failure')) {
            await assert.rejects(
              Promise.resolve(callTestMethod(jsonObject(reader), 'cancel')),
              /cancel failure must not replace limit/,
            );
          } else {
            await callTestMethod(jsonObject(reader), 'cancel');
          }
        }
      } finally {
        callTestMethod(jsonObject(reader), 'releaseLock');
      }
      return '{"observed":true}';
    };
    assert.deepEqual(
      await callTestMethod(
        await callTestMethod(worker, 'fetch', request(`/__fixture/stream?mode=${mode}`), {}, {}),
        'json',
      ),
      {
        observed: true,
        cancelled: ['normal', 'failure'].includes(mode) ? 0 : 1,
        cancellationFinished: ['limit', 'cancel-delayed', 'cancel-delayed-failure'].includes(mode),
        locked: false,
        memoryGrowth: 0,
      },
    );
  }
});

void test('entry rejects missing HTTP origin and forwards ordinary traffic', async () => {
  const worker = await entry();
  for (const value of [undefined, 12, null]) {
    const response = await callTestMethod(
      worker,
      'fetch',
      request('/__fixture/client-default-options'),
      { CLIENT_ORIGIN: value },
      {},
    );
    assert.equal(jsonObject(response).status, 500);
    assert.equal(await callTestMethod(jsonObject(response), 'text'), 'Missing HTTP fixture origin');
  }
  assert.equal(
    await callTestMethod(
      await callTestMethod(worker, 'fetch', request('/__fixture/misc/configuration'), {}, {}),
      'text',
    ),
    'fixture',
  );
});
