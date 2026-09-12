import { describe, expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../../Support/Runtime/harness.js";
import { rsaFixture } from "../../Support/Fixtures/Crypto.js";

describe("real WASM SubtleCrypto RSA verification", () => {
  it.each([
    {
      label: "accepts a fixed WebCrypto signature",
      tamperSignature: false,
      tamperMessage: false,
      valid: true,
    },
    {
      label: "rejects a modified signature",
      tamperSignature: true,
      tamperMessage: false,
      valid: false,
    },
    {
      label: "rejects a modified signing input",
      tamperSignature: false,
      tamperMessage: true,
      valid: false,
    },
  ])("$label", async ({ tamperSignature, tamperMessage, valid }) => {
    const signature: number[] = [...rsaFixture.signature];
    const message: number[] = [...rsaFixture.message];
    if (tamperSignature) signature[0] = signature[0]! ^ 1;
    if (tamperMessage) message[0] = message[0]! ^ 1;
    const response = await worker.fetch(
      new Request("https://example.test/__crypto/verify", {
        method: "POST",
        body: JSON.stringify({ jwk: rsaFixture.jwk, signature, message }),
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid });
  });
});
