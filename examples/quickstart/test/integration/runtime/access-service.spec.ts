import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../../Support/Runtime/harness.js";

const issuer = "https://runtime-team.cloudflareaccess.com";
let keys: CryptoKeyPair;
let jwk: JsonWebKey;
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
});
afterEach(() => vi.restoreAllMocks());

describe("typed user and service Access verification", () => {
  it.each([
    { name: "service", identityKind: "service", claims: { common_name: "client.access", sub: "" }, expected: "client.access" },
    { name: "user", identityKind: "user", claims: { email: "member@example.test", sub: "member" }, expected: "member@example.test" },
    { name: "service on user route", identityKind: "user", claims: { common_name: "client.access", sub: "" }, expected: "rejected" },
    { name: "user on service route", identityKind: "service", claims: { email: "member@example.test", sub: "member" }, expected: "rejected" },
    { name: "mixed identity", identityKind: "service", claims: { email: "member@example.test", common_name: "client.access", sub: "" }, expected: "rejected" },
    { name: "empty service", identityKind: "service", claims: { common_name: "", sub: "" }, expected: "rejected" },
    { name: "wrong audience", identityKind: "service", claims: { common_name: "client.access", sub: "", aud: "other" }, expected: "rejected" },
    { name: "wrong issuer", identityKind: "service", claims: { common_name: "client.access", sub: "", iss: "https://other.example" }, expected: "rejected" },
    { name: "expired service", identityKind: "service", claims: { common_name: "client.access", sub: "", exp: 1 }, expected: "rejected" },
    { name: "future service", identityKind: "service", claims: { common_name: "client.access", sub: "", nbf: 9999999999 }, expected: "rejected" },
    { name: "tampered service", identityKind: "service", claims: { common_name: "client.access", sub: "" }, expected: "rejected" },
  ])("$name", async ({ name, identityKind, claims, expected }) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(new Request(input, init).url).toBe(issuer + "/cdn-cgi/access/certs");
      return Response.json({ keys: [{ ...jwk, kid: "service-fixture", alg: "RS256" }] });
    });
    const input = json({ alg: "RS256", kid: "service-fixture" }) + "." + json({ aud: ["runtime-audience"], iss: issuer, exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input)));
    if (name === "tampered service") {
      signature[0] = signature[0]! ^ 1;
    }
    const response = await worker.fetch(new Request("https://example.test/__access/configured", {
      method: "POST",
      body: JSON.stringify({ token: input + "." + encode(signature), audience: "runtime-audience", team: "runtime-team", url: issuer + "/cdn-cgi/access/certs", skew: 0, ttl: 60, identityKind }),
    }), env, createExecutionContext());
    expect(await response.json()).toEqual({ identity: expected });
  });
});
