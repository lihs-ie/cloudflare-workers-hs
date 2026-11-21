import { jsonObject, jsonSequence, jsonString } from '../Support/json.mts';
import { z } from 'zod';
import {
  jsonValue,
  manifestSchema,
  snapshotSchema,
  coverageEntrySchema,
} from '../Support/coverage-schema.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { instrumentConfig } from '../Support/workerd_js.mts';
const root = fileURLToPath(new URL('../../..', import.meta.url));

void test('normal configuration is returned without reading or changing the file', async () => {
  const previous = process.env.WORKERD_JS_COVERAGE_ENDPOINT;
  delete process.env.WORKERD_JS_COVERAGE_ENDPOINT;
  try {
    const result = await instrumentConfig('not-a-real-config.json');
    assert.equal(result.config, 'not-a-real-config.json');
    await result.close();
  } finally {
    if (previous !== undefined) {
      process.env.WORKERD_JS_COVERAGE_ENDPOINT = previous;
    }
  }
});

void test('instrumented artifacts retain source maps, remap zero coverage, and reject map mismatches', async () => {
  const directory = await mkdtemp(path.join(root, 'artifacts/testing/js-helper-test-'));
  const previous = {
    endpoint: process.env.WORKERD_JS_COVERAGE_ENDPOINT,
    directory: process.env.WORKERD_JS_COVERAGE_DIRECTORY,
  };
  process.env.WORKERD_JS_COVERAGE_ENDPOINT = 'http://127.0.0.1:1/unused';
  process.env.WORKERD_JS_COVERAGE_DIRECTORY = directory;
  const fixture = await mkdtemp(path.join(root, 'examples/minimal/.dev-test-instrument-'));
  let instrumented;
  try {
    const original = path.join(fixture, 'wrangler.json');
    await writeFile(path.join(fixture, 'value.ts'), 'export const value = 7;\n');
    await writeFile(
      path.join(fixture, 'entry.ts'),
      "import { value } from './value.ts'; export default { fetch() { return new Response(String(value)); } };\n",
    );
    await writeFile(original, JSON.stringify({ name: 'fixture', main: 'entry.ts' }));
    const before = await readFile(original, 'utf8');
    instrumented = await instrumentConfig(original);
    assert.equal(await readFile(original, 'utf8'), before);
    const config = jsonValue(await readFile(instrumented.config, 'utf8'));
    assert.ok(jsonString(jsonObject(config).main).startsWith(directory));
    assert.equal(jsonObject(config).build, undefined);
    const bundle = path.dirname(jsonString(jsonObject(config).main));
    const manifest = manifestSchema.parse(
      jsonValue(await readFile(path.join(bundle, 'manifest.json'), 'utf8')),
    );
    assert.equal(Object.keys(manifest).length, 2);
    for (const entry of Object.values(manifest)) {
      assert.match(entry.sha256, /^[a-f0-9]{64}$/);
      assert.ok(
        entry.coverage.inputSourceMap &&
          z
            .object({ sources: z.array(z.string()) })
            .parse(entry.coverage.inputSourceMap)
            .sources.every((source: string) => source.endsWith('.ts')),
      );
    }
    const snapshots = path.join(directory, 'snapshots');
    await mkdir(snapshots);
    const reportCommand = [
      path.join(root, 'scripts/testing/Support/workerd_js_report.mts'),
      directory,
    ];
    let result = spawnSync(process.execPath, reportCommand, {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = z
      .record(z.string(), z.object({ s: z.record(z.string(), z.number()) }))
      .parse(jsonValue(await readFile(path.join(directory, 'coverage-final.json'), 'utf8')));
    assert.equal(Object.keys(report).length, 2);
    assert.ok(
      Object.values(report).every((entry) => Object.values(entry.s).every((count) => count === 0)),
    );
    const coverage = Object.fromEntries(
      Object.entries(manifest).map(([name, entry]) => [name, entry.coverage]),
    );
    await writeFile(path.join(snapshots, 'snapshot.json'), JSON.stringify({ coverage }));
    result = spawnSync(process.execPath, reportCommand, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const first = Object.values(coverage)[0];
    first.statementMap[Object.keys(first.statementMap)[0]].start.line += 1;
    await writeFile(path.join(snapshots, 'snapshot.json'), JSON.stringify({ coverage }));
    result = spawnSync(process.execPath, reportCommand, { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Instrumentation mismatch/);
    process.env.WORKERD_JS_COVERAGE_DIRECTORY = path.dirname(root);
    await assert.rejects(instrumentConfig(original), /Coverage output must be in artifacts/);
    const outside = path.join(directory, 'outside.json');
    await writeFile(
      outside,
      JSON.stringify({
        main: path.join(root, 'scripts/testing/Support/workerd_js.mts'),
      }),
    );
    await assert.rejects(instrumentConfig(outside), /Coverage entry must belong/);
  } finally {
    await instrumented?.close();
    await rm(fixture, { recursive: true, force: true });

    if (instrumented) {
      await assert.rejects(access(instrumented.config), { code: 'ENOENT' });
    }

    for (const [key, value] of [
      ['WORKERD_JS_COVERAGE_ENDPOINT', previous.endpoint],
      ['WORKERD_JS_COVERAGE_DIRECTORY', previous.directory],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

void test('scope boundaries, declarations, named exports and missing rules are handled explicitly', async () => {
  const directory = await mkdtemp(path.join(root, 'artifacts/testing/js-helper-test-'));
  const fixture = path.join(root, 'examples/minimal', `.dev-test-js-helper-${process.pid}`);
  const external = path.join(
    root,
    'examples/static-assets',
    `.dev-test-js-helper-${process.pid}.ts`,
  );
  const saved = process.env;
  process.env = {
    ...saved,
    WORKERD_JS_COVERAGE_ENDPOINT: 'http://127.0.0.1:1/unused',
    WORKERD_JS_COVERAGE_DIRECTORY: directory,
  };
  let compiled;
  try {
    await mkdir(fixture);
    await writeFile(external, 'export const value = 7;');
    await writeFile(
      path.join(fixture, 'types.d.ts'),
      'export interface OnlyAType { value: string };',
    );
    const entry = path.join(fixture, 'entry.ts');
    await writeFile(
      entry,
      `import { value } from ${JSON.stringify(external)}; import './types.d.ts'; export class Room { fetch() {return value;} } export default {fetch(){return value;}};`,
    );
    const config = path.join(fixture, 'wrangler.json');
    await writeFile(config, JSON.stringify({ name: 'fixture', main: 'entry.ts' }));
    compiled = await instrumentConfig(config, 'entry.ts');
    const result = jsonValue(await readFile(compiled.config, 'utf8'));
    const manifest = manifestSchema.parse(
      jsonValue(
        await readFile(
          path.join(path.dirname(jsonString(jsonObject(result).main)), 'manifest.json'),
          'utf8',
        ),
      ),
    );
    assert.deepEqual(Object.keys(manifest), [entry]);
    assert.match(
      await readFile(jsonString(jsonObject(result).main), 'utf8'),
      /export const Room=wrapClass/,
    );
    assert.equal(jsonSequence(jsonObject(result).rules).length, 1);
    await writeFile(entry, "const value=1;export {value as 'not-valid'};");
    await assert.rejects(instrumentConfig(config), /Unsupported export name/);
  } finally {
    await compiled?.close();
    process.env = saved;
    await rm(fixture, { recursive: true, force: true });
    await rm(external, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

void test('successful contracts restore preexisting coverage environment in an isolated process', () => {
  const endpoint = 'http://127.0.0.1:1/preexisting';
  const directory = 'preexisting-coverage-directory';
  const check = `
    import { after } from 'node:test';
    import assert from 'node:assert/strict';
    after(() => {
      assert.equal(process.env.WORKERD_JS_COVERAGE_ENDPOINT, ${JSON.stringify(endpoint)});
      assert.equal(process.env.WORKERD_JS_COVERAGE_DIRECTORY, ${JSON.stringify(directory)});
    });
  `;
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    WORKERD_JS_COVERAGE_ENDPOINT: endpoint,
    WORKERD_JS_COVERAGE_DIRECTORY: directory,
  };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(check)}`,
      '--test',
      '--test-name-pattern=normal configuration|instrumented artifacts|scope boundaries',
      fileURLToPath(import.meta.url),
    ],
    {
      encoding: 'utf8',
      timeout: 60000,
      env: childEnvironment,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /pass 3/);
});
