import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { capture, digest, jsonFile, repositoryRoot, withTemp, writeJson } from '../Support/cli.mts';
import { compileEvidence, compilerConfigDependencies } from '../Support/compile-evidence.mts';
import { hostCoverageArguments, otherCoverageArguments } from '../Support/coverage-inputs.mts';
import { applyScope, inventory, manifestEntries, measurement } from '../Support/coverage-scope.mts';
import { sourceSnapshot, verifiedFile } from '../Support/evidence-io.mts';
import { discoveryExecution, type Parent } from '../Support/haskell-contracts.mts';
import { hpcMetrics, reviewedGuards } from '../Support/hpc-report.mts';
import { parseMix, parseTix, successfulSummaries } from '../Support/hpc.mts';
import { hpcProof, validJavascriptProof } from '../Support/proof-inputs.mts';
import { javascriptEvidence, shellEvidence } from '../Support/runtime-evidence.mts';
import { canonicalV8, canonicalV8Files, validateV8Files } from '../Support/v8-queries.mts';
import { object } from '../Support/validation.mts';

function file(root: string, name: string, data: string): string {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  return path;
}

function repository(root: string): void {
  capture(['git', 'init', '--quiet', root]);
}

const xml = `<coverage><module name = "A">
  <exprs boxes="2" count="2"/><booleans boxes="3" count="3" true="1" false="1"/>
  <alts boxes="0" count="0"/></module></coverage>`;

void test('HPC counts only conditions with both true and false outcomes', () => {
  const metrics = hpcMetrics(xml).get('A');

  assert.deepEqual(metrics?.booleans, measurement(1, 3));
  assert.deepEqual(metrics?.alts, measurement(0, 0));
  assert.throws(
    () => hpcMetrics(xml.replace('<alts boxes="0" count="0"/>', '')),
    /Missing HPC metric/,
  );
  assert.throws(() => hpcMetrics(xml.replace('false="1"', 'false="5"')), /Invalid coverage count/);
});

for (const text of [
  'Tix []',
  'Tix [TixModule "A" 1 2 [0]]',
  'Tix [TixModule "A" 1 1 [1,]]',
  'Tix [TixModule "A" 1 1 [1]] garbage',
  'Tix [TixModule "../A" 1 1 [1]]',
  'Tix [TixModule "A" 1 1 [1],TixModule "A" 1 1 [2]]',
]) {
  void test(`HPC rejects malformed or ambiguous input ${text}`, () => {
    assert.throws(() => parseTix(text));
  });
}

void test('HPC keeps exact counters above the JavaScript safe integer range', () => {
  assert.equal(
    parseTix('Tix [TixModule "A" 1 1 [9007199254740993]]')[0].ticks[0],
    9007199254740993n,
  );
});

for (const [name, log] of [
  ['missing', ''],
  ['nonempty-success', 'Passed: 2\nFailed: 0\n'],
  ['empty', 'Passed: 0\nFailed: 0\n'],
  ['failed', 'Passed: 2\nFailed: 1\n'],
  ['duplicate', 'Passed: 2\nFailed: 0\nPassed: 3\nFailed: 0\n'],
]) {
  void test(`Host runner classifies the ${name} summary`, () => {
    assert.equal(successfulSummaries(log, 1), name === 'nonempty-success');
  });
}

