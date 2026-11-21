import {
  jsonArray,
  jsonObject,
  jsonSequence,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import type { startRuntime } from '../Support/dev-runtime.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Boundary-contract assertions; native DO persistence is covered in jobs.spec.mts. */
export function registerJobsFailureCases(
  getRuntime: () => Awaited<ReturnType<typeof startRuntime>>,
): void {
  const failures = [
    ['process-input', 'JobInput'],
    ['process-conflict', 'JobConflict'],
    ['process-rpc', 'DurableObjectRPCFailed'],
    ['read-json', 'JobInput'],
    ['read-null', 'JobMissing'],
    ['read-rpc', 'DurableObjectRPCFailed'],
    ['update-json', 'JobConflict'],
    ['update-rpc', 'DurableObjectRPCFailed'],
    ['history-json', 'JobConflict'],
    ['history-rpc', 'DurableObjectRPCFailed'],
    ['commit-input', 'JobInput'],
    ['commit-sql', 'OtherException'],
    ['state-shape', 'JobConflict'],
    ['save-input', 'JobInput'],
    ['save-current-json', 'JobConflict'],
    ['save-current-schema', 'JobConflict'],
    ['save-transaction', 'DurableObjectStorageFailed'],
    ['save-prune', 'DurableObjectStorageFailed'],
    ['history-record', 'JobConflict'],
    ['commit-conflict', undefined],
  ] as const;
  for (const [scenario, expectedError] of failures) {
    void test(`Jobs boundary ${scenario} classifies failure and recovers`, async () => {
      const response = await fetch(`${getRuntime().base}/__fixture/jobs/failure/${scenario}`, {
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.deepEqual(
        jsonObject(result).rejected,
        expectedError ? { ok: false, error: expectedError } : { ok: true, value: 'conflict' },
      );
      assert.equal(jsonObject(jsonObject(result).recovered).ok, true, JSON.stringify(result));

      if (scenario.startsWith('process-')) {
        assert.deepEqual(jsonObject(jsonObject(result).recovered).value, null);
        assert.equal(jsonObject(result).rejectedCalls, scenario === 'process-input' ? 0 : 1);
        assert.deepEqual(jsonArray(jsonObject(result).calls).at(-1), {
          method: 'commit',
          args: ['{"identifier":"boundary-job","payload":"work"}'],
        });
      } else if (scenario.startsWith('read-')) {
        assert.deepEqual(jsonObject(jsonObject(result).recovered).value, {
          identifier: 'boundary-job',
          payload: 'work',
          updates: 1,
        });
        assert.deepEqual(jsonArray(jsonObject(result).calls).at(-1), {
          method: 'status',
          args: ['boundary-job'],
        });
      } else if (scenario.startsWith('update-')) {
        assert.deepEqual(jsonObject(jsonObject(result).recovered).value, {
          revision: 1,
          settings: {},
        });
        assert.deepEqual(jsonArray(jsonObject(result).calls).at(-1), {
          method: 'saveSettings',
          args: ['{}'],
        });
      } else if (scenario === 'history-rpc' || scenario === 'history-json') {
        assert.deepEqual(jsonObject(jsonObject(result).recovered).value, []);
        assert.deepEqual(jsonArray(jsonObject(result).calls).at(-1), {
          method: 'history',
          args: [],
        });
      } else if (scenario.startsWith('commit-')) {
        assert.deepEqual(jsonObject(jsonObject(result).recovered).value, 'committed');
        assert.equal(
          jsonObject(result).rejectedCalls,
          (() => {
            if (scenario === 'commit-input') {
              return 0;
            }

            if (scenario === 'commit-sql') {
              return 1;
            }

            return 3;
          })(),
        );
      } else if (scenario === 'state-shape') {
        assert.deepEqual(jsonValue(jsonObject(jsonObject(result).recovered).value), {
          identifier: 'boundary-job',
          payload: 'work',
          updates: 1,
        });
      } else if (scenario === 'history-record') {
        assert.deepEqual(jsonValue(jsonObject(jsonObject(result).recovered).value), []);
      } else {
        const saved = jsonValue(jsonObject(jsonObject(result).recovered).value);
        assert.deepEqual(saved, { revision: scenario === 'save-prune' ? 5 : 1, settings: {} });
        assert.equal(jsonObject(jsonObject(result).history).ok, true);
        const history = jsonValue(jsonObject(jsonObject(result).history).value);
        assert.deepEqual(
          jsonArray(history).map((item) => {
            const { revision } = jsonObject(item);
            return revision;
          }),
          scenario === 'save-prune' ? [5, 4, 3] : [1],
        );

        if (scenario === 'save-transaction') {
          assert.deepEqual(jsonObject(result).afterRejected, {
            keys: [],
            transactions: 1,
            deletions: 0,
          });
        } else if (scenario === 'save-prune') {
          assert.equal(
            jsonSequence(jsonObject(jsonObject(result).afterRejected).keys).length,
            5,
            'commit remains durable after prune failure',
          );
          assert.equal(jsonObject(jsonObject(result).afterRejected).deletions, 1);
          assert.equal(
            jsonObject(result).deletions,
            3,
            'next update retries pruning both obsolete revisions',
          );
        } else {
          assert.equal(
            jsonObject(jsonObject(result).afterRejected).transactions,
            0,
            'invalid input/current revision never writes',
          );
        }
      }
    });
  }
}
