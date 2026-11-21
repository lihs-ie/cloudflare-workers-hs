import { SELF } from 'cloudflare:test';
import { jsonObject, jsonSequence } from '../../../../scripts/testing/Support/json.mts';
import { test } from 'vitest';
import assert from 'node:assert/strict';

export function registerCachePurgeTests(): void {
  const execute = async (scenario: string, operation: string = 'tags'): Promise<unknown> => {
    const response = await SELF.fetch(
      `https://fixture.invalid/__fixture/cache-purge?scenario=${scenario}&operation=${operation}`,
      {
        signal: AbortSignal.timeout(10000),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const [operation, expected] of [
    ['tags', { tags: ['guide', 'catalog'] }],
    ['prefixes', { pathPrefixes: ['/guide/', '/catalog/'] }],
    ['everything', { purgeEverything: true }],
  ] as const) {
    test(`custom CachePurge capability receives ${operation} options through WASM`, async () => {
      assert.deepEqual(await execute('success', operation), {
        outcome: { outcome: 'resolved', success: true, errors: [] },
        calls: [expected],
      });
    });
  }
  for (const scenario of ['missing', 'throw', 'malformed-success', 'null']) {
    test(`custom CachePurge ${scenario} fails explicitly through WASM`, async () => {
      const result = await execute(scenario);
      assert.deepEqual(jsonObject(result).outcome, { outcome: 'capability-failed' });
      assert.equal(jsonSequence(jsonObject(result).calls).length, scenario === 'missing' ? 0 : 1);
    });
  }
  test('custom CachePurge preserves false and structured errors without throwing', async () => {
    const result = await execute('rejected');
    assert.deepEqual(jsonObject(result).outcome, {
      outcome: 'resolved',
      success: false,
      errors: [{ code: 1001, message: 'fixture policy refusal' }],
    });
  });
  test('unknown purge operation does not call the capability', async () => {
    assert.deepEqual(await execute('success', 'invalid'), {
      outcome: { outcome: 'invalid-operation' },
      calls: [],
    });
  });
}
