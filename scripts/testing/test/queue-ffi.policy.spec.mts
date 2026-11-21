import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { repositoryRoot, textFile } from '../Support/cli.mts';
import { object } from '../Support/validation.mts';

const source = textFile(
  join(repositoryRoot, 'cloudflare-workers/src/Cloudflare/Workers/Internal/FFI/Queue.hs'),
);
const imports = new Map(
  [
    ...source.matchAll(
      /foreign import javascript (?:safe|unsafe)\s+(?:"""([\s\S]*?)"""|"([^"\n]*)")\s+(\w+)\s*::/g,
    ),
  ].map(([, multiline, single, name]) => [name, multiline ?? single]),
);

function invoke(name: string, ...args: unknown[]): unknown {
  const snippet = imports.get(name);
  assert.notEqual(snippet, undefined, 'Missing Queue foreign import: ' + name);
  return new Function('$1', '$2', '$3', `return (${snippet});`)(...args);
}

for (const [name, method] of [
  ['jsQueueSendEnveloped', 'send'],
  ['jsQueueSendBatchEnveloped', 'sendBatch'],
]) {
  void test(`Queue ${method} handles void and preserves a rejected request`, async () => {
    const queue = { [method]: async (): Promise<void> => {} };
    const rejecting = {
      [method]: async (): Promise<never> => {
        await Promise.resolve();
        throw new Error('queue rejected');
      },
    };

    const sent = object(await Promise.resolve(invoke(name, queue, [], {})));
    const failed = object(await Promise.resolve(invoke(name, rejecting, [], {})));

    assert.equal(sent.ok, true);
    assert.equal(invoke('jsResponseIsVoid', sent.value), true);
    assert.equal(failed.ok, false);
    assert.equal(failed.value, null);
    assert.match(String(failed.message), /queue rejected/);
  });
}

for (const mode of [0, 1, 2]) {
  void test(`Queue metrics mode ${mode} snapshots valid metrics and recovers after invalid input`, () => {
    const good = { backlogCount: 12, backlogBytes: 200, oldestMessageTimestamp: new Date(1000) };
    const inputs: unknown[] = [
      null,
      {},
      { ...good, backlogCount: -1 },
      { ...good, backlogCount: NaN },
      { ...good, backlogCount: 2 ** 54 },
      { ...good, oldestMessageTimestamp: new Date(NaN) },
      {
        get backlogCount(): never {
          throw new Error('getter failure');
        },
      },
    ];
    const normalize = (data: unknown): Record<string, unknown> =>
      object(
        invoke(
          'jsNormalizeMetricsEnveloped',
          mode === 2 ? data : { metadata: { metrics: data } },
          mode,
        ),
      );

    for (const bad of inputs) {
      assert.equal(normalize(bad).ok, false);
      const snapshot = normalize(good);
      assert.equal(snapshot.ok, true);
      assert.deepEqual(snapshot.value, {
        backlogCount: 12,
        backlogBytes: 200,
        timestampMillis: 1000,
      });
      assert.notEqual(snapshot.value, good);
    }
  });
}

void test('Queue metrics getters read the normalized snapshot without rereading the provider', () => {
  let reads = 0;
  const input = {
    get backlogCount(): number {
      reads++;
      return 9;
    },
    backlogBytes: 2,
  };

  const snapshot = object(invoke('jsNormalizeMetricsEnveloped', input, 2));

  assert.equal(snapshot.ok, true);
  assert.equal(invoke('jsMetricsBacklogCount', snapshot.value), 9);
  assert.equal(invoke('jsMetricsBacklogCount', snapshot.value), 9);
  assert.equal(reads, 1);
});

void test('Queue metrics distinguish unavailable capability, valid response, and rejection', async () => {
  const metrics = { backlogCount: 12, backlogBytes: 200 };
  const failedMetrics = (): Promise<never> =>
    Promise.reject(new Error('metrics unavailable temporarily'));

  const absent = object(await Promise.resolve(invoke('jsQueueMetricsEnveloped', {})));
  const supported = object(
    await Promise.resolve(
      invoke('jsQueueMetricsEnveloped', { metrics: () => Promise.resolve(metrics) }),
    ),
  );
  const failed = object(
    await Promise.resolve(invoke('jsQueueMetricsEnveloped', { metrics: failedMetrics })),
  );

  assert.equal(absent.ok, false);
  assert.match(String(absent.message), /Queue metrics are unavailable in this runtime/);
  assert.equal(supported.ok, true);
  assert.equal(supported.value, metrics);
  assert.equal(failed.ok, false);
  assert.match(String(failed.message), /metrics unavailable temporarily/);
});

void test('Queue metrics distinguish an absent optional extension from invalid metadata', () => {
  for (const input of [{}, { metadata: undefined }, { metadata: {} }]) {
    const result = object(invoke('jsNormalizeMetricsEnveloped', input, 1));
    assert.equal(result.ok, true);
    assert.equal(result.value, undefined);
  }

  assert.equal(object(invoke('jsNormalizeMetricsEnveloped', undefined, 0)).value, undefined);
  assert.equal(object(invoke('jsNormalizeMetricsEnveloped', undefined, 2)).ok, false);
  for (const mode of [0, 1]) {
    for (const metadata of [null, 42, 'broken', true, { metrics: null }]) {
      assert.equal(object(invoke('jsNormalizeMetricsEnveloped', { metadata }, mode)).ok, false);
    }
  }
});
