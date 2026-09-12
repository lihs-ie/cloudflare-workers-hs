import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function registerQueueContractCases(getRuntime) {
  test("synthetic Queue metrics render supported, unsupported and failure independently", async () => {
    for (const mode of ["supported", "unsupported", "failed", "supported"]) {
      const response = await fetch(`${getRuntime().base}/__fixture/queue-example-metrics/${mode}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), {
        status: mode,
        metrics: mode === "supported" ? { backlogCount: 7, backlogBytes: 8192, oldestMessageTimestamp: 1234 } : null,
      });
    }
  });
  test("Queue example rejects invalid identifiers, payloads and transports before delivery", async () => {
    const invalidJobs = [
      { identifier: "", payload: "work" },
      { identifier: "a".repeat(81), payload: "work" },
      { identifier: "bad.space", payload: "work" },
      { identifier: "bad/route", payload: "work" },
      { identifier: "日本語", payload: "work" },
      { identifier: `empty-${randomUUID()}`, payload: "" },
    ];
    for (const job of invalidJobs) {
      const response = await fetch(`${getRuntime().base}/queue-examples/text`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job),
      });
      assert.equal(response.status, 400, await response.text());
    }
    const identifier = `unknown-${randomUUID()}`;
    const rejected = await fetch(`${getRuntime().base}/queue-examples/unknown`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier, payload: "never delivered" }),
    });
    assert.equal(rejected.status, 400, await rejected.text());
    const absent = await fetch(`${getRuntime().base}/jobs/${identifier}`);
    assert.equal(absent.status, 404, await absent.text());
  });
  test("advisory names enforce empty and length boundaries", async () => {
    for (const name of ["", "a".repeat(81)]) {
      const response = await fetch(`${getRuntime().base}/queue-examples/advisory/check`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(name),
      });
      assert.equal(response.status, 400, await response.text());
    }
    const name = randomUUID().padEnd(80, "x");
    for (const firstSeen of [true, false]) {
      const response = await fetch(`${getRuntime().base}/queue-examples/advisory/check`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(name),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { firstSeen, exactlyOnce: false, expires: false });
    }
  });
  test("native Queue metrics diagnostic distinguishes unsupported from real values", async () => {
    const response = await fetch(
      `${getRuntime().base}/queue-examples/diagnostics/metrics`,
    );
    assert.equal(response.status, 200);
    const diagnostic = await response.json();
    assert.ok(
      ["supported", "unsupported"].includes(diagnostic.status),
      JSON.stringify(diagnostic),
    );
    if (diagnostic.status === "unsupported") {
      assert.equal(diagnostic.metrics, null);
    } else {
      assert.ok(Number.isSafeInteger(diagnostic.metrics.backlogCount));
      assert.ok(diagnostic.metrics.backlogCount >= 0);
      assert.ok(Number.isSafeInteger(diagnostic.metrics.backlogBytes));
      assert.ok(diagnostic.metrics.backlogBytes >= 0);
    }
  });
  test("KV advisory marker remembers a sequential check without claiming exactly-once", async () => {
    const identifier = `advisory-${randomUUID()}`;
    for (const firstSeen of [true, false]) {
      const response = await fetch(
        `${getRuntime().base}/queue-examples/advisory/check`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(identifier),
        },
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), {
        firstSeen,
        exactlyOnce: false,
        expires: false,
      });
    }
  });
  async function contract(mode, variant) {
    const response = await fetch(
      `${getRuntime().base}/__fixture/queue-contract/${mode}~${variant}`,
      { signal: AbortSignal.timeout(10000) },
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  const metrics = {
    backlogCount: 7,
    backlogBytes: 8192,
    oldestMessageTimestamp: 1234,
  };
  test("synthetic WASM Queue producer contract retains metrics, permits void and rejects failures", async () => {
    for (const [mode, source, call] of [
      ["send", "QueueSendMetricsSource", "send"],
      ["send-batch", "QueueSendBatchMetricsSource", "sendBatch"],
    ]) {
      for (const variant of [
        "valid",
        "absent",
        "invalid",
        "getter",
        "date",
        "reject",
      ]) {
        const observed = await contract(mode, variant);
        assert.deepEqual(observed.calls, [call]);
        if (["invalid", "getter", "date", "reject"].includes(variant)) {
          assert.equal(observed.result.ok, false);
          assert.equal(
            (await contract(mode, "valid")).result.ok,
            true,
            "same WASM reactor must recover after rejected metrics",
          );
        } else {
          assert.deepEqual(observed.result, {
            ok: true,
            value: { source, metrics: variant === "absent" ? null : metrics },
          });
        }
      }
    }
    assert.deepEqual((await contract("metrics", "valid")).result, {
      ok: true,
      value: metrics,
    });
    assert.equal((await contract("metrics", "invalid")).result.ok, false);
    assert.equal((await contract("metrics", "reject")).result.ok, false);
    assert.deepEqual((await contract("metrics", "valid")).result, {
      ok: true,
      value: metrics,
    });
  });
  test("synthetic Queue observer reads metadata without settling the batch", async () => {
    const observed = await contract("observe", "valid");
    assert.deepEqual(observed.result, { ok: true, value: { metrics } });
    assert.deepEqual(observed.calls, []);
  });
  test("synthetic WASM Queue batch retains optional metrics and invokes batch settlement", async () => {
    for (const variant of ["valid", "absent", "invalid", "getter", "date"]) {
      for (const [mode, call] of [
        ["ack-all", "ackAll"],
        ["retry-all", "retryAll:1"],
      ]) {
        const observed = await contract(mode, variant);
        if (["invalid", "getter", "date"].includes(variant)) {
          assert.equal(observed.result.ok, false);
          assert.equal(
            (await contract(mode, "valid")).result.ok,
            true,
            "same WASM reactor must recover after rejected metrics",
          );
          assert.deepEqual(observed.calls, []);
        } else {
          assert.deepEqual(observed.result, {
            ok: true,
            value: { metrics: variant === "absent" ? null : metrics },
          });
          assert.deepEqual(observed.calls, [call]);
        }
      }
    }
  });
  test("synthetic WASM default JSON entry acknowledges valid and retries poison individually", async () => {
    for (const mode of ["default-json", "default-helper"]) {
      const observed = await contract(mode, "absent");
      assert.deepEqual(observed.result, { ok: true, value: { processed: 1 } });
      assert.deepEqual(observed.calls, ["ack:0", "retry:1:default"]);
    }
  });
}
