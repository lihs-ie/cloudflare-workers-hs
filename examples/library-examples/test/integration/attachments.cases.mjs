import { test } from "node:test";
import assert from "node:assert/strict";

export function registerAttachmentsTests(getRuntime) {
  const send = (path, options = {}) => fetch(getRuntime().base + path, {
    ...options, signal: AbortSignal.timeout(10000),
  });
  test("attachment download uses stored HTTP metadata and preserves binary bytes", async () => {
    const path = "/attachments/metadata.bin";
    const bytes = new Uint8Array([0, 128, 255, 65]);
    const stored = await send(path, { method: "PUT", body: bytes, headers: { "Content-Type": "application/x-example" } });
    assert.equal(stored.status, 201, await stored.text());
    const downloaded = await send(path);
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/x-example");
    assert.equal(downloaded.headers.get("content-disposition"), 'attachment; filename="metadata.bin"');
    assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
    assert.equal(downloaded.headers.get("x-content-type-options"), "nosniff");
    assert.ok(downloaded.headers.get("etag"));
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), bytes);
    assert.equal((await send("/attachments/absent-file.bin")).status, 404);
  });
  test("attachment validates identifiers, methods, and encryption mode", async () => {
    assert.equal((await send("/attachments/bad%20name")).status, 400);
    assert.equal((await send("/attachments/valid", { method: "DELETE" })).status, 405);
    const invalid = await send("/attachments/invalid-mode", {
      method: "PUT", body: "secret", headers: { "X-Attachment-Encryption": "unexpected" },
    });
    assert.equal(invalid.status, 400);
    assert.equal((await send("/attachments/invalid-mode")).status, 404);
  });
  test("attachment size limit rejects writes before creating an object", async () => {
    const path = "/attachments/too-large.bin";
    const result = await send(path, { method: "PUT", body: new Uint8Array(1048577) });
    assert.equal(result.status, 413);
    assert.equal((await send(path)).status, 404);
  });
  for (const mode of ["missing-key", "invalid-key"]) {
    test(`SSE-C ${mode} rejects writes without plaintext fallback`, async () => {
      const path = `/__fixture/attachments/${mode}/${mode}.bin`;
      const result = await send(path, {
        method: "PUT", body: "confidential", headers: { "X-Attachment-Encryption": "sse-c" },
      });
      assert.equal(result.status, 503);
      assert.equal(await result.text(), "Attachment encryption is unavailable");
      assert.equal((await send(`/attachments/${mode}.bin`)).status, 404);
    });
  }
  test("SSE-C reports native capability and checks key rejection when supported", async (t) => {
    const probe = await send("/__fixture/attachments/capability");
    assert.equal(probe.status, 200);
    const capability = await probe.json();
    assert.equal(capability.correctKeyReadable, true);
    if (capability.keyMetadataPresent) {
      assert.equal(capability.wrongKeyReadable, false);
      assert.equal(capability.noKeyReadable, false);
    } else {
      assert.equal(capability.wrongKeyReadable, true);
      assert.equal(capability.noKeyReadable, true);
      t.diagnostic("Local R2 ignores SSE-C: metadata is absent and both wrong-key and no-key reads succeed. Encryption and key rejection remain unverified; this is not an encrypted roundtrip proof.");
    }
    const path = "/__fixture/attachments/valid-key/encrypted.bin";
    const headers = { "X-Attachment-Encryption": "sse-c", "Content-Type": "application/octet-stream" };
    const stored = await send(path, { method: "PUT", headers, body: new Uint8Array([0, 255, 128]) });
    assert.equal(stored.status, 201, await stored.text());
    const rejected = await send("/__fixture/attachments/wrong-key/encrypted.bin", { headers });
    if (capability.keyMetadataPresent) {
      assert.equal(rejected.status, 502);
      assert.equal(await rejected.text(), "Attachment storage failed");
    } else {
      assert.equal(rejected.status, 200);
      assert.deepEqual(new Uint8Array(await rejected.arrayBuffer()), new Uint8Array([0, 255, 128]));
    }
    const downloaded = await send(path, { headers });
    assert.equal(downloaded.status, 200, downloaded.status === 200 ? "" : await downloaded.text());
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), new Uint8Array([0, 255, 128]));
    assert.equal((await send("/attachments/encrypted.bin")).status, 404);
  });
}
