/** Local boundary contracts only: no real R2, network, WASM or encryption proof. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, test } from "node:test";
import { registerHooks } from "node:module";
let serial = 0;
const archiveKey = "archives/encrypted/remote-archive.bin";
const probeURL = new URL("./ssec-probe.ts", import.meta.url);

async function withProbe(mode, action) {
  const calls = [], receipts = [];
  let secret;
  let archiveReads = 0;
  const upload = {
    key: archiveKey, uploadId: "fake-upload",
    async uploadPart(part, bytes) { calls.push(["part", part, bytes.byteLength]); return { partNumber: part, etag: "fake" }; },
    async complete(parts) { calls.push(["complete", parts]); return {}; },
    async abort() { calls.push(["abort"]); },
  };
  function result(key, recovered) {
    if (mode === "null-objects") { return null; }
    const bytes = new Uint8Array(5242883);
    bytes.fill(65, 0, 5242880); bytes.set([0, 128, 255], 5242880);
    if (mode === "bad-archive") { bytes[0] = 0; }
    if (mode === "bad-recovery" && recovered) { bytes[1] = 0; }
    return { ssecKeyMd5: createHash("md5").update(secret).digest("hex"),
      async text() { return mode === "bad-attachment" ? "bad" : "x".repeat(4096); },
      async arrayBuffer() { return bytes.buffer; },
    };
  }
  const bucket = {
    async put() { calls.push(["put"]); return {}; },
    async get(key, options) {
      const keyText = new TextDecoder().decode(options.ssecKey);
      if (keyText !== secret) {
        if (mode === "wrong-key-returned") { return null; }
        throw new Error(mode === "classified-error" ? "fake transport (10001)" : "fake unknown failure");
      }
      if (key === archiveKey) { archiveReads += 1; }
      return result(key, archiveReads > 1);
    },
    async createMultipartUpload(key) { calls.push(["create", key]); return upload; },
    resumeMultipartUpload(key, identifier) { calls.push(["resume", key, identifier]); return upload; },
  };
  async function reactorFetch(request, env) {
    if (request.method === "PUT") {
      secret = env.ATTACHMENT_SSEC_KEY;
      await env.EXAMPLE_BUCKET.put("fake", "body");
      if (mode === "put-fails") { return new Response(null, { status: 500 }); }
      return new Response(null, { status: 201 });
    }
    if (request.method === "POST") {
      const multipart = await env.EXAMPLE_BUCKET.createMultipartUpload(mode === "unexpected-key" ? "forbidden" : archiveKey, {});
      const part = await multipart.uploadPart(1, new Uint8Array([1]).buffer);
      await multipart.complete([part]);
      await env.EXAMPLE_BUCKET.resumeMultipartUpload(archiveKey, "fake-upload").abort();
      return new Response(null, { status: mode === "bad-archive-status" ? 500 : 201 });
    }
    if (!request.headers.has("X-Attachment-Encryption")) { return new Response(null, { status: 404 }); }
    if (!env.ATTACHMENT_SSEC_KEY) { return new Response(null, { status: 503 }); }
    if (env.ATTACHMENT_SSEC_KEY !== secret) { return new Response(null, { status: 502 }); }
    await env.EXAMPLE_BUCKET.get("attachments/encrypted/remote-probe.bin", { ssecKey: new TextEncoder().encode(secret).buffer });
    return new Response("x".repeat(4096), { headers: {
      "Content-Type": mode === "bad-metadata" ? "text/plain" : "application/octet-stream",
      "Cache-Control": "private, no-store", "Content-Disposition": 'attachment; filename="remote-probe.bin"', ETag: "fake",
    } });
  }
  const runtime = mock.module("@cloudflare-workers-hs/runtime", { namedExports: {
    async createReactor(_wasm, imports, bind) { imports(); return bind({ fetch: reactorFetch }); },
    bindExport(exports, name, decode) { return async (...args) => decode(await exports[name](...args)); }, decodeResponse(value) { return value; },
  } });
  const glue = mock.module(new URL("../../../worker/library-examples-jsffi.mjs", import.meta.url).href, { defaultExport: () => ({}) });
  const wasmURL = new URL("../../../worker/library-examples.wasm", import.meta.url).href;
  const wasm = registerHooks({ load(url, context, nextLoad) {
    if (url === wasmURL) { return { format: "module", source: "export default {};", shortCircuit: true }; }
    return nextLoad(url, context);
  } });
  const fetch = mock.method(globalThis, "fetch", async (_url, init) => {
    const record = JSON.parse(init.body); receipts.push(record);
    return new Response(null, { status: mode === `receipt-${record.phase}` ? 503 : 204 });
  });
  const randomness = mock.method(crypto, "getRandomValues", (array) => array.fill(mode === "zero-key" ? 0 : 1));
  try {
    const { default: probe } = await import(probeURL.href + `?contract=${++serial}`);
    await action(probe, { EXAMPLE_BUCKET: bucket, RECEIPT_URL: "https://unused.invalid/receipt", EXAMPLE_MODE: "fixture", EXAMPLE_SECRET: "unused" }, calls, receipts);
  } finally { randomness.mock.restore(); fetch.mock.restore(); wasm.deregister(); glue.restore(); runtime.restore(); }
}

for (const mode of ["happy", "zero-key", "wrong-key-returned", "classified-error", "null-objects", "bad-archive", "bad-recovery", "bad-attachment", "bad-metadata", "bad-archive-status", "put-fails", "unexpected-key", "receipt-intent", "receipt-created", "receipt-closed"]) {
  test(`SSE-C probe local boundary contract: ${mode}`, async () => {
    await withProbe(mode, async (probe, env, calls, receipts) => {
      assert.equal((await probe.fetch(new Request("https://probe.invalid/health"), env, {})).status, 200);
      assert.equal((await probe.fetch(new Request("https://probe.invalid/run"), env, {})).status, 404);
      assert.equal((await probe.fetch(new Request("https://probe.invalid/other", { method: "POST" }), env, {})).status, 404);
      const response = await probe.fetch(new Request("https://probe.invalid/run", { method: "POST" }), env, {});
      assert.equal(response.status, 500, "local contracts must never claim verified encryption rejection");
      const body = await response.json();
      assert.equal(body.passed, false);
      if (["put-fails", "unexpected-key", "receipt-intent", "receipt-created", "receipt-closed"].includes(mode)) {
        assert.deepEqual(body, { passed: false, stage: "ssec-probe" });
      } else {
        assert.equal(body.negativeProof, "unverified");
        assert.equal(body.positiveChecksPassed, ["happy", "zero-key", "wrong-key-returned", "classified-error"].includes(mode));
      }
      if (mode === "receipt-created") { assert.ok(calls.some(call => call[0] === "abort")); }
      for (const receipt of receipts) {
        assert.equal(receipt.key, archiveKey);
        assert.deepEqual(Object.keys(receipt).sort(), receipt.phase === "intent" ? ["key", "phase"] : ["identifier", "key", "phase"]);
      }
      assert.equal((await probe.fetch(new Request("https://probe.invalid/run", { method: "POST" }), env, {})).status, 404);
    });
  });
}
