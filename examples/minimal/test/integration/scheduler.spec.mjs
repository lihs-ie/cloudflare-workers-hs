import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDev } from "../Support/dev.mjs";

test("real WASM resumes RTS yields with Workers scheduler lacking postTask", { timeout: 90000 }, async (t) => {
  const worker = await startDev({
    config: fileURLToPath(new URL("../Support/wrangler-scheduler.jsonc", import.meta.url)),
  });
  t.after(worker.close);
  const yielded = await fetch(`${worker.base}/__scheduler/yield`, {
    signal: AbortSignal.timeout(30000),
  });
  const body = await yielded.text();
  assert.equal(yielded.status, 404, `${body}; logs: ${worker.logPath}`);
  const recovered = await fetch(`${worker.base}/health`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(recovered.status, 200, `RTS remains usable; logs: ${worker.logPath}`);
  assert.deepEqual(await recovered.json(), { status: "ok" });
});
