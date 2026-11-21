import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The actual TypeScript harness runs; only its WASM/reactor/platform boundary
// is substituted. Production WASM behavior remains the integration suite's job.
const harness = new URL('../../harness.ts', import.meta.url).href;
const loader = `
import { registerHooks } from 'node:module';
const modules = {
'cloudflare:workers': 'export class DurableObject { constructor(ctx) { this.ctx = ctx; } }',
'@cloudflare-workers-hs/runtime': 'export const createReactor = async (wasm, imports, bind) => bind({}); export const bindExport = (table, name, decode) => async (...args) => { globalThis.calls.push([name, ...args]); const result = globalThis.results[name]; if (result instanceof Error) { throw result; } return decode(result); }; export const decodeString = value => value; export const decodeResponse = value => value;',
'./worker/library-runtime-jsffi.mjs': 'export default function imports() {}',
'./worker/library-runtime.wasm': 'export default {};'
};
registerHooks({ resolve(specifier, context, next) {
  const source = modules[specifier];
  if (source !== undefined) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  try { return next(specifier, context); } catch(error) {
    if(specifier.startsWith('.') && specifier.endsWith('.js')) { return next(specifier.slice(0,-3)+'.ts', context); }
    throw error;
  }
}});
`;
function run(t: test.TestContext, code: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-harness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'loader.mjs');
  writeFileSync(path, loader);
  const prefix = `import assert from 'node:assert/strict'; globalThis.calls = []; globalThis.results = {}; const harness = await import(${JSON.stringify(harness)});\n`;
  const result = spawnSync(process.execPath, ['--import', path, '--input-type=module'], {
    input: prefix + code,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

void test('context bridges forward their arguments and reject non-ok results', (t) =>
  run(
    t,
    `
for (const name of ['waitUntilContext', 'passThroughContext']) {
  const context = {};
  const action = () => {};
  results[name] = 'ok';
  await harness[name](context, action);
  assert.equal(calls.at(-1)[1], context);
  if (name === 'waitUntilContext') { assert.equal(calls.at(-1)[2], action); }
  results[name] = 'context rejected';
  await assert.rejects(harness[name](context, action), /context rejected/);
}
const database = {};
results.d1Lookup = 'found';
assert.equal(await harness.lookupD1(database, 'key'), 'found');
assert.deepEqual(calls.at(-1), ['d1Lookup', database, 'key']);
`,
  ));

void test('storage harness maps supported return forms and rejects unexpected results', (t) =>
  run(
    t,
    `
const storage = {};
const instance = new harness.StorageHarness({ storage });
for (const [command, raw, expected] of [
  ['rollback', 'rolled back', 'rolled back'], ['put', 'ignored', null], ['transaction', 'ignored', null],
  ['delete', 'True', true], ['delete', 'False', false], ['get', 'absent', null],
  ['get', new Uint8Array([0, 255]), [0, 255]],
]) {
  results.storage = raw;
  assert.deepEqual(await instance.operation(command, 'key', [1, 2]), expected);
  assert.deepEqual(calls.at(-1), ['storage', storage, command, 'key', new Uint8Array([1, 2])]);
}
results.storage = { invalid: true };
await assert.rejects(instance.operation('get', 'key', []), /Unexpected storage result/);
`,
  ));

void test('probe decoders reject malformed arrays and preserve valid strings', (t) =>
  run(
    t,
    `
for (const name of ['socketProbe', 'transportExtraProbe']) {
  for (const raw of ['{}', '[1]', 'null', 'not-json']) {
    results[name] = raw;
    await assert.rejects(harness[name]({}, 'read'));
  }
  results[name] = '["first","second"]';
  assert.deepEqual(await harness[name]({}, 'read'), ['first', 'second']);
}
`,
  ));

void test('HTTP harness translates request bodies and preserves the fallback response', (t) =>
  run(
    t,
    `
const handler = harness.default;
const context = {};
const operations = [];
const environment = { STORAGE: { newUniqueId: () => 'fresh', get(identifier) { assert.equal(identifier, 'fresh'); return { async operation(...args) { operations.push(args); return args[1]; } }; } } };
const send = (path, body) => handler.fetch(new Request('https://runtime.test' + path, body === undefined ? {} : { method: 'POST', body }), environment, context);
results.coverage = 'coverage data';
assert.equal(await (await send('/__coverage')).text(), 'coverage data');
results.jwtVerifyConfigured = 'configured-user';
assert.deepEqual(await (await send('/__access/configured', 'token')).json(), { identity: 'configured-user' });
assert.deepEqual(calls.at(-1), ['jwtVerifyConfigured', 'token']);
results.jwtVerify = 'user';
assert.deepEqual(await (await send('/__access/verify', '{"token":"jwt"}')).json(), { identity: 'user' });
assert.deepEqual(calls.at(-1), ['jwtVerify', 'jwt']);
for (const value of ['valid', 'invalid']) {
  results.cryptoVerify = value;
  assert.deepEqual(await (await send('/__crypto/verify', JSON.stringify({ jwk: { kty: 'RSA' }, signature: [1], message: [2] }))).json(), { valid: value === 'valid' });
  assert.deepEqual(calls.at(-1), ['cryptoVerify', '{"kty":"RSA"}', new Uint8Array([1]), new Uint8Array([2])]);
}
assert.deepEqual(await (await send('/__model/storage', '[]')).json(), []);
assert.deepEqual(await (await send('/__model/storage', '[{"command":"get","key":"one","bytes":[]},{"command":"get","key":"two","bytes":[]}]')).json(), ['one', 'two']);
assert.deepEqual(operations, [['get', 'one', []], ['get', 'two', []]]);
await assert.rejects(send('/__access/verify', '{broken'));
results.fetch = new Response('fallback');
assert.equal(await send('/ordinary'), results.fetch);
assert.equal(calls.at(-1)[2], environment);
assert.equal(calls.at(-1)[3], context);
`,
  ));

void test('storage public probe preserves its command and returned result', (t) =>
  run(
    t,
    `
for (const name of ['storagePublicContractsProbe']) {
  results[name] = 'contract result';
  assert.equal(await harness[name]('negative-case'), 'contract result');
  assert.deepEqual(calls.at(-1), [name, 'negative-case']);
}
`,
  ));

void test('transport probe validates list exports at its boundary', (t) =>
  run(
    t,
    `
const source = {};
results.transportExtraProbe = '["received"]';
assert.deepEqual(await harness.transportExtraProbe(source, 'read'), ['received']);
assert.deepEqual(calls.at(-1), ['transportExtraProbe', source, 'read']);
results.transportExtraProbe = '{}';
await assert.rejects(harness.transportExtraProbe(source, 'read'));
`,
  ));

void test('SQL and upgrade fixture routes preserve snapshots and propagate boundary failures', (t) =>
  run(
    t,
    `
const failure = new Error('platform failure');
const environment = { STORAGE: { getByName(name) { assert.equal(name, 'sql-fixture'); return { sqlChecks: async () => '{"sql":true}' }; } } };
const send = path => harness.default.fetch(new Request('https://runtime.test' + path), environment, {});
assert.deepEqual(await (await send('/__sql')).json(), {sql:true});
results.upgradeChecks = '{"upgrade":true}';
assert.deepEqual(await (await send('/__upgrade')).json(), {upgrade:true});
results.upgradeChecks = failure;
await assert.rejects(send('/__upgrade'), error => error === failure);
environment.STORAGE.getByName = () => ({sqlChecks: async () => 'invalid-json'});
await assert.rejects((await send('/__sql')).json(), SyntaxError);
`,
  ));
