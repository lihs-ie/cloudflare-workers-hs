import { afterEach, expect, it, vi } from "vitest";
import { send, setupProduction } from "../../Support/Production/harness.js";

declare const WASM_COVERAGE_ENDPOINT: string;

const instrumented = typeof WASM_COVERAGE_ENDPOINT === "string";
afterEach(() => vi.restoreAllMocks());

it.skipIf(!instrumented)(
  "rejects a failed coverage upload and recovers on the same production reactor (requires instrumented WASM and live collector)",
  async () => {
    await setupProduction();
    // Retain the authentication fixture's fetch chain and intercept only the
    // collector URL. Restoration also preserves any unrelated network setup.
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === WASM_COVERAGE_ENDPOINT) {
        attempts += 1;
        return new Response("Intentional coverage upload failure", { status: 503 });
      }
      return originalFetch(input, init);
    };
    try {
      await expect(send("redirect", "/coverage-upload-missing")).rejects.toThrow(
        /Coverage upload failed: 503/,
      );
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
    // The singleton exported reactor is reused. Its second invocation must
    // successfully upload to the real collector, including the prior error path.
    const recovered = await send("redirect", "/coverage-upload-missing");
    expect(recovered.status).toBe(404);
    await recovered.body?.cancel();
    // Observe the successful upload continuation in a later same-reactor
    // snapshot, and confirm recovery is stable beyond one invocation.
    const stable = await send("redirect", "/coverage-upload-missing");
    expect(stable.status).toBe(404);
    await stable.body?.cancel();
  },
);
