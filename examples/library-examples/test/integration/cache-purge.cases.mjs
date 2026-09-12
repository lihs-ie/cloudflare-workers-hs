import { test } from "node:test";
import assert from "node:assert/strict";

export function registerCachePurgeTests(getRuntime) {
  const execute = async (scenario, operation = "tags") => {
    const response = await fetch(
      `${getRuntime().base}/__fixture/cache-purge?scenario=${scenario}&operation=${operation}`,
      {
        signal: AbortSignal.timeout(10000),
      },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const [operation, expected] of [
    ["tags", { tags: ["guide", "catalog"] }],
    ["prefixes", { pathPrefixes: ["/guide/", "/catalog/"] }],
    ["everything", { purgeEverything: true }],
  ]) {
    test(`custom CachePurge capability receives ${operation} options through WASM`, async () => {
      assert.deepEqual(await execute("success", operation), {
        outcome: { outcome: "resolved", success: true, errors: [] },
        calls: [expected],
      });
    });
  }
  for (const scenario of ["missing", "throw", "malformed-success", "null"]) {
    test(`custom CachePurge ${scenario} fails explicitly through WASM`, async () => {
      const result = await execute(scenario);
      assert.deepEqual(result.outcome, { outcome: "capability-failed" });
      assert.equal(result.calls.length, scenario === "missing" ? 0 : 1);
    });
  }
  test("custom CachePurge preserves false and structured errors without throwing", async () => {
    const result = await execute("rejected");
    assert.deepEqual(result.outcome, {
      outcome: "resolved",
      success: false,
      errors: [{ code: 1001, message: "fixture policy refusal" }],
    });
  });
  test("unknown purge operation does not call the capability", async () => {
    assert.deepEqual(await execute("success", "invalid"), {
      outcome: { outcome: "invalid-operation" },
      calls: [],
    });
  });
}
