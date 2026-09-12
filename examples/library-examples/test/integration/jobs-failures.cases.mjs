import { test } from "node:test";
import assert from "node:assert/strict";

/** Boundary-contract assertions; native DO persistence is covered in jobs.spec.mjs. */
export function registerJobsFailureCases(getRuntime) {
  const failures = [
    ["process-input", "JobInput"],
    ["process-conflict", "JobConflict"],
    ["process-rpc", "DurableObjectRPCFailed"],
    ["read-json", "JobInput"],
    ["read-null", "JobMissing"],
    ["read-rpc", "DurableObjectRPCFailed"],
    ["update-json", "JobConflict"],
    ["update-rpc", "DurableObjectRPCFailed"],
    ["history-json", "JobConflict"],
    ["history-rpc", "DurableObjectRPCFailed"],
    ["commit-input", "JobInput"],
    ["commit-sql", "OtherException"],
    ["state-shape", "JobConflict"],
    ["save-input", "JobInput"],
    ["save-current-json", "JobConflict"],
    ["save-current-schema", "JobConflict"],
    ["save-transaction", "DurableObjectStorageFailed"],
    ["save-prune", "DurableObjectStorageFailed"],
    ["history-record", "JobConflict"],
    ["commit-conflict", undefined],
  ];
  for (const [scenario, expectedError] of failures) {
    test(`Jobs boundary ${scenario} classifies failure and recovers`, async () => {
      const response = await fetch(`${getRuntime().base}/__fixture/jobs/failure/${scenario}`, {
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.deepEqual(result.rejected, expectedError
        ? { ok: false, error: expectedError }
        : { ok: true, value: "conflict" });
      assert.equal(result.recovered.ok, true, JSON.stringify(result));
      if (scenario.startsWith("process-")) {
        assert.deepEqual(result.recovered.value, null);
        assert.equal(result.rejectedCalls, scenario === "process-input" ? 0 : 1);
        assert.deepEqual(result.calls.at(-1), {
          method: "commit", args: ['{"identifier":"boundary-job","payload":"work"}'],
        });
      } else if (scenario.startsWith("read-")) {
        assert.deepEqual(result.recovered.value, { identifier: "boundary-job", payload: "work", updates: 1 });
        assert.deepEqual(result.calls.at(-1), { method: "status", args: ["boundary-job"] });
      } else if (scenario.startsWith("update-")) {
        assert.deepEqual(result.recovered.value, { revision: 1, settings: {} });
        assert.deepEqual(result.calls.at(-1), { method: "saveSettings", args: ["{}"] });
      } else if (scenario === "history-rpc" || scenario === "history-json") {
        assert.deepEqual(result.recovered.value, []);
        assert.deepEqual(result.calls.at(-1), { method: "history", args: [] });
      } else if (scenario.startsWith("commit-")) {
        assert.deepEqual(result.recovered.value, "committed");
        assert.equal(result.rejectedCalls, scenario === "commit-input" ? 0 : scenario === "commit-sql" ? 1 : 3);
      } else if (scenario === "state-shape") {
        assert.deepEqual(JSON.parse(result.recovered.value), { identifier: "boundary-job", payload: "work", updates: 1 });
      } else if (scenario === "history-record") {
        assert.deepEqual(JSON.parse(result.recovered.value), []);
      } else {
        const saved = JSON.parse(result.recovered.value);
        assert.deepEqual(saved, { revision: scenario === "save-prune" ? 5 : 1, settings: {} });
        assert.equal(result.history.ok, true);
        const history = JSON.parse(result.history.value);
        assert.deepEqual(history.map(({ revision }) => revision), scenario === "save-prune" ? [5, 4, 3] : [1]);
        if (scenario === "save-transaction") {
          assert.deepEqual(result.afterRejected, { keys: [], transactions: 1, deletions: 0 });
        } else if (scenario === "save-prune") {
          assert.equal(result.afterRejected.keys.length, 5, "commit remains durable after prune failure");
          assert.equal(result.afterRejected.deletions, 1);
          assert.equal(result.deletions, 3, "next update retries pruning both obsolete revisions");
        } else {
          assert.equal(result.afterRejected.transactions, 0, "invalid input/current revision never writes");
        }
      }
    });
  }
}
