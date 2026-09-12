import { afterEach, describe, expect, it, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../../Support/Runtime/harness.js";
import { mockJWKSFetch } from "../../Support/Runtime/JWKS.js";
import { rsaFixture } from "../../Support/Fixtures/Crypto.js";

describe("real WASM Access JWT pipeline", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each(Object.entries(rsaFixture.tokens))(
    "verifies signed %s claims with real crypto",
    async (kind, token) => {
      const fetchSpy = mockJWKSFetch();
      const response = await worker.fetch(
        new Request("https://example.test/__access/verify", {
          method: "POST",
          body: JSON.stringify({ token }),
        }),
        env,
        createExecutionContext(),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        identity: kind === "valid" ? "member@example.test" : "rejected",
      });
    },
  );
});
