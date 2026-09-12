import { afterAll } from "vitest";
import { SELF } from "cloudflare:test";

// Each test file has its own Worker isolate. Preserve each snapshot separately.
afterAll(async () => {
  const response = await SELF.fetch("https://coverage.invalid/__coverage");
  if (!response.ok) {
    throw new Error(`WASM coverage snapshot failed: ${response.status}`);
  }
  const endpoint = process.env.WASM_COVERAGE_ENDPOINT;
  if (!endpoint) {
    throw new Error("Use scripts/testing/wasm-coverage.py to collect coverage");
  }
  const saved = await fetch(endpoint, {
    method: "POST",
    body: await response.text(),
  });
  if (!saved.ok) {
    throw new Error(`WASM coverage collection failed: ${saved.status}`);
  }
});
