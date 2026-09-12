/** Fresh test-only RSA key: verification always uses the actual Access JWT pipeline. */
export const accessTeam = "quickstart-tests";
export const accessAudience = "quickstart-tests-audience";
export const accessIssuer = `https://${accessTeam}.cloudflareaccess.com`;
export const jwksURL = `${accessIssuer}/cdn-cgi/access/certs`;

function base64URL(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function encode(value: unknown): string {
  return base64URL(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createAccessFixture(keyIdentifier = "quickstart-test-key") {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const jwks = { keys: [{ ...publicKey, kid: keyIdentifier, alg: "RS256", use: "sig" }] };
  async function token(overrides: Record<string, unknown> = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: accessIssuer, aud: [accessAudience], sub: "admin-one", email: "admin-one@example.test",
      iat: now - 1, nbf: now - 1, exp: now + 3600, type: "app", ...overrides,
    };
    const unsigned = `${encode({ alg: "RS256", kid: keyIdentifier, typ: "JWT" })}.${encode(payload)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${base64URL(new Uint8Array(signature))}`;
  }
  return { jwks, token };
}
