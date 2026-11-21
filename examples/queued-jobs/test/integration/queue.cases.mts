import { jsonArray, jsonObject, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import type { startRuntime } from '../Support/dev-runtime.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function registerQueueCases(
  getRuntime: () => Awaited<ReturnType<typeof startRuntime>>,
): void {
  void test(
    'native mixed Queue delivery acknowledges valid jobs and sends poison to DLQ after retries',
    { timeout: 60000 },
    async () => {
      const { base } = getRuntime();
      const run = randomUUID();
      const prefix = `queue-contract-${run}`;
      const poison = `${prefix}-poison`;
      const good = [`${prefix}-good-a`, `${prefix}-good-b`];
      const submitted = await fetch(`${base}/__fixture/jobs/queue/mixed?run=${run}`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(submitted.status, 202, await submitted.text());
      const deadline = Date.now() + 45000;
      let rows: unknown[] = [];
      while (Date.now() < deadline) {
        const response = await fetch(`${base}/__fixture/jobs/queue/deliveries?run=${run}`, {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200, await response.clone().text());
        rows = jsonArray(await response.json());

        if (
          rows.some(
            (row) =>
              jsonObject(row).queue === 'library-jobs-dlq' && jsonObject(row).identifier === poison,
          )
        ) {
          break;
        }

        await delay(200);
      }
      const normal = rows.filter((row) => jsonObject(row).queue === 'library-jobs');
      const dead = rows.filter((row) => jsonObject(row).queue === 'library-jobs-dlq');
      assert.deepEqual(
        dead.map((row) => jsonObject(row).identifier),
        [poison],
        JSON.stringify(rows),
      );
      assert.deepEqual(
        normal
          .filter((row) => jsonObject(row).identifier === poison)
          .map((row) => jsonObject(row).attempts),
        [1, 2, 3, 4],
      );
      assert.ok(
        normal.some((row) => {
          const batch = jsonValue(jsonObject(row).batch);
          return (
            jsonArray(batch).includes(poison) &&
            good.every((identifier) => jsonArray(batch).includes(identifier))
          );
        }),
        'a real native batch must contain both valid and poison messages',
      );
      for (const identifier of good) {
        assert.deepEqual(
          normal
            .filter((row) => jsonObject(row).identifier === identifier)
            .map((row) => jsonObject(row).attempts),
          [1],
          'acknowledged valid messages must not retry alongside poison',
        );
        const response = await fetch(`${base}/jobs/${identifier}`, {
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200, await response.clone().text());
        const saved = await response.json();
        assert.equal(jsonObject(saved).identifier, identifier);
        assert.equal(jsonObject(saved).updates, 1);
      }
      const missing = await fetch(`${base}/jobs/${poison}`, {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(missing.status, 404, 'poison body must never commit a job');
    },
  );
}
