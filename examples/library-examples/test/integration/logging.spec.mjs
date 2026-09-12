import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { logRecordsFor } from "../Support/log-records.mjs";
import { startRuntime } from "../Support/dev-runtime.mjs";

let runtime;
before(
  async () => {
    runtime = await startRuntime();
  },
  { timeout: 125000 },
);
after(async () => {
  await runtime?.close();
});

for (const [profile, expected] of [
  ["diagnostics", ["debug", "info", "warn", "error"]],
  ["warnings", ["warn", "error"]],
  ["errors-only", ["error"]],
]) {
  test(`native structured logging profile ${profile} filters levels and preserves errors`, async () => {
    const response = await fetch(`${runtime.base}/logging/${profile}`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { profile, reported: true });
    const identifier = `logging-policy-${profile}`;
    const deadline = Date.now() + 5000;
    let records = [];
    while (Date.now() < deadline) {
      const logs = await readFile(join(runtime.state, "wrangler.log"), "utf8");
      records = logRecordsFor(logs, identifier);
      if (records.some((record) => record.message === "processing failed")) {
        break;
      }
      await delay(50);
    }
    assert.deepEqual(
      records.map((record) => record.level),
      expected,
    );
    assert.ok(records.every((record) => record.path === `/logging/${profile}`));
    assert.equal(records.at(-1).error_kind, "processing_failed");
    assert.equal(records.at(-1).message, "processing failed");
  });
}

test("unknown logging profile is a client error", async () => {
  const response = await fetch(`${runtime.base}/logging/unknown`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 400);
  await response.text();
});

test("tail handler uses a stable unknown script label for a nullable script name", async () => {
  const response = await fetch(`${runtime.base}/__fixture/tail-no-script`);
  assert.equal(response.status, 204);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const logs = await readFile(join(runtime.state, "wrangler.log"), "utf8");
    if (logs.includes("tail outcome=fixture-no-script script=unknown timestamp=Just 123456")) {
      return;
    }
    await delay(50);
  }
  assert.fail("tail event did not produce its documented fallback label");
});
