import { test } from "node:test";
import assert from "node:assert/strict";

/** Application guards are exercised with controlled native binding responses. */
export function registerR2ExampleExtraTests(getRuntime) {
  const run = async (mode) => {
    const response = await fetch(`${getRuntime().base}/__fixture/r2-extra/${mode}`, {
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  test("unknown R2 scenario is sanitized and worker remains usable", async () => {
    const response = await fetch(`${getRuntime().base}/r2/unknown-wave6`, { method: "POST" });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "internal_error" });
    const healthy = await fetch(`${getRuntime().base}/health`);
    assert.equal(healthy.status, 200);
    await healthy.text();
  });
  test("public Request PUT without body reader rejects before storage", async () => {
    const response = await fetch(`${getRuntime().base}/__fixture/attachment-missing-reader`);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Attachment body is required");
  });
  for (const mode of ["store-rejected", "reader-missing", "checksum-rejected", "infrequent-rejected", "body-missing"]) {
    test(`R2 malformed binding outcome ${mode} does not become a successful response`, async () => {
      const result = await run(mode);
      assert.equal(result.status, 500);
      assert.deepEqual(JSON.parse(result.body), { error: "internal_error" });
      assert.deepEqual(result.calls, [["reader-missing", "body-missing"].includes(mode) ? "get" : "put"]);
    });
  }
  for (const [mode, expected] of [
    ["range-ignored", { invalidRangeRejected: false }],
    ["write-reversed", { accepted: false, staleRejected: false, unchanged: false }],
    ["conditional-ignored", { wrongMatchHasNoBody: false, unchangedHasNoBody: false, headerConditionHasNoBody: false, missing: false }],
    ["browse-ignored", { beforePastRejected: false, afterFutureRejected: false }],
  ]) {
    test(`R2 scenario reports unsupported native conditions honestly: ${mode}`, async () => {
      const result = await run(mode);
      assert.equal(result.status, 200);
      const body = JSON.parse(result.body);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(body[key], value, key);
      }
    });
  }
  for (const mode of ["unknown", "reader-missing", "stream-supported"]) {
    test(`R2 failure fixture handles ${mode} native outcome`, async () => {
      const response = await fetch(`${getRuntime().base}/__fixture/r2-failure-extra/${mode}`);
      assert.equal(response.status, 200);
      const result = await response.json();
      if (mode === "stream-supported") {
        assert.deepEqual(result, { result: { unknownLengthRejected: false, objectAbsent: false } });
      } else {
        assert.equal(result.rejected, true);
        assert.match(result.message, mode === "unknown" ? /Unknown R2 failure scenario/ : /Reader failure fixture missing/);
      }
    });
  }
  for (const [mode, body] of [
    ["archive-error", "Archive storage failed"],
    ["archive-precondition", "Archive body unavailable"],
    ["attachment-error", "Attachment storage failed"],
    ["attachment-precondition", "Attachment body is unavailable"],
  ]) {
    test(`R2 application rejects ${mode} without exposing native exception`, async () => {
      const result = await run(mode);
      assert.deepEqual(result, { status: 502, body, calls: ["get"] });
    });
  }
  test("attachment conditional write reports conflict", async () => {
    assert.deepEqual(await run("attachment-conflict"), {
      status: 409, body: "Attachment write conflict", calls: ["put"],
    });
  });
  test("archive failed part aborts multipart exactly once", async () => {
    assert.deepEqual(await run("multipart-abort"), {
      status: 502, body: "Archive storage failed", calls: ["uploadPart", "abort"],
    });
  });
  for (const [mode, pages] of [["list-missing", 1], ["list-repeat", 2], ["list-bound", 10]]) {
    test(`R2 listing terminates malformed pagination ${mode}`, async () => {
      const result = await run(mode);
      assert.equal(result.status, 500);
      assert.deepEqual(JSON.parse(result.body), { error: "internal_error" });
      assert.deepEqual(result.calls, Array(pages).fill("list"));
      const health = await fetch(`${getRuntime().base}/health`);
      assert.equal(health.status, 200);
      await health.text();
    });
  }
}