void test('HPC keeps reactor variants separate except for identical component measurements', () => {
  withTemp('hpc-variants-', (root) => {
    repository(root);
    file(root, 'fixture.cabal', 'name: fixture\n');
    file(root, 'Main.hs', 'main = print (if True then 1 else 2)\n');
    const mix = file(
      root,
      'mix/Main.mix',
      `Mix "${join(root, 'Main.hs')}" 2026-09-07 07:50:58.313699322 UTC 2320970064 8 [(1:18-1:21,BinBox CondBinBox True),(1:18-1:21,BinBox CondBinBox False),(1:18-1:21,ExpBox False),(1:28-1:28,ExpBox True),(1:35-1:35,ExpBox True),(1:14-1:36,ExpBox False),(1:8-1:36,ExpBox False),(1:1-1:36,TopLevelBox ["main"])]`,
    );
    const left = file(
      root,
      'left.tix',
      'Tix [TixModule "fixture-1-inplace-test/Main" 2320970064 8 [1,0,1,1,0,1,1,1]]',
    );
    const right = file(
      root,
      'right.tix',
      'Tix [TixModule "fixture-1-inplace-test/Main" 2320970064 8 [0,2,1,0,1,1,1,1]]',
    );
    const output = join(root, 'report.json');
    const cli = [
      process.execPath,
      join(repositoryRoot, 'scripts/testing/coverage.mts'),
      '--root',
      root,
      '--output',
      output,
      '--report-only',
      '--tix',
      left,
      '--mix-dir',
      dirname(mix),
    ];

    capture([...cli, '--tix', right]);
    const report = object(jsonFile(output));
    assert.deepEqual(report.errors, []);
    assert.match(JSON.stringify(report.host_hpc), /"booleans":\{"covered":1,"total":1/);

    capture([...cli, '--wasm-tix', right, '--wasm-mix-dir', dirname(mix)]);
    const split = object(jsonFile(output));

    assert.deepEqual(split.errors, []);
    assert.match(JSON.stringify(split.host_hpc), /"booleans":\{"covered":0,"total":1/);
    assert.match(JSON.stringify(split.wasm_hpc), /"booleans":\{"covered":0,"total":1/);
  });
});

void test('verified constant guards remove only their impossible false condition', () => {
  withTemp('hpc-guards-', (root) => {
    repository(root);
    const path = file(root, 'A.hs', 'module A where\na | otherwise = True\n');
    const mix = parseMix(
      'Mix "A.hs" 2026-09-07 07:50:58 UTC 1 8 [(2:5-2:13,BinBox GuardBinBox True),(2:5-2:13,BinBox GuardBinBox False)]',
    );
    const source = inventory(root)[0];
    const scope = manifestEntries(
      {
        constant_guards: [
          {
            path: source.path,
            source_sha256: digest(path),
            guards: [{ span: [2, 5, 2, 13], token: 'otherwise' }],
          },
        ],
      },
      'constant_guards',
    );
    const original = hpcMetrics(xml).get('A');
    assert.ok(original);

    const report = reviewedGuards(root, source, mix, [2n, 0n], scope, original);

    assert.deepEqual(report.metrics.booleans, measurement(1, 2));
    assert.deepEqual(report.metrics.exprs, original.exprs);
    assert.equal(original.booleans.total, 3);
    assert.throws(
      () => reviewedGuards(root, source, mix, [2n, 1n], scope, original),
      /impossible outcome/,
    );
    assert.throws(
      () => reviewedGuards(root, source, mix, [2n], scope, original),
      /impossible outcome/,
    );
  });
});

function istanbul(path: string, counts: number[]): Record<string, unknown> {
  const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
  return {
    path,
    statementMap: { 0: location },
    s: { 0: 1 },
    fnMap: {},
    f: {},
    branchMap: { 0: { locations: [location, location] } },
    b: { 0: counts },
  };
}

void test('Istanbul can merge complementary branches with identical maps', () => {
  withTemp('istanbul-', (root) => {
    const source = file(
      root,
      'source.ts',
      'export const choose = (x: boolean): number => x ? 1 : 2;',
    );
    const left = join(root, 'left.json');
    const right = join(root, 'right.json');
    writeJson(left, { [source]: istanbul(source, [1, 0]) });
    writeJson(right, { [source]: istanbul(source, [0, 2]) });

    assert.equal(javascriptEvidence(root, [left])['source.ts'].complete, false);
    assert.equal(javascriptEvidence(root, [left, right])['source.ts'].complete, true);
  });
});

for (const [name, update] of [
  ['escaped path', { path: '../outside.ts' }],
  ['negative counter', { s: { 0: -1 } }],
  ['invalid counter shape', { s: { 0: [1] } }],
  ['mismatched map keys', { s: { 1: 2 } }],
  ['wrong branch arity', { b: { 0: [1] } }],
  ['boolean counter', { b: { 0: [true, 0] } }],
] as const) {
  void test(`Istanbul rejects ${name}`, () => {
    withTemp('istanbul-', (root) => {
      const path = join(root, 'report.json');
      writeJson(path, { 'A.ts': { ...istanbul('A.ts', [1, 1]), ...update } });

      assert.throws(() => javascriptEvidence(root, [path]));
    });
  });
}

void test('Istanbul rejects incompatible instrumentation even when both reports alone are valid', () => {
  withTemp('istanbul-map-', (root) => {
    const r1 = join(root, 'first.json');
    const r2 = join(root, 'second.json');
    writeJson(r1, { 'A.ts': istanbul('A.ts', [1, 1]) });
    writeJson(r2, {
      'A.ts': { ...istanbul('A.ts', [1, 1]), statementMap: { 0: { start: { line: 2 } } } },
    });

    assert.throws(() => javascriptEvidence(root, [r1, r2]), /different Istanbul instrumentation/);
  });
});

void test('shell line evidence keeps unmeasured branch completeness distinct', () => {
  withTemp('shell-evidence-', (root) => {
    const source = file(root, 'build.sh', '#!/bin/bash\ntrue\n');
    const report = join(root, 'kcov.json');
    const line = { sha256: digest(source), lines: { 2: 1 }, branch_coverage: false };
    const payload = {
      schema: 1,
      collector: { name: 'kcov', version: 'kcov 1' },
      files: { 'build.sh': line },
    };
    writeJson(report, payload);

    const result = shellEvidence(root, report)['build.sh'];

    assert.equal(result.complete, false);
    assert.deepEqual(result.metrics?.lines, measurement(1, 1));
    for (const changed of [
      { branch_coverage: true },
      { lines: { '02': 1 } },
      { lines: { 3: 1 } },
      { lines: { 2: -1 } },
      { sha256: 'old' },
    ]) {
      writeJson(report, { ...payload, files: { 'build.sh': { ...line, ...changed } } });
      assert.throws(() => shellEvidence(root, report));
    }
  });
});

void test('compiler evidence requires a reviewed input, configuration chain and success', () => {
  withTemp('compile-evidence-', (root) => {
    repository(root);
    file(root, 'types.d.ts', 'declare const good: string;\n');
    const config = file(root, 'tsconfig.json', '{"extends":"./base"}');
    file(root, 'base.json', '{}');
    const sources = inventory(root);
    applyScope(root, sources, {
      validations: [
        { path: 'types.d.ts', kind: 'declaration', reason: 'ambient', evidence: 'tsconfig.json' },
      ],
    });
    const proof = join(root, 'artifacts/proof.json');
    const compile = {
      argv: ['tsc', '--project', 'tsconfig.json'],
      cwd: '.',
      exitCode: 0,
      inputs: ['types.d.ts'],
    };
    const data = {
      sources: sourceSnapshot(root),
      commands: [compile],
      errors: [],
      exit_code: 0,
      validated: [{ path: 'types.d.ts', kind: 'declaration', commandIndex: 0 }],
    };
    writeJson(proof, data);

    assert.equal(compileEvidence(root, sources, proof)['types.d.ts'].status, 'validated');
    for (const patch of [
      { exit_code: true },
      { commands: [{ ...compile, inputs: [] }] },
      { commands: [{ ...compile, argv: ['tsc'] }] },
      { sources: { 'types.d.ts': data.sources['types.d.ts'] } },
    ]) {
      writeJson(proof, { ...data, ...patch });
      assert.throws(() => compileEvidence(root, sources, proof));
    }

    writeFileSync(config, '{"extends":"./tsconfig.json"}');
    assert.throws(() => compilerConfigDependencies(root, compile), /cycle/);
  });
});

void test('readers reject evidence paths that escape via traversal or a symlink', () => {
  withTemp('proof-boundary-', (root) => {
    const path = file(root, 'outside.json', '{}');
    const evidence = join(root, 'evidence');
    mkdirSync(evidence);
    symlinkSync(path, join(evidence, 'linked.json'));

    assert.throws(() => verifiedFile(evidence, '../outside.json', digest(path)), /escapes/);
    assert.throws(() => verifiedFile(evidence, 'linked.json', digest(path)), /escapes/);
  });
});

void test('JS report proof is bound to the source snapshot and report bytes', () => {
  withTemp('js-proof-', (root) => {
    const report = file(root, 'coverage.json', '{}');
    const path = join(root, 'proof.json');
    const sources = { 'script.mts': 'current' };
    writeJson(path, { exit_code: 0, sources, sha256: digest(report) });

    assert.equal(validJavascriptProof(report, path, sources), true);
    assert.equal(validJavascriptProof(report, path, { 'script.mts': 'changed' }), false);

    writeFileSync(report, '{"stale":true}');

    assert.equal(validJavascriptProof(report, path, sources), false);
  });
});

void test('Host proof rejects altered logs, extra maps and changed source snapshots', () => {
  withTemp('host-proof-', (root) => {
    const dir = join(root, 'proof');
    const executable = file(root, 'ghc', 'compiler fixture');
    const sources = { 'A.hs': 'sha256' };
    const log = file(dir, 'build.log', '');
    const version = file(dir, 'compiler.log', '9.14.1\n');
    const ticks = file(dir, 'suite.tix', 'tix');
    const map = file(dir, 'mix/A.mix', 'mix');
    const data = {
      sources,
      exit_code: 0,
      errors: [],
      compiler: { path: executable, sha256: digest(executable), version: '9.14.1' },
      commands: [
        {
          command: ['cabal', 'build', '--with-compiler=' + executable],
          exitCode: 0,
          log: 'build.log',
          logSha256: digest(log),
        },
        {
          command: [executable, '--numeric-version'],
          exitCode: 0,
          log: 'compiler.log',
          logSha256: digest(version),
        },
      ],
      snapshots: { 'suite.tix': digest(ticks) },
      mixFiles: { 'mix/A.mix': digest(map) },
    };
    const path = join(dir, 'proof.json');
    writeJson(path, data);

    assert.ok(hpcProof(root, path, sources, 'host').artifacts.has(ticks));
    assert.ok(hostCoverageArguments(root, path, sources).includes('--host-proof'));
    assert.deepEqual(hostCoverageArguments(root, path, { 'A.hs': 'new' }), []);

    writeFileSync(log, 'modified');
    assert.throws(() => hpcProof(root, path, sources, 'host'), /digest changed/);

    writeFileSync(log, '');
    file(dir, 'mix/extra.mix', 'extra');
    assert.throws(() => hpcProof(root, path, sources, 'host'), /Unlisted/);
  });
});

void test('aggregate ignores optional shell and compiler pointers outside the repository', () => {
  withTemp('outside-pointers-', (directory) => {
    const root = join(directory, 'repo');
    const external = file(directory, 'outside.json', '{}');
    const sha256 = digest(external);
    writeJson(join(root, 'artifacts/testing/compile-validation-latest.json'), {
      proof: external,
      sha256,
    });
    writeJson(join(root, 'artifacts/testing/shell-coverage-latest.json'), {
      report: external,
      sha256,
    });

    assert.deepEqual(otherCoverageArguments(root, {}), []);
  });
});

void test('discovery proof requires a single exact suite and positive passed count', () => {
  withTemp('discovery-proof-', (root) => {
    const target = 'testkit:test:unit';
    const commands = [
      {
        command: ['cabal', 'list-bin', target],
        log: 'binary.log',
        logSha256: digest(file(root, 'binary.log', '/fixture/suite\n')),
      },
      {
        command: ['/fixture/suite'],
        log: 'run.log',
        logSha256: digest(file(root, 'run.log', 'Passed: 3\nFailed: 0\n')),
      },
    ];
    const parent: Parent = {
      path: join(root, 'proof.json'),
      data: {},
      executable: 'ghc',
      cabal: 'cabal',
      commands,
    };

    assert.equal(discoveryExecution(parent, target).passed, 3);
    assert.throws(() => discoveryExecution(parent, 'other:test:unit'), /no unique component/);

    writeFileSync(join(root, 'run.log'), 'Passed: 0\nFailed: 0\n');
    commands[1].logSha256 = digest(join(root, 'run.log'));

    assert.throws(() => discoveryExecution(parent, target), /nonempty/);
  });
});

void test('V8 canonicalization records and replays only a source-matched contract query', () => {
  withTemp('v8-proof-', (root) => {
    const script = file(root, 'config.mts', 'export const configured = true;');
    const url = pathToFileURL(script).href;
    const report = {
      result: [
        { url: url + '?contract=success', functions: [{ ranges: [{ count: 3 }] }] },
        { url: url + '?other=success', functions: [] },
        { url: 'test-boundary:service', functions: [] },
      ],
    };
    const sources = { 'config.mts': digest(script) };
    const eligible = new Set(['config.mts']);
    const raw = join(root, 'raw');
    writeJson(join(raw, 'coverage.json'), report);

    const records = canonicalV8Files(root, raw, join(root, 'canonical'), sources, eligible);
    validateV8Files(root, root, sources, eligible, records);

    const { report: normalized, rewrites } = canonicalV8(root, report, sources, eligible);
    assert.deepEqual(normalized.result, [{ ...report.result[0], url }, ...report.result.slice(1)]);
    assert.equal(rewrites.length, 1);
    assert.ok(report.result[0].url.includes('?'));
    writeFileSync(script, 'export const configured = false;');

    assert.throws(
      () => validateV8Files(root, root, sources, eligible, records),
      /differs from the recorded source/,
    );
  });
});
