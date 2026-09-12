import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function registerQueueProducerCases(getRuntime) {
  for (const transport of [
    "bytes-single",
    "bytes-batch",
    "text",
    "bytes",
    "v8",
    "message-delay",
    "batch-delay",
  ]) {
    test(
      `Haskell Queue ${transport} delivers encoded JSON to the typed consumer`,
      { timeout: 30000 },
      async () => {
        const { base } = getRuntime();
        const job = {
          identifier: `transport-${randomUUID()}`,
          payload: "JSON preserved across transport: 日本語",
        };
        const read = () =>
          fetch(`${base}/jobs/${job.identifier}`, {
            signal: AbortSignal.timeout(10000),
          });
        assert.equal(
          (await read()).status,
          404,
          "the job must be absent before submission",
        );
        const response = await fetch(`${base}/queue-examples/${transport}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(job),
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(await response.json(), {
          accepted: job.identifier,
          transport,
        });
        if (transport.endsWith("delay")) {
          assert.equal(
            (await read()).status,
            404,
            "explicit delay must leave the accepted job pending",
          );
        }
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const saved = await read();
          if (saved.ok) {
            assert.deepEqual(await saved.json(), { ...job, updates: 1 });
            return;
          }
          assert.equal(saved.status, 404, await saved.text());
          await delay(100);
        }
        assert.fail(`${transport} never reached the typed consumer`);
      },
    );
  }
}
