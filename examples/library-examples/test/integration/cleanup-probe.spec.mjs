import assert from "node:assert/strict";
import { test } from "node:test";
import probe from "../Support/Remote/cleanup-probe.ts";
const key = "archives/encrypted/remote-archive.bin";
function request(body) {
  return new Request("https://probe.invalid/run", { method: "POST", body: JSON.stringify(body) });
}
test("cleanup probe only aborts the exact recorded archive upload", async () => {
  const calls = [];
  const env = { EXAMPLE_BUCKET: { resumeMultipartUpload(...args) { calls.push(args); return { async abort() { calls.push("aborted"); } }; } } };
  assert.equal(await (await probe.fetch(new Request("https://probe.invalid/health"), env)).text(), "ready");
  assert.equal((await probe.fetch(new Request("https://probe.invalid/run"), env)).status, 404);
  assert.equal((await probe.fetch(new Request("https://probe.invalid/other", { method: "POST" }), env)).status, 404);
  assert.deepEqual(await (await probe.fetch(request({ uploads: [{ key, identifier: "receipt" }] }), env)).json(), { passed: true });
  assert.deepEqual(calls, [[key, "receipt"], "aborted"]);
});
for (const value of [null, 42, {}, { uploads: null }, { uploads: [] }, { uploads: [1, 2] },
  { uploads: [null] }, { uploads: [42] }, { uploads: [{}] }, { uploads: [{ key: "other" }] },
  { uploads: [{ key }] }, { uploads: [{ key, identifier: 42 }] }, { uploads: [{ key, identifier: "" }] },
  { uploads: [{ key, identifier: "x".repeat(2049) }] }]) {
  test(`cleanup rejects invalid scope ${JSON.stringify(value).slice(0, 100)}`, async () => {
    const response = await probe.fetch(request(value), {});
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { passed: false });
  });
}
test("cleanup contains malformed JSON and native abort failures", async () => {
  assert.equal((await probe.fetch(new Request("https://probe.invalid/run", { method: "POST", body: "{" }), {})).status, 500);
  const env = { EXAMPLE_BUCKET: { resumeMultipartUpload() { return { async abort() { throw new Error("native failure"); } }; } } };
  assert.equal((await probe.fetch(request({ uploads: [{ key, identifier: "x".repeat(2048) }] }), env)).status, 500);
});
