import { jsonObject } from '../Support/json.mts';
import { z } from 'zod';
import {
  jsonValue,
  manifestSchema,
  snapshotSchema,
  coverageEntrySchema,
} from '../Support/coverage-schema.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  instrumentTypeScript,
  instrumentationIdentity,
} from '../Support/shared_js_instrumentation.mts';
const root = fileURLToPath(new URL('../../..', import.meta.url));
void test('Node executes the same instrumented maps as workerd and preserves resolving doubles', (t) => {
  const directory = mkdtempSync(path.join(root, 'examples/.shared-coverage-'));
  const output = mkdtempSync(path.join(tmpdir(), 'shared-coverage-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'probe.ts');
  const source =
    'import { value } from "platform:test"; export function choose(flag: boolean) { if (flag) { return value; } return 0; }';
  writeFileSync(filename, source);
  const nodeFilename = path.join(directory, 'node-only.mts');
  writeFileSync(nodeFilename, 'export const value: number = 1;');
  const code = `import { registerHooks } from 'node:module'; registerHooks({resolve(s,c,n) { if(s==='platform:test') { return {url:'data:text/javascript,export const value=42',shortCircuit:true}; } if(s.startsWith('.') && !s.endsWith('.ts')) { return n(s+'.ts',c); } return n(s,c); }}); await import(${JSON.stringify(nodeFilename)}); const m=await import(${JSON.stringify(filename)}); if(m.choose(true)!==42) { throw Error('bad result'); }`;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(root, 'scripts/testing/Support/node_shared_coverage.mts'),
      '--input-type=module',
      '-e',
      code,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARED_JS_COVERAGE_DIRECTORY: output,
        SHARED_JS_COVERAGE_INPUTS: '',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const bundles = readdirSync(path.join(output, 'bundles'));
  assert.equal(bundles.length, 1);
  const manifest = manifestSchema.parse(
    jsonValue(readFileSync(path.join(output, 'bundles', bundles[0], 'manifest.json'))),
  );
  assert.deepEqual(
    manifest[filename],
    jsonValue(JSON.stringify(instrumentTypeScript(source, filename).manifest)),
  );
  assert.equal(manifest[nodeFilename], undefined);
  assert.equal(manifest[filename].instrumentation, instrumentationIdentity);
  const raw = snapshotSchema.parse(
    jsonValue(
      readFileSync(path.join(output, 'snapshots', readdirSync(path.join(output, 'snapshots'))[0])),
    ),
  ).coverage[filename];
  assert.deepEqual(raw.statementMap, manifest[filename].coverage.statementMap);
  assert.deepEqual(raw.branchMap, manifest[filename].coverage.branchMap);
  assert.ok(Object.values(raw.s).some((count) => count > 0));
  assert.ok(Object.values(raw.b).some((counts) => counts.includes(0)));
});
void test('Node records separate process snapshots and skips substituted TypeScript', (t) => {
  const directory = mkdtempSync(path.join(root, 'examples/.shared-coverage-'));
  const output = mkdtempSync(path.join(tmpdir(), 'shared-coverage-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'probe.ts');
  writeFileSync(filename, 'export const value: number = 42;');
  const preload = path.join(root, 'scripts/testing/Support/node_shared_coverage.mts');
  for (let iteration = 0; iteration < 2; iteration++) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(filename)});`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          SHARED_JS_COVERAGE_DIRECTORY: output,
          SHARED_JS_COVERAGE_INPUTS: '',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readdirSync(path.join(output, 'bundles')).length, 2);
  assert.equal(readdirSync(path.join(output, 'snapshots')).length, 2);
  const mockLoader = path.join(directory, 'mock.mjs');
  writeFileSync(
    mockLoader,
    `import {registerHooks} from 'node:module'; registerHooks({load(u,c,n) { if(u.endsWith('probe.ts')) {return {format:'module',source:'export const value=7',shortCircuit:true};} return n(u,c); }});`,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      mockLoader,
      '--import',
      preload,
      '--input-type=module',
      '-e',
      `const m=await import(${JSON.stringify(filename)}); if(m.value!==7) {throw Error('mock lost');}`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARED_JS_COVERAGE_DIRECTORY: output,
        SHARED_JS_COVERAGE_INPUTS: '',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifests = readdirSync(path.join(output, 'bundles')).map((name) =>
    jsonValue(readFileSync(path.join(output, 'bundles', name, 'manifest.json'))),
  );
  assert.equal(
    manifests.filter((manifest) => Object.hasOwn(jsonObject(manifest), filename)).length,
    2,
    'the substituted TypeScript is never recorded as authored execution',
  );
});

void test('JS and TS query imports retain original maps and combine both real outcomes', (t) => {
  const directory = mkdtempSync(path.join(root, 'examples/.shared-coverage-'));
  const output = mkdtempSync(path.join(tmpdir(), 'shared-coverage-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  });
  const files = ['probe.js', 'probe.ts'].map((name) => path.join(directory, name));
  const source =
    'import { basename } from "node:path"; export function choose(flag) { if (flag) { return basename("value"); } return "fallback"; }';
  for (const filename of files) {
    writeFileSync(filename, source);
  }
  const inputs = path.join(output, 'inputs.json');
  writeFileSync(inputs, JSON.stringify(files.map((filename) => path.relative(root, filename))));
  const omitted = path.join(directory, 'omitted.js');
  writeFileSync(omitted, 'export const value = 1;');
  const code = `import { moduleBoundary } from ${JSON.stringify(new URL('../Support/module-boundaries.mts', import.meta.url).href)}; const boundary = moduleBoundary('node:path', { namedExports: { basename: value => 'boundary:' + value }}); try { for(const filename of ${JSON.stringify(files)}) { const a = await import(filename + '?case=short'); const b = await import(filename + '?case=a-much-longer-query'); if(a.choose(true) !== 'boundary:value' || b.choose(false) !== 'fallback') { throw Error('wrong behavior'); } } await import(${JSON.stringify(omitted)}); } finally { boundary.restore(); }`;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(root, 'scripts/testing/Support/node_shared_coverage.mts'),
      '--input-type=module',
      '-e',
      code,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARED_JS_COVERAGE_DIRECTORY: output,
        SHARED_JS_COVERAGE_INPUTS: inputs,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = manifestSchema.parse(
    jsonValue(
      readFileSync(
        path.join(output, 'bundles', readdirSync(path.join(output, 'bundles'))[0], 'manifest.json'),
      ),
    ),
  );
  assert.deepEqual(Object.keys(manifest).sort(), files.sort());
  const raw = snapshotSchema.parse(
    jsonValue(
      readFileSync(path.join(output, 'snapshots', readdirSync(path.join(output, 'snapshots'))[0])),
    ),
  ).coverage;
  for (const filename of files) {
    assert.deepEqual(
      manifest[filename],
      jsonValue(JSON.stringify(instrumentTypeScript(source, filename).manifest)),
    );
    assert.ok(Object.values(raw[filename].s).every((count) => count > 0));
    assert.ok(Object.values(raw[filename].f).every((count) => count > 0));
    assert.ok(
      Object.values(raw[filename].b)
        .flat()
        .every((count) => count > 0),
    );
  }
});

void test('lost coverage state stays empty evidence rather than successful counters', (t) => {
  const directory = mkdtempSync(path.join(root, 'examples/.shared-coverage-'));
  const output = mkdtempSync(path.join(tmpdir(), 'shared-coverage-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'lost.ts');
  writeFileSync(filename, 'export const value = 42;');
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(root, 'scripts/testing/Support/node_shared_coverage.mts'),
      '--input-type=module',
      '-e',
      `const module = await import(${JSON.stringify(filename)}); if(module.value !== 42) { throw Error('execution missing'); } delete globalThis.__workerdCoverage__;`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        SHARED_JS_COVERAGE_DIRECTORY: output,
        SHARED_JS_COVERAGE_INPUTS: '',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = manifestSchema.parse(
    jsonValue(
      readFileSync(
        path.join(output, 'bundles', readdirSync(path.join(output, 'bundles'))[0], 'manifest.json'),
      ),
    ),
  );
  assert.ok(Object.hasOwn(manifest, filename));
  const snapshot = jsonValue(
    readFileSync(path.join(output, 'snapshots', readdirSync(path.join(output, 'snapshots'))[0])),
  );
  assert.deepEqual(jsonObject(snapshot).coverage, {});
});

void test('a CommonJS loader without source bytes does not claim authored execution', (t) => {
  const directory = mkdtempSync(path.join(root, 'examples/.shared-coverage-'));
  const output = mkdtempSync(path.join(tmpdir(), 'shared-coverage-'));
  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  const filename = path.join(directory, 'opaque.ts');
  writeFileSync(filename, 'module.exports = { value: 42 };');
  const loader = path.join(output, 'loader.mjs');
  writeFileSync(
    loader,
    `import { registerHooks } from 'node:module'; registerHooks({load(url,context,next) { if(url === ${JSON.stringify(pathToFileURL(filename).href)}) {return {format:'commonjs',source:null,shortCircuit:true};} return next(url,context); }});`,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      loader,
      '--import',
      path.join(root, 'scripts/testing/Support/node_shared_coverage.mts'),
      '--input-type=module',
      '-e',
      `const module = await import(${JSON.stringify(filename)}); if(module.default.value !== 42) { throw Error('loader boundary changed'); }`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        SHARED_JS_COVERAGE_DIRECTORY: output,
        SHARED_JS_COVERAGE_INPUTS: '',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readdirSync(output).includes('bundles'),
    false,
    'opaque loader output cannot be authenticated as authored execution',
  );
});
