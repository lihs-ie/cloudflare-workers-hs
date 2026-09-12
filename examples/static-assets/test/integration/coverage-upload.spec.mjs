import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDev } from "../Support/dev.mjs";

test("coverage upload rejection propagates and the same reactor recovers", {
  timeout: 90000,
  skip: process.env.WASM_COVERAGE_ENDPOINT ? false : "Requires the instrumented WASM build and a live coverage collector",
}, async (t) => {
  const worker = await startDev({
    config: fileURLToPath(new URL("../Support/wrangler-coverage-upload.jsonc", import.meta.url)),
  });
  t.after(worker.close);
  const failure = await fetch(`${worker.base}/__coverage/upload-failure`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(failure.status, 200);
  const result = await failure.json();
  assert.equal(result.rejected, true);
  assert.equal(result.attempts, 1);
  assert.match(result.message, /Coverage upload failed: 503/);
  // This real upload must finish before health resolves. Its snapshot also
  // observes the preceding, deliberately caught Haskell failure continuation.
  const recovered = await fetch(`${worker.base}/api/health`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(recovered.status, 200, `logs: ${worker.logPath}`);
  assert.deepEqual(await recovered.json(), { status: "ok", runtime: "Haskell/WASM" });
});
