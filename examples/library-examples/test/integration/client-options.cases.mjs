import { test } from "node:test";
import assert from "node:assert/strict";

export function registerClientOptionsTests(getRuntime) {
  async function invoke(query) {
    const response = await fetch(`${getRuntime().base}/client-options?${query}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  test("public policy validation provides specific caller diagnostics", async () => {
    const response = await fetch(`${getRuntime().base}/__fixture/client-option-diagnostics`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
      "timeoutMillis must be between 1 and 30000",
      "retries must be between 0 and 3",
      "retryDelayMillis must be between 0 and 1000",
    ]);
  });
  test("exported default client policy performs a successful request", async () => {
    const response = await fetch(`${getRuntime().base}/__fixture/client-default-options`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      timeoutMillis: 10000, maxRetryAttempts: 2, retryBaseDelayMillis: 250,
      timeoutScope: "per-attempt", outcome: { result: { status: 200 } },
    });
  });
  test("NamedRoutes destination serves all typed client endpoints", async () => {
    for (const [path, method] of [["retry", "PUT"], ["no-retry", "POST"]]) {
      for (const key of [null, "direct-client-key"]) {
        const headers = { "content-type": "application/json" };
        if (key !== null) {
          headers["Idempotency-Key"] = key;
        }
        const response = await fetch(`${getRuntime().base}/client-target/${path}`, {
          method, headers, body: JSON.stringify("typed destination 日本語"),
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(await response.json(), { key, payload: "typed destination 日本語" });
      }
    }
    for (const [path, expected] of [["malformed", { valid: true }], ["exhausted", { connected: true }]]) {
      const response = await fetch(`${getRuntime().base}/client-target/${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    }
  });
  test("HTTP client accepts maximum application policy values and implicit defaults", async () => {
    for (const [query, timeout, retries, delay] of [
      ["", 10000, 2, 250],
      ["timeout=30000&retries=3&delay=1000", 30000, 3, 1000],
    ]) {
      const result = await invoke(query);
      assert.equal(result.timeoutMillis, timeout);
      assert.equal(result.maxRetryAttempts, retries);
      assert.equal(result.retryBaseDelayMillis, delay);
      assert.deepEqual(result.outcome, { result: { status: 200 } });
    }
  });
  test("one millisecond timeout is accepted and reports a transport timeout", async () => {
    const result = await invoke("mode=slow&timeout=1&retries=0&delay=0");
    assert.equal(result.timeoutMillis, 1);
    assert.deepEqual(result.outcome, { error: "ConnectionError", transport: "FetchTimedOut" });
  });
  test("malformed stream echo fails decoding and the next request recovers", async () => {
    const fixture = getRuntime().clientHttpFixture;
    const before = fixture.stats()["/stream-echo"] ?? 0;
    fixture.malformNextStreamResponse();
    const failed = await fetch(`${getRuntime().base}/client-stream`);
    assert.equal(failed.status, 500, await failed.text());
    assert.equal(fixture.stats()["/stream-echo"] - before, 1);
    const recovered = await fetch(`${getRuntime().base}/client-stream`);
    assert.equal(recovered.status, 200);
    assert.deepEqual((await recovered.json()).bytes, [0, 1, 127, 128, 255, 10, 42]);
    assert.equal(fixture.stats()["/stream-echo"] - before, 2);
  });
  test("HTTP streamed POST preserves binary chunks and headers in one dispatch", async () => {
    const before = getRuntime().clientHttpFixture.stats()["/stream-echo"] ?? 0;
    const response = await fetch(`${getRuntime().base}/client-stream`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      method: "POST",
      bytes: [0, 1, 127, 128, 255, 10, 42],
      contentType: "application/octet-stream",
      trace: "stream-regression",
      attempts: before + 1,
    });
    assert.equal(getRuntime().clientHttpFixture.stats()["/stream-echo"] - before, 1);
  });
  test("HTTP client applies explicit timeout and retry settings", async () => {
    const result = await invoke("mode=success&timeout=1000&retries=0&delay=0");
    assert.equal(result.timeoutMillis, 1000);
    assert.equal(result.maxRetryAttempts, 0);
    assert.equal(result.retryBaseDelayMillis, 0);
    assert.equal(result.timeoutScope, "per-attempt");
    assert.deepEqual(result.outcome, { result: { status: 200 } });
  });
  test("HTTP client aborts a slow destination at the configured timeout", async () => {
    const before = getRuntime().clientHttpFixture.stats()["/slow"] ?? 0;
    const result = await invoke("mode=slow&timeout=20&retries=0&delay=0");
    assert.deepEqual(result.outcome, { error: "ConnectionError", transport: "FetchTimedOut" });
    assert.equal(getRuntime().clientHttpFixture.stats()["/slow"] - before, 1);
  });
  test("HTTP GET retries two interrupted connections then succeeds", async () => {
    const result = await invoke("mode=retry&timeout=1000&retries=2&delay=0");
    assert.deepEqual(result.outcome, { result: { status: 200 } });
    assert.equal(getRuntime().clientHttpFixture.stats()["/disconnect"], 3);
  });
  test("HTTP buffered GET retries interrupted response bodies and then recovers", async () => {
    const fixture = getRuntime().clientHttpFixture;
    const before = fixture.stats()["/"] ?? 0;
    fixture.interruptResponseBodies(2);
    const result = await invoke("mode=success&timeout=1000&retries=2&delay=0");
    assert.deepEqual(result.outcome, { result: { status: 200 } });
    assert.equal(fixture.stats()["/"] - before, 3);
  });
  test("HTTP interrupted body retries stop at the limit and the next request succeeds", async () => {
    const fixture = getRuntime().clientHttpFixture;
    const before = fixture.stats()["/"] ?? 0;
    fixture.interruptResponseBodies(3);
    const result = await invoke("mode=success&timeout=1000&retries=2&delay=0");
    assert.deepEqual(result.outcome, { error: "ConnectionError", transport: "FetchNetworkFailure" });
    assert.equal(fixture.stats()["/"] - before, 3);
    const recovered = await invoke("mode=success&timeout=1000&retries=0&delay=0");
    assert.deepEqual(recovered.outcome, { result: { status: 200 } });
    assert.equal(fixture.stats()["/"] - before, 4);
  });
  test("public policy validation provides specific caller diagnostics", async () => {
    const response = await fetch(`${getRuntime().base}/__fixture/client-option-diagnostics`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
      "timeoutMillis must be between 1 and 30000",
      "retries must be between 0 and 3",
      "retryDelayMillis must be between 0 and 1000",
    ]);
  });
  test("exported default client policy performs a successful request", async () => {
    const response = await fetch(`${getRuntime().base}/__fixture/client-default-options`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      timeoutMillis: 10000, maxRetryAttempts: 2, retryBaseDelayMillis: 250,
      timeoutScope: "per-attempt", outcome: { result: { status: 200 } },
    });
  });
  test("NamedRoutes destination serves all typed client endpoints", async () => {
    for (const [path, method] of [["retry", "PUT"], ["no-retry", "POST"]]) {
      for (const key of [null, "direct-client-key"]) {
        const headers = { "content-type": "application/json" };
        if (key !== null) {
          headers["Idempotency-Key"] = key;
        }
        const response = await fetch(`${getRuntime().base}/client-target/${path}`, {
          method, headers, body: JSON.stringify("typed destination 日本語"),
        });
        assert.equal(response.status, 200, await response.clone().text());
        assert.deepEqual(await response.json(), { key, payload: "typed destination 日本語" });
      }
    }
    for (const [path, expected] of [["malformed", { valid: true }], ["exhausted", { connected: true }]]) {
      const response = await fetch(`${getRuntime().base}/client-target/${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), expected);
    }
  });
  test("HTTP client accepts maximum application policy values and implicit defaults", async () => {
    for (const [query, timeout, retries, delay] of [
      ["", 10000, 2, 250],
      ["timeout=30000&retries=3&delay=1000", 30000, 3, 1000],
    ]) {
      const result = await invoke(query);
      assert.equal(result.timeoutMillis, timeout);
      assert.equal(result.maxRetryAttempts, retries);
      assert.equal(result.retryBaseDelayMillis, delay);
      assert.deepEqual(result.outcome, { result: { status: 200 } });
    }
  });
  test("one millisecond timeout is accepted and reports a transport timeout", async () => {
    const result = await invoke("mode=slow&timeout=1&retries=0&delay=0");
    assert.equal(result.timeoutMillis, 1);
    assert.deepEqual(result.outcome, { error: "ConnectionError", transport: "FetchTimedOut" });
  });
  test("HTTP streamed POST is not replayed after connection loss and a new request succeeds", async () => {
    const fixture = getRuntime().clientHttpFixture;
    const before = fixture.stats()["/stream-echo"] ?? 0;
    fixture.disconnectNextStream();
    const failed = await fetch(`${getRuntime().base}/client-stream`);
    assert.equal(failed.status, 200, await failed.clone().text());
    assert.deepEqual(await failed.json(), { error: "ConnectionError", transport: "FetchNetworkFailure" });
    assert.equal(fixture.stats()["/stream-echo"] - before, 1);
    const recovered = await fetch(`${getRuntime().base}/client-stream`);
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.deepEqual(await recovered.json(), {
      method: "POST",
      bytes: [0, 1, 127, 128, 255, 10, 42],
      contentType: "application/octet-stream",
      trace: "stream-regression",
      attempts: before + 2,
    });
    assert.equal(fixture.stats()["/stream-echo"] - before, 2);
  });
  test("invalid HTTP client settings fail before destination dispatch", async () => {
    const before = getRuntime().clientHttpFixture.stats();
    for (const query of ["timeout=0", "timeout=30001", "retries=-1", "retries=4", "delay=-1", "delay=1001", "mode=untrusted"]) {
      const response = await fetch(`${getRuntime().base}/client-options?${query}`);
      assert.equal(response.status, 400, query);
      await response.arrayBuffer();
    }
    assert.deepEqual(getRuntime().clientHttpFixture.stats(), before);
  });
}
