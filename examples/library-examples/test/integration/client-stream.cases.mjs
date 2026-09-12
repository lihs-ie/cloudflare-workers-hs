import { test } from "node:test";
import assert from "node:assert/strict";

export function registerClientStreamTests(getRuntime) {
  test("HTTP streaming callback early return closes the actual upstream response", async () => {
    const fixture = getRuntime().clientHttpFixture;
    const before = fixture.closedStreamResponses();
    const response = await fetch(`${getRuntime().base}/__fixture/client-http-stream`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { bytes: [0, 128, 255] });
    const deadline = Date.now() + 5000;
    while (fixture.closedStreamResponses() === before && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(fixture.closedStreamResponses() - before, 1);
  });
  test("HTTP first-chunk consumer handles an empty response", async () => {
    const runtime = getRuntime();
    runtime.clientHttpFixture.nextStreamResponse("empty");
    const response = await fetch(`${runtime.base}/__fixture/client-http-stream`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { bytes: [] });
  });
  test("HTTP first-chunk read failure rejects and the next call recovers", async () => {
    const runtime = getRuntime();
    runtime.clientHttpFixture.nextStreamResponse("read-failure");
    const failed = await fetch(`${runtime.base}/__fixture/client-http-stream`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(failed.status, 500);
    await failed.text();
    const recovered = await fetch(`${runtime.base}/__fixture/client-http-stream`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.deepEqual(await recovered.json(), { bytes: [0, 128, 255] });
  });
  for (const [mode, cancelled, error] of [
    ["eof", 0, null],
    ["early", 1, null],
    ["early-empty", 0, null],
    ["early-read-failure", 0, /original producer failure/],
    ["consumer-before", 1, /consumer failed before reading/],
    ["consumer-after", 1, /consumer failed after reading/],
    ["read-failure", 0, /original producer failure/],
    ["cancel-failure", 1, /consumer failed after reading/],
    ["http-error", 0, /FailureResponse/],
  ]) {
    test(`Client streaming callback releases native reader (${mode})`, async () => {
      const response = await fetch(`${getRuntime().base}/__fixture/client-stream?mode=${mode}`, {
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      if (error) {
        assert.match(result.error, error);
      } else {
        assert.deepEqual(result.bytes, mode === "early-empty" ? [] : [0, 128, 255]);
      }
      assert.equal(result.locked, false, "callback exit must release the reader lock");
      assert.equal(result.cancelled, cancelled, "unfinished producers must be cancelled once");
    });
  }
}
