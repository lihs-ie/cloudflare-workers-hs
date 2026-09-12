import { vi } from "vitest";
import { rsaFixture } from "../Fixtures/Crypto.js";

// Only the remote JWKS response is replaced; parsing, cache lookup, signature
// verification and claim validation continue through the production WASM code.
export function mockJWKSFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== "https://runtime-team.cloudflareaccess.com/cdn-cgi/access/certs" || request.method !== "GET") {
      throw new Error("Unexpected request from JWT verification");
    }
    return Response.json({keys: [rsaFixture.jwk]});
  });
}
