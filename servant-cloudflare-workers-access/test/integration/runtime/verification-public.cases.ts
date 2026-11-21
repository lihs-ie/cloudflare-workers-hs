import { createExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  jsonArray,
  jsonObject,
  jsonString,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import { accessRoutesProbe, accessVerificationProbe } from '../../../../tests/runtime/harness.js';
export function registerVerificationPublicCases(): void {
  describe('Access public verification metadata and native failure paths', () => {
    let keys: CryptoKeyPair;
    let jwk: JsonWebKey;
    const issuer = 'https://runtime-team.cloudflareaccess.com';
    const encode = (bytes: Uint8Array): string =>
      btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
    const encodeJSON = (value: unknown): string =>
      encode(new TextEncoder().encode(JSON.stringify(value)));
    beforeAll(async () => {
      keys = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      );
      jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
    });
    async function signed(claims: Record<string, unknown>): Promise<string> {
      const input = encodeJSON({ alg: 'RS256', kid: 'metadata-key' }) + '.' + encodeJSON(claims);
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          keys.privateKey,
          new TextEncoder().encode(input),
        ),
      );
      return input + '.' + encode(signature);
    }
    async function verify(mode: string, claims: Record<string, unknown>): Promise<unknown> {
      const token = await signed(claims);
      const original = globalThis.fetch;
      try {
        globalThis.fetch = async (input, init) => {
          expect(new Request(input, init).url).toBe(issuer + '/cdn-cgi/access/certs');
          return Response.json({ keys: [{ ...jwk, kid: 'metadata-key' }] });
        };
        return jsonValue(await accessVerificationProbe(JSON.stringify({ mode, token }), {}));
      } finally {
        globalThis.fetch = original;
      }
    }
    for (const mode of ['user', 'service']) {
      it(`returns verified ${mode} audience, issuer and expiration using default options`, async () => {
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        const common = { aud: ['runtime-audience', 'secondary'], iss: issuer, exp: expiresAt };
        const claims =
          mode === 'user'
            ? { ...common, email: 'member@example.test', sub: 'member' }
            : { ...common, common_name: 'client.access', sub: '' };
        const result = await verify(mode, claims);
        expect(result).toEqual(
          mode === 'user'
            ? {
                ok: true,
                identity: 'member@example.test',
                subject: 'member',
                audience: common.aud,
                issuer,
                expiresAt,
              }
            : { ok: true, identity: 'client.access', audience: common.aud, issuer, expiresAt },
        );
        const rejected = await verify(mode === 'user' ? 'service' : 'user', claims);
        expect(jsonObject(rejected).ok).toBe(false);
        expect(jsonObject(rejected).message).toContain(
          mode === 'user' ? 'expected service identity' : 'expected user identity',
        );
      });
    }
    for (const [name, expiryOffset, notBeforeOffset, message] of [
      ['future-valid-window', 120, 60, 'not yet valid'],
      ['inverted-window', 60, 120, 'inconsistent validity window'],
    ] as const) {
      it(`classifies signed ${name} and recovers`, async () => {
        const now = Math.floor(Date.now() / 1000);
        const common = {
          aud: ['runtime-audience'],
          iss: issuer,
          common_name: 'client.access',
          sub: '',
        };
        const failure = await verify('service', {
          ...common,
          exp: now + expiryOffset,
          nbf: now + notBeforeOffset,
        });
        expect(jsonObject(failure).ok).toBe(false);
        expect(jsonObject(failure).message).toContain(message);
        expect(jsonObject(await verify('service', { ...common, exp: now + 3600 })).ok).toBe(true);
      });
    }
    it('detects synthetic access configuration changes and formats snapshot diagnostics', async () => {
      const result = jsonValue(
        await accessVerificationProbe(JSON.stringify({ mode: 'value-diagnostics' }), {}),
      );
      expect(jsonObject(result).jwkRequiresValue).toBe(true);
      expect(
        jsonArray(jsonObject(result).snapshots).map((snapshot) => jsonObject(snapshot).name),
      ).toEqual([
        'assertion',
        'user',
        'service',
        'config',
        'policy',
        'access-error',
        'crypto-error',
        'key',
      ]);
      const changes = [1, 5, 4, 3, 3, 2, 1, 2];
      jsonArray(jsonObject(result).snapshots).forEach((value, index) => {
        const snapshot = jsonObject(value);
        expect(snapshot.unchanged).toBe(true);
        expect(snapshot.changesDetected).toEqual(Array(changes[index]).fill(true));
        expect(jsonString(snapshot.single).length).toBeGreaterThan(0);
        expect(snapshot.batch).toBe(`[${snapshot.single},${snapshot.single}]`);
      });
    });
    it('preserves typed Access exceptions through a generic exception consumer', async () => {
      const diagnostics = jsonValue(
        await accessVerificationProbe(JSON.stringify({ mode: 'typed-error-diagnostics' }), {}),
      );
      expect(diagnostics).toEqual([
        { sameError: true, diagnostic: 'AccessErrorInvalidSignature' },
        { sameError: true, diagnostic: 'AccessErrorExpored' },
        { sameError: true, diagnostic: 'AccessErrorAudienceMismach' },
        { sameError: true, diagnostic: 'AccessErrorMalformed "synthetic diagnostic"' },
      ]);
      const recovered = await verify('user', {
        email: 'user@example.test',
        sub: 'user',
        aud: ['runtime-audience'],
        iss: issuer,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(jsonObject(recovered).ok).toBe(true);
    });
    for (const [input, diagnostic] of [
      ['not-json', 'Unexpected "not-json", expecting JSON value'],
      ['[]', 'Access probe'],
      ['{}', 'mode'],
      [JSON.stringify({ mode: 'unknown' }), 'Unknown Access probe mode'],
      [JSON.stringify({ mode: 'user' }), 'expected header.payload.signature'],
      [
        JSON.stringify({ mode: 'crypto-public-verify', jwk: { kid: 'bad', kty: 'invalid' } }),
        'subtleImportKey: kid=runtime-probe',
      ],
      [JSON.stringify({ mode: 'crypto-public-verify' }), 'jwk'],
      [JSON.stringify({ mode: 'crypto-import' }), 'jwk'],
    ] as const) {
      it(`reports invalid Access probe input ${input} and accepts the next command`, async () => {
        const failure = jsonValue(await accessVerificationProbe(input, {}));
        expect(jsonObject(failure).ok).toBe(false);
        expect(jsonObject(failure).message).toContain(diagnostic);
        const recovered = jsonValue(
          await accessVerificationProbe(JSON.stringify({ mode: 'ping' }), {}),
        );
        expect(recovered).toEqual({ ok: true });
      });
    }
    it('reports a non-object JWK before native key import', async () => {
      const nativeImport = vi.spyOn(crypto.subtle, 'importKey');
      try {
        const keyFailure = jsonValue(
          await accessVerificationProbe(JSON.stringify({ mode: 'crypto-import', jwk: 42 }), {}),
        );
        expect(jsonObject(keyFailure).ok).toBe(false);
        expect(jsonObject(keyFailure).message).toContain('JWK');
        expect(jsonObject(keyFailure).message).toContain('Number');
        expect(nativeImport).not.toHaveBeenCalled();
        const recovered = jsonValue(
          await accessVerificationProbe(JSON.stringify({ mode: 'ping' }), {}),
        );
        expect(recovered).toEqual({ ok: true });
      } finally {
        nativeImport.mockRestore();
      }
    });
    it('converts native import rejection and then imports a valid key', async () => {
      const failure = jsonValue(
        await accessVerificationProbe(
          JSON.stringify({
            mode: 'crypto-import',
            jwk: { ...jwk, kid: 'bad-usage', key_ops: ['sign'] },
          }),
          {},
        ),
      );
      expect(jsonObject(failure).ok).toBe(false);
      expect(jsonObject(failure).message).toContain('SubtleCryptoError');
      expect(
        jsonValue(
          await accessVerificationProbe(
            JSON.stringify({ mode: 'crypto-import', jwk: { ...jwk, kid: 'valid' } }),
            {},
          ),
        ),
      ).toEqual({ ok: true });
    });
    it('converts public subtleVerify rejection and recovers after restoring crypto', async () => {
      const input = JSON.stringify({
        mode: 'crypto-public-verify',
        jwk: { ...jwk, kid: 'public-verify' },
      });
      const rejected = vi
        .spyOn(crypto.subtle, 'verify')
        .mockRejectedValue(new Error('public-verify-rejected'));
      try {
        const failure = jsonValue(await accessVerificationProbe(input, {}));
        expect(jsonObject(failure).ok).toBe(false);
        expect(jsonObject(failure).message).toContain('SubtleCryptoError');
        expect(jsonObject(failure).message).toContain(
          'subtleVerify: verifyRS256: public-verify-rejected',
        );
      } finally {
        rejected.mockRestore();
      }
      expect(jsonValue(await accessVerificationProbe(input, {}))).toEqual({
        ok: true,
        verified: false,
      });
    });
    for (const token of ['.payload.signature', 'header..signature', 'header.payload.']) {
      it(`rejects an empty JWT component before fetching: ${token}`, async () => {
        const nativeFetch = vi.spyOn(globalThis, 'fetch');
        const nativeVerify = vi.spyOn(crypto.subtle, 'verify');
        try {
          const failure = jsonValue(
            await accessVerificationProbe(JSON.stringify({ mode: 'service', token }), {}),
          );
          expect(jsonObject(failure).ok).toBe(false);
          expect(jsonObject(failure).message).toContain('expected header.payload.signature');
          expect(nativeFetch).not.toHaveBeenCalled();
          expect(nativeVerify).not.toHaveBeenCalled();
        } finally {
          nativeFetch.mockRestore();
          nativeVerify.mockRestore();
        }
        expect(
          jsonObject(
            await verify('service', {
              common_name: 'client.access',
              sub: '',
              aud: ['runtime-audience'],
              iss: issuer,
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          ).ok,
        ).toBe(true);
      });
    }
    it('reuses the service verifier cache through public options', async () => {
      const token = await signed({
        common_name: 'client.access',
        sub: '',
        aud: ['runtime-audience'],
        iss: issuer,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      const nativeFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(Response.json({ keys: [{ ...jwk, kid: 'metadata-key' }] }));
      try {
        const options = {
          mode: 'service',
          token,
          cacheTtl: 300,
          jwksURL: 'https://cache-public-contract.example/certs',
        };
        const first = jsonValue(await accessVerificationProbe(JSON.stringify(options), {}));
        const second = jsonValue(await accessVerificationProbe(JSON.stringify(options), {}));
        expect(jsonObject(first).ok).toBe(true);
        expect(second).toEqual(first);
        expect(nativeFetch).toHaveBeenCalledTimes(1);
      } finally {
        nativeFetch.mockRestore();
      }
    });
    it('returns a diagnostic for a correctly signed non-JSON payload', async () => {
      const input =
        encodeJSON({ alg: 'RS256', kid: 'metadata-key' }) +
        '.' +
        encode(new TextEncoder().encode('not JSON'));
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          'RSASSA-PKCS1-v1_5',
          keys.privateKey,
          new TextEncoder().encode(input),
        ),
      );
      const nativeFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => Response.json({ keys: [{ ...jwk, kid: 'metadata-key' }] }));
      try {
        const failure = jsonValue(
          await accessVerificationProbe(
            JSON.stringify({ mode: 'user', token: input + '.' + encode(signature) }),
            {},
          ),
        );
        expect(jsonObject(failure).ok).toBe(false);
        expect(jsonObject(failure).message).toContain('AccessErrorMalformed');
        expect(jsonObject(failure).message).not.toContain('verification failed');
        expect(jsonObject(failure).message).not.toContain('InvalidSignature');
      } finally {
        nativeFetch.mockRestore();
      }
    });
    it('preserves the issuer mismatch diagnosis after successful signature validation', async () => {
      const failure = await verify('user', {
        email: 'user@example.test',
        sub: 'user',
        aud: ['runtime-audience'],
        iss: 'https://other.example',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      expect(jsonObject(failure).ok).toBe(false);
      expect(jsonObject(failure).message).toContain('issuer mismatch');
    });
    for (const mode of ['user', 'user-bottom-config']) {
      it(`masks pipeline exceptions and logs only their category for ${mode}`, async () => {
        const token = await signed({
          email: 'user@example.test',
          sub: 'user',
          aud: ['runtime-audience'],
          iss: issuer,
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        const logs: string[] = [];
        const logger = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
          logs.push(values.map(String).join(' '));
        });
        const nativeFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
          Response.json({
            keys: [
              mode === 'user'
                ? { ...jwk, kid: 'metadata-key', key_ops: ['sign'] }
                : { ...jwk, kid: 'metadata-key' },
            ],
          }),
        );
        try {
          const failure = jsonValue(
            await accessVerificationProbe(JSON.stringify({ mode, token }), {}),
          );
          expect(failure).toEqual({
            ok: false,
            message: 'AccessErrorMalformed "verification failed"',
          });
          expect(logs).toContain(mode === 'user' ? 'SubtleCryptoError' : 'SomeException');
          expect(logs.join(' ')).not.toContain(token);
          expect(logs.join(' ')).not.toContain('sensitive fixture marker');
        } finally {
          nativeFetch.mockRestore();
          logger.mockRestore();
        }
        expect(
          jsonObject(
            await verify('user', {
              email: 'user@example.test',
              sub: 'user',
              aud: ['runtime-audience'],
              iss: issuer,
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          ).ok,
        ).toBe(true);
      });
    }
    for (const failureKind of ['error', 'unprintable'] as const) {
      it(`preserves authentication failure when logging throws ${failureKind}, then recovers`, async () => {
        const loggingFailure =
          failureKind === 'error'
            ? new Error('logging-failed-private-marker')
            : {
                get message(): never {
                  throw new Error('message-access-private-marker');
                },
                [Symbol.toPrimitive](): never {
                  throw new Error('stringification-private-marker');
                },
              };
        const logger = vi.spyOn(console, 'log').mockImplementation(() => {
          throw loggingFailure;
        });
        try {
          const failure = jsonValue(
            await accessVerificationProbe(JSON.stringify({ mode: 'user', token: 'malformed' }), {}),
          );
          expect(failure).toEqual({
            ok: false,
            message: 'AccessErrorMalformed "expected header.payload.signature"',
          });
          expect(logger).toHaveBeenCalledTimes(1);
          expect(logger).toHaveBeenCalledWith('AccessErrorMalformed');
        } finally {
          logger.mockRestore();
        }
        const recovered = await verify('user', {
          email: 'user@example.test',
          sub: 'user',
          aud: ['runtime-audience'],
          iss: issuer,
          exp: Math.floor(Date.now() / 1000) + 3600,
        });
        expect(jsonObject(recovered).ok).toBe(true);
        expect(jsonObject(recovered).identity).toBe('user@example.test');
      });
    }
    it('enforces service route authentication and consumes nested context', async () => {
      const response = await accessRoutesProbe(
        new Request('https://fixture.test/'),
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const names: unknown = await response.json();
      expect(names).toHaveLength(9);
    });
  });
}
