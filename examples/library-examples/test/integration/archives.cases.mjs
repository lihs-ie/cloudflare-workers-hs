import { test } from "node:test";
import assert from "node:assert/strict";

export function registerArchiveTests(getRuntime) {
  const send = (path, method = "GET") => fetch(getRuntime().base + path, { method, signal: AbortSignal.timeout(15000) });
  test("archive routes reject invalid identifiers and methods before storage writes", async () => {
    for (const identifier of ["a".repeat(129), "invalid%20name"]) {
      const response = await send(`/archives/infrequent/${identifier}`, "POST");
      assert.equal(response.status, 400);
      await response.text();
    }
    const unsupported = await send("/archives/infrequent/not-created.txt", "PUT");
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get("allow"), "POST, GET");
    await unsupported.text();
    const absent = await send("/archives/infrequent/not-created.txt");
    assert.equal(absent.status, 404);
    await absent.text();
  });
  test("encrypted multipart archive resumes with per-part keys and reports local capability honestly", async (t) => {
    const suffix = "/encrypted/multipart-local.bin";
    try {
      const missing = await send("/__fixture/archives/missing-key" + suffix, "POST");
      assert.equal(missing.status, 503);
      assert.equal(await missing.text(), "Archive encryption is unavailable");
      const uploaded = await send("/__fixture/archives/valid-key" + suffix, "POST");
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const result = await uploaded.json();
      assert.equal(result.size, 5 * 1024 * 1024 + 3);
      const downloaded = await send("/__fixture/archives/valid-key" + suffix);
      assert.equal(downloaded.status, 200);
      const bytes = new Uint8Array(await downloaded.arrayBuffer());
      assert.equal(bytes.length, result.size);
      assert.ok(bytes.subarray(0, bytes.length - 3).every(byte => byte === 65));
      assert.deepEqual(Array.from(bytes.slice(-3)), [0, 128, 255]);
      const observation = await (await send("/__fixture/archives/inspect" + suffix)).json();
      assert.equal(result.keyMetadataPresent, observation.keyMetadataPresent);
      const wrong = await send("/__fixture/archives/wrong-key" + suffix);
      if (observation.keyMetadataPresent) {
        assert.equal(observation.wrongKeyReadable, false);
        assert.equal(observation.noKeyReadable, false);
        assert.equal(wrong.status, 502);
      } else {
        assert.equal(observation.wrongKeyReadable, true);
        assert.equal(observation.noKeyReadable, true);
        assert.equal(wrong.status, 200);
        await wrong.arrayBuffer();
        t.diagnostic("Local multipart R2 ignores SSE-C: per-part key forwarding is checked, but encryption and wrong-key rejection remain unverified.");
      }
    } finally {
      assert.deepEqual(await (await send("/__fixture/archives/cleanup" + suffix, "DELETE")).json(), { deleted: true });
    }
  });
  test("InfrequentAccess archive reports native storage class and preserves content", async (t) => {
    const suffix = "/infrequent/audit-local.txt";
    try {
      const response = await send("/archives" + suffix, "POST");
      assert.equal(response.status, 201, await response.clone().text());
      const result = await response.json();
      assert.equal(result.size, 22);
      const read = await send("/archives" + suffix);
      assert.equal(read.status, 200);
      assert.equal(await read.text(), "retained audit archive");
      const observed = await (await send("/__fixture/archives/inspect" + suffix)).json();
      if (observed.storageClass === "InfrequentAccess") {
        assert.equal(result.storageClass, "R2InfrequentAccess");
      } else {
        assert.notEqual(result.storageClass, "R2InfrequentAccess");
        t.diagnostic(`Local R2 did not retain InfrequentAccess (native class ${JSON.stringify(observed.storageClass)}); billing and retention-class guarantees remain unverified.`);
      }
    } finally {
      assert.deepEqual(await (await send("/__fixture/archives/cleanup" + suffix, "DELETE")).json(), { deleted: true });
    }
  });
}
