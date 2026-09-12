import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { waitForRequestCompletion } from "../Support/log-records.mjs";

export function registerConfigurationCases(getRuntime) {
  test("typed Var and Secret configure the app without exposing values", async () => {
    const response = await fetch(`${getRuntime().base}/configuration`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { configured: true, secretRedacted: true });
    assert.match(response.headers.get("x-request-identifier"), /^[0-9a-f-]{36}$/);
  });
  test("missing required Secret fails before application execution", async () => {
    const response = await fetch(`${getRuntime().base}/__fixture/configuration-missing`);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.doesNotMatch(body, /configuration-secret-fixture-never-log|configured/);
  });
  for (const binding of ["EXAMPLE_MODE", "EXAMPLE_SECRET"]) {
    test(`typed ${binding} rejects missing and malformed runtime values`, async () => {
      for (const kind of ["missing", "undefined", "null", "number", "boolean", "object"]) {
        const response = await fetch(`${getRuntime().base}/__fixture/configuration-invalid?binding=${binding}&kind=${kind}`);
        assert.equal(response.status, 500, `${binding}: ${kind} must not be coerced to text`);
        assert.doesNotMatch(await response.text(), /configuration-secret-fixture-never-log|configuration-malformed-marker/);
      }
    });
  }
  test("middleware retains request identity and logs duration without exception text", async () => {
    const runtime = getRuntime();
    const identifier = "configuration-observability-fixture";
    const response = await fetch(`${runtime.base}/__fixture/configuration-failure`, { headers: { "cf-ray": identifier } });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("x-request-identifier"), identifier);
    assert.deepEqual(await response.json(), { error: "internal_error" });
    const { logs, completion } = await waitForRequestCompletion(
      () => readFile(join(runtime.state, "wrangler.log"), "utf8"), identifier,
    );
    assert.ok(logs.includes("configuration_application_failed"), "failure produces a sanitized diagnostic");
    assert.equal(completion.request_id, identifier);
    assert.ok(completion.duration_ms >= 0);
    assert.equal(completion.status, 500);
    assert.doesNotMatch(logs, /fixture-sensitive-exception-marker/);
    // Wrangler startup prints configured vars, so only application diagnostics
    // after the first structured request record are inspected for secret leakage.
    const applicationLogs = logs.slice(logs.indexOf("request started"));
    assert.doesNotMatch(applicationLogs, /configuration-secret-fixture-never-log/);
  });
}
