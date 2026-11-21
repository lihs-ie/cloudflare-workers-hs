import { jsonObject } from '../../../../scripts/testing/Support/json.mts';
import { test } from 'vitest';
import { SELF } from 'cloudflare:test';
import assert from 'node:assert/strict';
test(
  'public DO callback API: SQL/Alarm atomicity, exceptions and lifecycle',
  { timeout: 30000 },
  async () => {
    const response = await SELF.fetch(`https://fixture.invalid/__sql`, {
      signal: AbortSignal.timeout(25000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.deepEqual(jsonObject(result).transactions, {
      commit: true,
      rollback: true,
      alarm: true,
      exceptions: true,
      leftCommits: true,
      caughtErrorCommits: true,
      concurrency: true,
      cancellation: true,
      repetition: true,
      directSQL: true,
      lifecycle: { nativeFailures: true, queuedCancellation: true, commitCancellation: true },
    });
    // Existing sqlExecute/sqlBatch retain their atomic output-limit behavior.
    assert.equal(jsonObject(result).rollback, true);
    assert.equal(jsonObject(result).rowLimit, true);
    assert.deepEqual(jsonObject(result).afterLimit, [[{ tag: 'number', value: 0 }]]);
  },
);
