import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The actual TypeScript harness runs; only its WASM/reactor/platform boundary
// is substituted. Production WASM behavior remains the integration suite's job.
const harness = new URL('./harness.ts', import.meta.url).href;
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

void test('export request codec preserves its command and returned result', (t) =>
  run(
    t,
    `
for (const name of ['exportRequestCodecProbe']) {
  results[name] = 'contract result';
  assert.equal(await harness[name]('negative-case'), 'contract result');
  assert.deepEqual(calls.at(-1), [name, 'negative-case']);
}
`,
  ));

void test('prepared query probe rejects malformed result shapes before returning typed fields', (t) =>
  run(
    t,
    `
const database = {};
results.urlShortenerDatabasePreparedProbe = '{"label":"prepared","count":2,"extra":"ignored"}';
assert.deepEqual(await harness.urlShortenerDatabasePreparedProbe(database), {label:'prepared',count:2});
assert.deepEqual(calls.at(-1), ['urlShortenerDatabasePreparedProbe', database]);
for (const raw of ['42', 'null', '{}', '{"label":7}', '{"label":"ok"}', '{"label":"ok","count":"two"}']) {
  results.urlShortenerDatabasePreparedProbe = raw;
  await assert.rejects(harness.urlShortenerDatabasePreparedProbe(database), /Expected prepared query result/);
}
results.urlShortenerDatabasePreparedProbe = '{broken';
await assert.rejects(harness.urlShortenerDatabasePreparedProbe(database), SyntaxError);
`,
  ));

void test('export producer probe forwards every scenario without changing its JSON result', (t) =>
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
