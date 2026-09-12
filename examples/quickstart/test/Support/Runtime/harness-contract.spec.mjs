import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The actual TypeScript harness runs; only its WASM/reactor/platform boundary
// is substituted. Production WASM behavior remains the integration suite's job.
const harness = new URL("./harness.ts", import.meta.url).href;
const loader = `
import { registerHooks } from 'node:module';
const modules = {
'cloudflare:workers': 'export class DurableObject { constructor(ctx) { this.ctx = ctx; } }',
'@cloudflare-workers-hs/runtime': 'export const createReactor = async (wasm, imports, bind) => bind({}); export const bindExport = (table, name, decode) => async (...args) => { globalThis.calls.push([name, ...args]); return decode(globalThis.results[name]); }; export const decodeString = value => value; export const decodeResponse = value => value;',
'../../../worker/runtime-tests-jsffi.mjs': 'export default function imports() {}',
'../../../worker/runtime-tests.wasm': 'export default {};'
};
registerHooks({ resolve(specifier, context, next) {
  const source = modules[specifier];
  if (source !== undefined) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  return next(specifier, context);
}});
`;
function run(t, code) {
  const directory = mkdtempSync(join(tmpdir(), "runtime-harness-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "loader.mjs");
  writeFileSync(path, loader);
  const prefix = `import assert from 'node:assert/strict'; globalThis.calls = []; globalThis.results = {}; const harness = await import(${JSON.stringify(harness)});\n`;
  const result = spawnSync(
    process.execPath,
    ["--import", path, "--input-type=module"],
    { input: prefix + code, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
}

test("context bridges forward their arguments and reject non-ok results", (t) =>
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

test("storage harness maps supported return forms and rejects unexpected results", (t) =>
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

test("probe decoders reject malformed arrays and non-stream exports", (t) =>
  run(
    t,
    `
for (const name of ['socketProbe', 'streamProbe']) {
  for (const raw of ['{}', '[1]', 'null', 'not-json']) {
    results[name] = raw;
    await assert.rejects(harness[name]({}, 'read', '2'));
  }
  results[name] = '["first","second"]';
  assert.deepEqual(await harness[name]({}, 'read', '2'), ['first', 'second']);
}
results.producerProbe = {};
await assert.rejects(harness.producerProbe({}), /Expected stream/);
results.producerProbe = new ReadableStream({ start(controller) { controller.close(); } });
assert.equal(await harness.producerProbe({}), results.producerProbe);
`,
  ));

test("HTTP harness translates request bodies and preserves the fallback response", (t) =>
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

test("new codec and storage probes preserve their command and returned result", (t) =>
  run(
    t,
    `
for (const name of ['exportRequestCodecProbe', 'storagePublicContractsProbe']) {
  results[name] = 'contract result';
  assert.equal(await harness[name]('negative-case'), 'contract result');
  assert.deepEqual(calls.at(-1), [name, 'negative-case']);
}
`,
  ));

test("transport probes validate native request and list exports at their boundary", (t) =>
  run(
    t,
    `
const source = {};
const request = new Request('https://transport.test/path');
results.transportRequestExtra = request;
assert.equal(await harness.transportRequestExtra(source, 'request'), request);
assert.deepEqual(calls.at(-1), ['transportRequestExtra', source, 'request']);
for (const invalid of [null, {}, new Response('wrong kind')]) {
  results.transportRequestExtra = invalid;
  await assert.rejects(harness.transportRequestExtra(source, 'request'), /Expected native Request/);
}
results.transportExtraProbe = '["received"]';
assert.deepEqual(await harness.transportExtraProbe(source, 'read'), ['received']);
assert.deepEqual(calls.at(-1), ['transportExtraProbe', source, 'read']);
results.transportExtraProbe = '{}';
await assert.rejects(harness.transportExtraProbe(source, 'read'));
`,
  ));

test("prepared query probe rejects malformed result shapes before returning typed fields", (t) =>
  run(
    t,
    `
const database = {};
results.quickstartDatabasePreparedProbe = '{"label":"prepared","count":2,"extra":"ignored"}';
assert.deepEqual(await harness.quickstartDatabasePreparedProbe(database), {label:'prepared',count:2});
assert.deepEqual(calls.at(-1), ['quickstartDatabasePreparedProbe', database]);
for (const raw of ['42', 'null', '{}', '{"label":7}', '{"label":"ok"}', '{"label":"ok","count":"two"}']) {
  results.quickstartDatabasePreparedProbe = raw;
  await assert.rejects(harness.quickstartDatabasePreparedProbe(database), /Expected prepared query result/);
}
results.quickstartDatabasePreparedProbe = '{broken';
await assert.rejects(harness.quickstartDatabasePreparedProbe(database), SyntaxError);
`,
  ));

test("export producer probe forwards every scenario without changing its JSON result", (t) =>
  run(
    t,
    `
for (const command of ['header-cancel', 'page-cancel', 'complete', 'reader-failure']) {
  const result = JSON.stringify({command, observed:true});
  results.exportProducerProbe = result;
  assert.equal(await harness.exportProducerProbe(command), result);
  assert.deepEqual(calls.at(-1), ['exportProducerProbe', command]);
}
`,
  ));
