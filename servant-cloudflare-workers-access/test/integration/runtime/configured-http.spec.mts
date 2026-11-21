import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startWorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import { verifyBuild } from '../../../../scripts/testing/build-manifest.mts';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const accessTeam = 'access-http-tests';
const accessAudience = 'access-http-audience';

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

void test(
  'configured Access verification applies TTL, issuer, skew and invalid policy over real HTTP',
  { timeout: 60000 },
  async (t) => {
    verifyBuild('library-runtime');
    const keys = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    );
    const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
    let jwksRequests = 0;
    const server = createServer((_request, response) => {
      jwksRequests++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          keys: [{ ...publicKey, kid: 'http-test-key', alg: 'RS256', use: 'sig' }],
        }),
      );
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const jwksPort = address.port;
    async function tokenFor(overrides: Record<string, unknown> = {}): Promise<string> {
      const now = Math.floor(Date.now() / 1000);
      const unsigned =
        encode({ alg: 'RS256', kid: 'http-test-key' }) +
        '.' +
        encode({
          iss: `https://${accessTeam}.cloudflareaccess.com`,
          aud: [accessAudience],
          sub: 'member',
          email: 'admin-one@example.test',
          iat: now - 1,
          nbf: now - 1,
          exp: now + 3600,
          type: 'app',
          ...overrides,
        });
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        new TextEncoder().encode(unsigned),
      );
      return unsigned + '.' + Buffer.from(signature).toString('base64url');
    }
    const runtime = await startWorkerProcess({
      directory: path.join(root, 'tests/runtime'),
      artifactDirectory: path.join(root, 'artifacts/testing'),
      readyPath: '/__coverage',
      command(port: number, state: string): { executable: string; arguments: string[] } {
        return {
          executable: 'pnpm',
          arguments: [
            'exec',
            'wrangler',
            'dev',
            '--ip',
            '127.0.0.1',
            '--port',
            String(port),
            '--persist-to',
            state,
          ],
        };
      },
      verify(): void {
        verifyBuild('library-runtime');
      },
    });
    t.after(async () => {
      try {
        const endpoint = process.env.WASM_COVERAGE_ENDPOINT;
        if (endpoint) {
          const snapshot = await fetch(runtime.base + '/__coverage', {
            signal: AbortSignal.timeout(10000),
          });
          assert.equal(snapshot.status, 200);
          const saved = await fetch(endpoint, {
            method: 'POST',
            body: await snapshot.text(),
            signal: AbortSignal.timeout(10000),
          });
          assert.equal(saved.status, 204);
        }
      } finally {
        await runtime.close();
      }
    });
    const token = await tokenFor();
    function check(condition: boolean, description: string): void {
      assert.ok(condition, description);
    }
    const configuredVerification = async (
      overrides: Record<string, unknown> = {},
    ): Promise<unknown> => {
      const response = await fetch(`${runtime.base}/__access/configured`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          audience: accessAudience,
          team: accessTeam,
          url: `http://127.0.0.1:${jwksPort}/certs`,
          skew: 0,
          ttl: 1,
          ...overrides,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error(`Configured Access fixture failed: ${response.status}`);
      }

      const value: unknown = await response.json();

      if (typeof value !== 'object' || value === null || !('identity' in value)) {
        throw new Error('Missing Access identity');
      }

      return value.identity;
    };
    check(
      (await configuredVerification()) === 'admin-one@example.test',
      'Short TTL fixture accepts signed token using actual HTTP',
    );
    const beforeExpiry = jwksRequests;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    check(
      (await configuredVerification()) === 'admin-one@example.test' &&
        jwksRequests === beforeExpiry + 1,
      'Expired JWKS TTL causes real HTTP re-fetch',
    );
    const alternateToken = await tokenFor({ iss: 'https://alternate-issuer.example.test' });
    check(
      (await configuredVerification({ token: alternateToken })) === 'rejected',
      'Default issuer rejects alternate issuer',
    );
    check(
      (await configuredVerification({
        token: alternateToken,
        issuer: 'https://alternate-issuer.example.test',
      })) === 'admin-one@example.test',
      'Explicit expected issuer accepts matching signed claim',
    );
    const futureToken = await tokenFor({ nbf: Math.floor(Date.now() / 1000) + 30 });
    check(
      (await configuredVerification({ token: futureToken })) === 'rejected',
      'Zero skew rejects future not-before claim',
    );
    check(
      (await configuredVerification({ token: futureToken, skew: 60 })) === 'admin-one@example.test',
      'Configured skew permits near-future signed claim',
    );
    const beforeInvalidPolicy = jwksRequests;
    check(
      (await configuredVerification({ skew: -1 })) === 'rejected' &&
        (await configuredVerification({ ttl: 0 })) === 'rejected' &&
        jwksRequests === beforeInvalidPolicy,
      'Invalid fixture policy is rejected before HTTP access',
    );
  },
);
