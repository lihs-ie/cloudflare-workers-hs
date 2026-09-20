import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startDev } from "../../../examples/realtime/test/Support/dev.mjs";

let runtime;
before(async () => { runtime = await startDev(); }, { timeout: 65000 });
after(async () => { await runtime?.close(); });

test("public DO callback API: SQL/Alarm atomicity, exceptions and lifecycle", { timeout: 30000 }, async () => {
  const response = await fetch(`${runtime.base}/__sql`, { signal: AbortSignal.timeout(25000) });
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  assert.deepEqual(result.transactions, {
    commit: true, rollback: true, alarm: true, exceptions: true,
    leftCommits: true, caughtErrorCommits: true, concurrency: true,
    cancellation: true, repetition: true, directSQL: true,
    lifecycle: { nativeFailures: true, queuedCancellation: true, commitCancellation: true },
  });
  // Existing sqlExecute/sqlBatch retain their atomic output-limit behavior.
  assert.equal(result.rollback, true);
  assert.equal(result.rowLimit, true);
  assert.deepEqual(result.afterLimit, [[{ tag: "number", value: 0 }]]);
});
