import assert from "node:assert/strict";
import { test } from "node:test";
import { startDev } from "../Support/dev.mjs";

test("real WASM NamedRoutes health API through wrangler dev", { timeout: 90000 }, async t => {
  const worker = await startDev();
  t.after(worker.close);
  const health = await fetch(`${worker.base}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(await health.json(), { status: "ok" });
  const unknown = await fetch(`${worker.base}/missing`);
  assert.equal(unknown.status, 404);
  await unknown.arrayBuffer();
  const method = await fetch(`${worker.base}/health`, { method: "POST" });
  assert.equal(method.status, 405);
  await method.arrayBuffer();
});
