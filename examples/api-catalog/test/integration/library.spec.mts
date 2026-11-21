import {
  jsonNumber,
  jsonObject,
  jsonString,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import { registerR2ExampleExtraTests } from './r2-example-extra.cases.mts';
import { registerMiscExampleExtraCases } from './misc-example-extra.cases.mts';
import { registerArchiveTests } from './archives.cases.mts';
import { registerSocketFailureTests } from './socket-failures.cases.mts';
import { registerClientUploadTests } from './client-upload.cases.mts';
import { registerClientStreamTests } from './client-stream.cases.mts';
import { registerAttachmentsTests } from './attachments.cases.mts';
import { registerClientOptionsTests } from './client-options.cases.mts';
import { registerConfigurationCases } from './configuration.cases.mts';
import { registerR2Tests } from './r2.cases.mts';
import { registerClientPolicyTests } from './client-policy.cases.mts';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from '../Support/dev-runtime.mts';

let runtime: Awaited<ReturnType<typeof startRuntime>>;
void before(
  async () => {
    runtime = await startRuntime();
  },
  { timeout: 125000 },
);
void after(async () => {
  await runtime?.close();
});
async function request(path: string, method: string = 'GET'): Promise<unknown> {
  const response = await fetch(runtime.base + path, {
    method,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`);
  return response.json();
}
void test('Servant root handler serves health', async () =>
  assert.deepEqual(await request('/health'), { status: 'ok' }));
void test('real KV stores TTL metadata and reads a batch and key listing', async () => {
  const result = await request('/settings', 'POST');
  assert.equal(jsonObject(result).value, 'Download exports from the management API');
  assert.equal(jsonObject(jsonValue(jsonObject(result).metadata)).version, 1);
  assert.deepEqual(jsonObject(result).keys, ['display:guide']);
  assert.equal(jsonObject(result).complete, true);
  assert.deepEqual(jsonObject(result).batch, [
    { key: 'display:guide', value: jsonObject(result).value },
    { key: 'display:absent', value: null },
  ]);
});
void test('real Cache transitions miss to hit and invalidates', async () => {
  await request('/guide', 'DELETE');
  assert.deepEqual(await request('/guide'), { cache: 'miss' });
  assert.deepEqual(await request('/guide'), { cache: 'hit' });
  assert.deepEqual(await request('/guide', 'DELETE'), { removed: true });
  assert.deepEqual(await request('/guide'), { cache: 'miss' });
});
void test('real Service Binding calls the second Haskell worker', async () =>
  assert.deepEqual(await request('/service'), {
    status: 200,
    health: { status: 'ok' },
    echo: 'typed body',
    conflict: 409,
  }));
void test('real TCP connector sends bytes and reads the bounded fixture echo', async () =>
  assert.deepEqual(await request('/tcp'), { message: 'api-catalog\n' }));

void test('producer stream tolerates empty chunks and terminates at EOF', async () =>
  assert.deepEqual(await request('/stream'), { message: 'streamed' }));

void test('binary drain preserves bytes and releases the reader at EOF', async () => {
  const result = await request('/__fixture/stream?mode=success');
  assert.deepEqual(jsonObject(result).bytes, [0, 128, 255]);
  assert.equal(jsonObject(result).locked, false);
  assert.equal(jsonObject(result).cancelled, 0);
});
for (const mode of ['limit', 'cancel-failure']) {
  void test(`byte limit cancels before WASM copy and releases lock (${mode})`, async () => {
    const result = await request(`/__fixture/stream?mode=${mode}`);
    assert.equal(jsonObject(result).outcome, 'ReadableStreamExceededByteLimit');
    assert.equal(jsonObject(result).locked, false);
    assert.equal(jsonObject(result).cancelled, 1);
    assert.ok(
      jsonNumber(jsonObject(result).memoryGrowth) < 16 * 1024 * 1024,
      `unexpected WASM growth: ${jsonObject(result).memoryGrowth}`,
    );
  });
}
void test('read failure releases reader and preserves original failure', async () => {
  const result = await request('/__fixture/stream?mode=failure');
  assert.match(jsonString(jsonObject(result).error), /original stream failure/);
  assert.equal(jsonObject(result).locked, false);
});
for (const mode of ['cancel-delayed', 'cancel-delayed-failure']) {
  void test(`byte limit waits for asynchronous producer cancellation (${mode})`, async () => {
    const result = await request(`/__fixture/stream?mode=${mode}`);
    assert.equal(jsonObject(result).outcome, 'ReadableStreamExceededByteLimit');
    assert.equal(jsonObject(result).cancelled, 1);
    assert.equal(jsonObject(result).cancellationFinished, true);
    assert.equal(jsonObject(result).locked, false);
  });
}
void test('native-shaped Tail events reach the real Haskell entrypoint', async () => {
  assert.deepEqual(await request('/__fixture/tail'), { delivered: true });
  const expected = /tail outcome=ok script=library-tail-fixture timestamp=Just 1788739200000/;
  const deadline = Date.now() + 5000;
  let log = '';
  while (Date.now() < deadline) {
    log = runtime.logs();

    if (expected.test(log)) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(log, expected);
});

void test('refused socket observes both failure promises and becomes closed', async () => {
  assert.deepEqual(await request('/__fixture/socket-failure'), {
    openedFailed: true,
    closedFailed: true,
    state: 'SocketClosed',
  });
  const log = runtime.logs();
  assert.doesNotMatch(log, /Uncaught.*[Pp]romise|unhandled.*rejection/i);
});

for (const status of [200, 204, 205, 304]) {
  for (const variant of [0, 1]) {
    void test(`native Response handles empty ${variant === 0 ? 'strict' : 'lazy'} bytes for ${status}`, async () => {
      assert.deepEqual(
        await request(`/__fixture/empty-response?status=${status}&variant=${variant}`),
        {
          status,
          nullBody: status !== 200,
          header: 'retained',
          body: '',
        },
      );
    });
  }
}

registerClientPolicyTests(request);

registerR2Tests({ request });

void test('real TLS socket verifies the fixture CA and exchanges encrypted bytes', async () => {
  assert.deepEqual(await request('/tls'), {
    message: 'library-tls\n',
    upgraded: false,
    secureTransport: 'SecureTransportOn',
  });
});
void test('real StartTLS upgrades the existing TCP connection exactly once', async () => {
  assert.deepEqual(await request('/starttls'), {
    message: 'library-tls\n',
    upgraded: true,
    secureTransport: 'SecureTransportOn',
  });
});
void test('workerd delivers the producer event to the configured Haskell Tail Worker', async () => {
  const { readFile } = await import('node:fs/promises');
  await request('/service');
  const deadline = Date.now() + 5000;
  let output = '';
  let delivered;
  while (Date.now() < deadline) {
    output = runtime.logs();
    const envelopes = [...output.matchAll(/native-tail-envelope (\[[^\n]+\])/g)].flatMap((match) =>
      jsonValue(match[1]),
    );
    delivered = envelopes.find(
      (event) =>
        jsonObject(event).outcome === 'ok' &&
        jsonString(jsonObject(event).requestURL)?.endsWith('/health') &&
        typeof jsonObject(event).timestamp === 'number',
    );

    if (
      delivered &&
      output.includes(
        `tail outcome=ok script=${jsonObject(delivered).scriptName ?? 'unknown'} timestamp=Just ${jsonObject(delivered).timestamp}`,
      )
    ) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(delivered, 'Real runtime Tail envelope should contain the guide HTTP event');
  assert.ok(
    output.includes(
      `tail outcome=ok script=${jsonObject(delivered).scriptName ?? 'unknown'} timestamp=Just ${jsonObject(delivered).timestamp}`,
    ),
    'Haskell tail decoder preserves the real envelope fields (scriptName is optional locally)',
  );
});

registerConfigurationCases(() => runtime);

registerAttachmentsTests(() => runtime);
registerClientOptionsTests(() => runtime);

void test('declarative cache policy and uncached edge diagnostic', async () => {
  const guide = await fetch(runtime.base + '/guide');
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get('cache-control') ?? '', /public/);
  assert.match(guide.headers.get('cache-control') ?? '', /max-age=60/);
  const edge = await fetch(runtime.base + '/diagnostics/edge');
  assert.equal(edge.status, 200);
  assert.equal(edge.headers.get('cache-control'), 'no-store');
  const value = await edge.json();
  assert.ok(jsonObject(value).colo === null || typeof jsonObject(value).colo === 'string');
});

registerClientStreamTests(() => runtime);

registerClientUploadTests(() => runtime);

void test('D1 catalog uses prepared parameters and typed reads repeatably', async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await request('/database/catalog', 'POST');
    assert.equal(jsonObject(result).written, true);
    assert.equal(jsonObject(result).firstPresent, true);
    assert.equal(jsonObject(result).rows, 1);
    assert.equal(jsonObject(result).title, "Worker's guide");
    assert.equal(jsonObject(jsonObject(result).setup).count, 1);
    for (const meta of [
      jsonObject(result).setup,
      jsonObject(result).writeMeta,
      jsonObject(result).readMeta,
    ]) {
      assert.equal(Number.isFinite(jsonObject(meta).durationMs), true);
      assert.ok(jsonNumber(jsonObject(meta).durationMs) >= 0);
    }
    for (const meta of [jsonObject(result).writeMeta, jsonObject(result).readMeta]) {
      for (const field of ['changes', 'lastRowIdentifier', 'rowsRead', 'rowsWritten']) {
        assert.equal(
          Number.isSafeInteger(jsonObject(meta)[field]),
          true,
          `${field} must be a native integer`,
        );
      }
    }
    assert.equal(jsonObject(jsonObject(result).writeMeta).changes, 1);
    assert.ok(Number.isInteger(jsonObject(jsonObject(result).writeMeta).lastRowIdentifier));
    assert.ok(jsonNumber(jsonObject(jsonObject(result).writeMeta).lastRowIdentifier) > 0);
    assert.ok(jsonNumber(jsonObject(jsonObject(result).writeMeta).rowsWritten) >= 1);
    assert.ok(jsonNumber(jsonObject(jsonObject(result).writeMeta).rowsRead) >= 0);
    assert.equal(jsonObject(jsonObject(result).readMeta).changes, 0);
    assert.equal(jsonObject(jsonObject(result).readMeta).rowsWritten, 0);
    assert.ok(jsonNumber(jsonObject(jsonObject(result).readMeta).rowsRead) >= 1);
  }
});
void test('D1 syntax and constraint failures allow subsequent successful writes', async () => {
  assert.deepEqual(await request('/__fixture/database-failure'), {
    syntaxRejected: true,
    constraintRejected: true,
    recovered: 7,
  });
});

registerSocketFailureTests(request);

void test('structured TCP address reaches the same server and observes peer EOF', async () => {
  const text = await request('/tcp');
  const structured = await request('/tcp-structured');
  assert.equal(jsonObject(structured).message, jsonObject(text).message);
  assert.equal(Number.isInteger(jsonObject(structured).port), true);
  assert.ok(
    jsonNumber(jsonObject(structured).port) >= 1 &&
      jsonNumber(jsonObject(structured).port) <= 65535,
  );
  assert.equal(jsonObject(structured).state, 'SocketClosed');
});

registerArchiveTests(() => runtime);

void test(
  'concurrent stream and service requests preserve independent I/O',
  { timeout: 20000 },
  async () => {
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        if (index % 2 === 0) {
          assert.deepEqual(await request('/stream'), { message: 'streamed' });
        } else {
          assert.deepEqual(await request('/service'), {
            status: 200,
            health: { status: 'ok' },
            echo: 'typed body',
            conflict: 409,
          });
        }
      }),
    );
  },
);

registerR2ExampleExtraTests(() => runtime);
registerMiscExampleExtraCases(() => runtime);
