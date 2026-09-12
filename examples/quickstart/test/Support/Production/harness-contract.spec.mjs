import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Import the real harnesses in an isolated process with their platform and
// fixture boundaries replaced. These tests do not claim Worker execution.
const production = new URL("./harness.ts", import.meta.url).href;
const jwks = new URL("../Runtime/JWKS.ts", import.meta.url).href;
const loader = `
import { registerHooks } from 'node:module';
const modules = {
'vitest': 'export const vi = { spyOn(object, key) { return { mockImplementation(fn) { object[key] = fn; return fn; } }; } };',
'cloudflare:test': 'export const env = { DB: {}, TEST_MIGRATIONS: [] }; export const createExecutionContext = () => ({ marker: 1 }); export const waitOnExecutionContext = async ctx => { globalThis.calls.push(["wait", ctx]); }; export const applyD1Migrations = async (...args) => { globalThis.calls.push(["migrate", ...args]); };',
'./auth.js': 'export const jwksURL = "https://team.test/certs"; export async function createAccessFixture() { globalThis.calls.push(["fixture"]); return { jwks: { keys: ["key"] } }; }',
'../Fixtures/Crypto.js': 'export const rsaFixture = { jwk: { kty: "RSA", kid: "fixture" } };'
};
registerHooks({ resolve(specifier, context, next) {
  let source = modules[specifier];
  if (context.parentURL === ${JSON.stringify(production)} && specifier.startsWith('../../../worker/')) {
    source = 'export default { async fetch(request, env, context) { globalThis.calls.push(["fetch", request, env, context]); return new Response("worker"); } };';
  }
  if (source !== undefined) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  return next(specifier, context);
}});
`;
function run(t, code) {
  const directory = mkdtempSync(join(tmpdir(), "quickstart-harness-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "loader.mjs");
  writeFileSync(path, loader);
  const result = spawnSync(process.execPath, ["--import", path, "--input-type=module"], { input: code, encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

test("JWKS mock accepts only the expected GET endpoint", (t) => run(t, `
import assert from 'node:assert/strict';
const { mockJWKSFetch } = await import(${JSON.stringify(jwks)});
mockJWKSFetch();
assert.deepEqual(await (await fetch('https://runtime-team.cloudflareaccess.com/cdn-cgi/access/certs')).json(), { keys: [{ kty: 'RSA', kid: 'fixture' }] });
await assert.rejects(fetch('https://unexpected.test/certs'), /Unexpected request/);
await assert.rejects(fetch('https://runtime-team.cloudflareaccess.com/cdn-cgi/access/certs', { method: 'POST' }), /Unexpected request/);
`));

test("production setup reuses the fixture and preserves unrelated fetch requests", (t) => run(t, `
import assert from 'node:assert/strict';
globalThis.calls = [];
globalThis.fetch = async (...args) => { calls.push(['original', ...args]); return new Response('network'); };
const { setupProduction } = await import(${JSON.stringify(production)});
const first = await setupProduction();
assert.equal(await setupProduction(), first);
assert.equal(calls.filter(call => call[0] === 'fixture').length, 1);
assert.equal(calls.filter(call => call[0] === 'migrate').length, 2);
assert.deepEqual(await (await fetch('https://team.test/certs')).json(), { keys: ['key'] });
assert.equal(await (await fetch('https://elsewhere.test/')).text(), 'network');
assert.equal(await (await fetch('https://team.test/certs', { method: 'POST' })).text(), 'network');
assert.equal(calls.filter(call => call[0] === 'original').length, 2);
`));

test("production send forwards each application request and drains its context", (t) => run(t, `
import assert from 'node:assert/strict';
globalThis.calls = [];
const { send, productionEnv } = await import(${JSON.stringify(production)});
for (const application of ['redirect', 'management', 'export', 'recovery']) {
  assert.equal(await (await send(application, '/probe', { method: 'POST', body: 'payload' })).text(), 'worker');
  const [fetchCall, waitCall] = calls.splice(0);
  assert.equal(fetchCall[0], 'fetch');
  assert.equal(fetchCall[1].url, 'https://quickstart.example/probe');
  assert.equal(await fetchCall[1].text(), 'payload');
  assert.equal(fetchCall[2], productionEnv);
  assert.equal(waitCall[0], 'wait');
  assert.equal(waitCall[1], fetchCall[3]);
}
`));
