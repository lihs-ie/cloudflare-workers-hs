/** One-shot local probe; only its R2 binding connects to Cloudflare. */
import { createHash } from "node:crypto";
import { observeReadFailure } from "./ssec-evidence.ts";
import { bindExport, createReactor, decodeResponse } from "@cloudflare-workers-hs/runtime";
import makeImports from "../../../worker/library-examples-jsffi.mjs";
import wasmModule from "../../../worker/library-examples.wasm";

interface ProbeEnv {
  EXAMPLE_BUCKET: Pick<R2Bucket, "put" | "get" | "createMultipartUpload" | "resumeMultipartUpload">;
  RECEIPT_URL: string;
  EXAMPLE_MODE: string;
  EXAMPLE_SECRET: string;
  ATTACHMENT_SSEC_KEY?: string;
}
const reactor = await createReactor(wasmModule, makeImports, (exports) => ({
  fetch: bindExport<[Request, ProbeEnv, ExecutionContext], Response>(exports, "fetch", decodeResponse),
}));
let used = false;
export default {
  async fetch(request: Request, env: ProbeEnv, context: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return new Response("ready");
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/run" || used) {
      return new Response("Not available", { status: 404 });
    }
    used = true;
    // The 32 ASCII bytes are generated in memory, never logged or persisted.
    const secret = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    async function receipt(phase: string, key: string, identifier?: string) {
      const result = await fetch(env.RECEIPT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phase, key, ...(identifier ? { identifier } : {}) }) });
      if (!result.ok) {
        throw new Error("Upload receipt persistence failed");
      }
    }
    function observed(upload: R2MultipartUpload): R2MultipartUpload {
      return {
        key: upload.key,
        uploadId: upload.uploadId,
        uploadPart: upload.uploadPart.bind(upload),
        async complete(parts) {
          const result = await upload.complete(parts);
          await receipt("closed", upload.key, upload.uploadId);
          return result;
        },
        async abort() {
          await upload.abort();
          await receipt("closed", upload.key, upload.uploadId);
        },
      };
    }
    const bucket: ProbeEnv["EXAMPLE_BUCKET"] = {
      put: env.EXAMPLE_BUCKET.put.bind(env.EXAMPLE_BUCKET),
      get: env.EXAMPLE_BUCKET.get.bind(env.EXAMPLE_BUCKET),
      async createMultipartUpload(key, options) {
        if (key !== "archives/encrypted/remote-archive.bin") {
          throw new Error("Unexpected archive key");
        }
        await receipt("intent", key);
        const upload = await env.EXAMPLE_BUCKET.createMultipartUpload(key, options);
        try {
          await receipt("created", key, upload.uploadId);
        } catch {
          await upload.abort();
          throw new Error("Upload receipt unavailable");
        }
        return observed(upload);
      },
      resumeMultipartUpload(key, identifier) {
        return observed(env.EXAMPLE_BUCKET.resumeMultipartUpload(key, identifier));
      },
    };
    const expectedKeyMd5 = createHash("md5").update(secret, "utf8").digest("hex");
    const correctKey = new TextEncoder().encode(secret).buffer;
    const wrongKey = new TextEncoder().encode(secret === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32)).buffer;
    const configured = { ...env, EXAMPLE_BUCKET: bucket, ATTACHMENT_SSEC_KEY: secret };
    const body = "x".repeat(4096);
    const encrypted = { "X-Attachment-Encryption": "sse-c" };
    async function call(method: string, headers: Record<string, string>, bindings: ProbeEnv, input?: string) {
      return reactor.fetch(new Request("https://example.invalid/attachments/remote-probe.bin", { method, headers, body: input }), bindings, context);
    }
    try {
      const put = await call("PUT", { ...encrypted, "Content-Type": "application/octet-stream" }, configured, body);
      if (put.status !== 201) {
        throw new Error("put");
      }
      const get = await call("GET", encrypted, configured);
      const bytesMatch = (await get.text()) === body;
      const metadataMatches = get.headers.get("content-type") === "application/octet-stream"
        && get.headers.get("cache-control") === "private, no-store"
        && get.headers.get("content-disposition") === 'attachment; filename="remote-probe.bin"'
        && Boolean(get.headers.get("etag"));
      const wrong = await call("GET", encrypted, { ...env, ATTACHMENT_SSEC_KEY: secret === "0".repeat(32) ? "1".repeat(32) : "0".repeat(32) });
      let attachmentWrongKeyOutcome = "returned";
      try {
        await env.EXAMPLE_BUCKET.get("attachments/encrypted/remote-probe.bin", { ssecKey: wrongKey });
      } catch (error) {
        attachmentWrongKeyOutcome = observeReadFailure(error);
      }
      const attachmentRecovered = await env.EXAMPLE_BUCKET.get("attachments/encrypted/remote-probe.bin", { ssecKey: correctKey });
      const attachmentKeyMetadataMatches = attachmentRecovered?.ssecKeyMd5 === expectedKeyMd5;
      const attachmentRecoveryMatches = attachmentRecovered !== null && (await attachmentRecovered.text()) === body;
      const applicationRecovered = await call("GET", encrypted, configured);
      const applicationRecoveryMatches = applicationRecovered.status === 200 && (await applicationRecovered.text()) === body;
      const missing = await call("GET", encrypted, { ...env, ATTACHMENT_SSEC_KEY: undefined });
      const plain = await call("GET", {}, configured);
      const archive = await reactor.fetch(new Request("https://example.invalid/archives/encrypted/remote-archive.bin", { method: "POST" }), configured, context);
      const archived = await env.EXAMPLE_BUCKET.get("archives/encrypted/remote-archive.bin", { ssecKey: correctKey });
      const archiveBytes = archived ? new Uint8Array(await archived.arrayBuffer()) : new Uint8Array();
      const archiveMatches = archiveBytes.length === 5242883
        && archiveBytes.subarray(0, 5242880).every((byte) => byte === 65)
        && archiveBytes[5242880] === 0 && archiveBytes[5242881] === 128 && archiveBytes[5242882] === 255;
      const archiveKeyMetadataMatches = archived?.ssecKeyMd5 === expectedKeyMd5;
      let archiveWrongKeyOutcome = "returned";
      try {
        await env.EXAMPLE_BUCKET.get("archives/encrypted/remote-archive.bin", { ssecKey: wrongKey });
      } catch (error) {
        archiveWrongKeyOutcome = observeReadFailure(error);
      }
      const archiveRecovered = await env.EXAMPLE_BUCKET.get("archives/encrypted/remote-archive.bin", { ssecKey: correctKey });
      const recoveredBytes = archiveRecovered ? new Uint8Array(await archiveRecovered.arrayBuffer()) : new Uint8Array();
      const archiveRecoveryMatches = recoveredBytes.length === archiveBytes.length
        && recoveredBytes.every((byte, index) => byte === archiveBytes[index])
        && archiveRecovered?.ssecKeyMd5 === expectedKeyMd5;
      const positiveChecksPassed = attachmentKeyMetadataMatches && archiveKeyMetadataMatches
        && attachmentRecoveryMatches && applicationRecoveryMatches && archiveRecoveryMatches
        && archive.status === 201 && archiveMatches && get.status === 200 && bytesMatch && metadataMatches
        && wrong.status === 502 && missing.status === 503 && plain.status === 404;
      // The documented R2 code table does not identify an SSE-C-specific rejection.
      // Neither an arbitrary native exception nor the app's generic 502 proves it.
      // Keep the full remote gate incomplete until a supported classification exists.
      const passed = false;
      return Response.json({ passed, positiveChecksPassed, negativeProof: "unverified",
        archiveStatus: archive.status, archiveMatches, archiveWrongKeyOutcome,
        archiveKeyMetadataMatches, archiveRecoveryMatches, attachmentWrongKeyOutcome,
        attachmentKeyMetadataMatches, attachmentRecoveryMatches, applicationRecoveryMatches,
        putStatus: put.status, getStatus: get.status, bytesMatch, metadataMatches,
        wrongKeyStatus: wrong.status, missingKeyStatus: missing.status, plaintextStatus: plain.status,
      }, { status: 500 });
    } catch {
      return Response.json({ passed: false, stage: "ssec-probe" }, { status: 500 });
    }
  },
};
