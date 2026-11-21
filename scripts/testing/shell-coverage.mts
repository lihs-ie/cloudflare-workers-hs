import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  digest,
  files,
  isFile,
  repositoryRoot,
  runCli,
  textFile,
  within,
  writeJson,
} from './Support/cli.mts';
import { loggedCommand } from './Support/evidence-io.mts';
import { shellToolDoubles } from './Support/shell-fixtures.mts';

const root = repositoryRoot;
const kcov = 'kcov/kcov@sha256:481289ae32e55e5b733019515acd10948a4f76dfed381765577db909664fc603';
const scripts = [
  'examples/url-shortener/scripts/build-wasm.sh',
  ...['api-catalog', 'minimal', 'static-assets', 'realtime', 'workflows', 'queued-jobs'].map(
    (name) => `examples/${name}/scripts/build.sh`,
  ),
  'tests/runtime/scripts/build.sh',
];
const homeOnly = new Set(['api-catalog', 'workflows', 'queued-jobs', 'runtime']);
const fixtures = new Set(['api-catalog', 'realtime', 'workflows', 'queued-jobs']);
const failures = new Map([
  ['build-failure', 42],
  ['capture', 45],
  ['list-bin', 43],
  ['post-link', 44],
  ['write', 46],
  ['invalid-target', 2],
]);

interface ScriptCase {
  identifier: string;
  source: string;
  mode: string;
  expected: number;
}

export function shellCases(): ScriptCase[] {
  return scripts.flatMap((source, index) => {
    const inHome = homeOnly.has(source.split('/')[1]);
    const modes = [
      'direct',
      'home',
      'missing',
      'build-failure',
      'override',
      'capture',
      'list-bin',
      'post-link',
      'write',
    ];

    if (!inHome) {
      modes.push('opt');
    }

    if (index === 0) {
      modes.push('runtime-tests', 'invalid-target');
    }

    const missingCompilerExit = inHome ? 1 : 127;
    return modes.map((mode) => ({
      identifier: `${index}-${mode}`,
      source,
      mode,
      expected: failures.get(mode) ?? (mode === 'missing' ? missingCompilerExit : 0),
    }));
  });
}

function runCaseScript(test: ScriptCase): string[] {
  const { identifier, mode, source } = test;
  const directory = '/work/cases/' + identifier;
  const commands = [
    `mkdir -p ${directory}/home ${directory}/tmp`,
    'rm -f /opt/ghc-wasm/env',
    `export HOME=${directory}/home TMPDIR=${directory}/tmp CALL_LOG=${directory}/calls.log`,
    'export PATH=/work/base:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'unset FAIL_BUILD FAIL_STAGE WASM_BUILD_DIR WASM_PROJECT_FILE',
  ];

  if (mode === 'home' || mode === 'opt') {
    const config = mode === 'home' ? '$HOME/.ghc-wasm/env' : '/opt/ghc-wasm/env';
    commands.push('mkdir -p "$HOME/.ghc-wasm"', `echo 'export PATH=/work/tools:$PATH' > ${config}`);
  } else if (mode !== 'missing') {
    commands.push('export PATH=/work/tools:$PATH');
  }

  const settings = new Map([
    ['build-failure', 'export FAIL_BUILD=1'],
    ['override', 'export WASM_BUILD_DIR=custom-build WASM_PROJECT_FILE=custom.project'],
    ...['capture', 'list-bin', 'post-link', 'write'].map((key): [string, string] => [
      key,
      'export FAIL_STAGE=' + key,
    ]),
  ]);
  const setting = settings.get(mode);
  if (setting !== undefined) {
    commands.push(setting);
  }

  const argument =
    new Map([
      ['runtime-tests', ' runtime-tests'],
      ['invalid-target', ' invalid'],
    ]).get(mode) ?? '';
  const script = '/work/repo/' + source;
  commands.push(
    'set +e',
    `kcov --include-path=${script} ${directory}/kcov ${script}${argument} > ${directory}/output.log 2>&1`,
    `echo $? > ${directory}/returncode`,
    'set -e',
  );
  return commands;
}

function prepare(work: string, tests: ScriptCase[]): void {
  for (const source of scripts) {
    const file = join(work, 'repo', source);
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(join(root, source), file);
    mkdirSync(join(dirname(file), '../worker'));
  }

  for (const [path, script] of Object.entries(shellToolDoubles)) {
    const target = join(work, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '#!/bin/bash\nset -eu\n' + script, { mode: 0o755 });
  }

  writeFileSync(join(work, 'binary.wasm'), 'fixture-only-not-wasm');
  writeFileSync(
    join(work, 'run.sh'),
    [
      'set -eu',
      'kcov --version > /work/version.txt',
      'mkdir -p /opt/ghc-wasm',
      ...tests.flatMap(runCaseScript),
      '',
    ].join('\n'),
  );
}

function checkCalls(test: ScriptCase, calls: string): void {
  const postLink = calls.includes('post-link');
  const nodeCalls = calls.split('node <').length - 1;

  if (test.expected === 0) {
    const builds = fixtures.has(test.source.split('/')[1]) ? 2 : 1;
    assert.equal(calls.split('cabal <build>').length - 1, builds);
    assert.equal(calls.split('cabal <list-bin>').length - 1, builds);
    assert.equal(calls.split('post-link <--input>').length - 1, builds);
    assert.match(calls, /post-link <--input> <\/work\/binary.wasm> <--output>/);
    assert.equal(nodeCalls, 2);

    if (test.mode === 'override') {
      assert.match(calls, /custom.project/);
      assert.match(calls, /custom-build/);
    }

    if (test.mode === 'runtime-tests') {
      assert.match(calls, /<exe:runtime-tests>/);
    }

    return;
  }

  switch (test.mode) {
    case 'build-failure':
      assert.equal(nodeCalls, 1);
      assert.ok(!postLink && !calls.includes('list-bin'));
      break;
    case 'capture':
      assert.equal(nodeCalls, 1);
      assert.ok(!calls.includes('cabal'));
      break;
    case 'list-bin':
      assert.ok(calls.includes('cabal <list-bin>') && !postLink);
      break;
    case 'post-link':
      assert.ok(postLink && nodeCalls === 1);
      break;
    case 'write':
      assert.ok(postLink && nodeCalls === 2);
      break;
    default:
      assert.equal(calls, '');
  }
}

export function shellLineHits(
  xml: string,
  filename: string,
  sourceLines: number,
): Record<string, number> {
  const lines: Record<string, number> = {};
  for (const [, attributes, body] of xml.matchAll(/<class\s+([^>]+)>([\s\S]*?)<\/class>/g)) {
    if (/\bfilename="([^"]+)"/.exec(attributes)?.[1] !== filename) {
      continue;
    }

    const content = /<lines>([\s\S]*?)<\/lines>/.exec(body)?.[1] ?? '';
    for (const [, attributes] of content.matchAll(/<line\s+([^>]+)>/g)) {
      const number = /\bnumber="([1-9]\d*)"/.exec(attributes)?.[1];
      const hits = Number(/\bhits="(\d+)"/.exec(attributes)?.[1]);
      if (number === undefined || Number(number) > sourceLines || !Number.isSafeInteger(hits)) {
        throw new Error('Invalid source line or counter');
      }

      lines[number] = Math.max(hits, lines[number] ?? 0);
    }
  }

  return lines;
}

function collect(work: string, tests: ScriptCase[], image: string): Record<string, unknown> {
  const entries = new Map(
    scripts.map((source) => {
      const sha256 = digest(join(root, source));
      assert.equal(digest(join(work, 'repo', source)), sha256, 'Source changed during collection');
      return [source, { sha256, lines: {} as Record<string, number>, branch_coverage: false }];
    }),
  );
  for (const test of tests) {
    const directory = join(work, 'cases', test.identifier);
    assert.equal(Number(textFile(join(directory, 'returncode'))), test.expected, test.identifier);
    assert.equal(
      readdirSync(join(directory, 'tmp')).length,
      0,
      'Snapshot cleanup failed: ' + test.identifier,
    );
    const calls = join(directory, 'calls.log');
    checkCalls(test, isFile(calls) ? textFile(calls) : '');

    const xmls = files(join(directory, 'kcov')).filter((path) => path.endsWith('/cobertura.xml'));
    assert.ok(xmls.length > 0, 'No kcov evidence: ' + test.identifier);
    const entry = entries.get(test.source);
    assert.ok(entry);
    const length = textFile(join(root, test.source))
      .replace(/\r?\n$/, '')
      .split('\n').length;
    for (const xml of xmls) {
      for (const [line, count] of Object.entries(
        shellLineHits(textFile(xml), '/work/repo/' + test.source, length),
      )) {
        entry.lines[line] = Math.max(entry.lines[line] ?? 0, count);
      }
    }
  }

  assert.ok(
    [...entries.values()].every(({ lines }) => Object.keys(lines).length > 0),
    'Missing source line mapping',
  );
  const version = textFile(join(work, 'version.txt')).trim();
  assert.match(version, /^kcov /);
  return {
    schema: 1,
    collector: {
      name: 'kcov',
      version,
      image,
      runtime: 'Linux Docker / real Bash',
      boundaries: 'compiler, post-link, and manifest are test doubles',
    },
    files: Object.fromEntries(entries),
    contracts: { passed: tests.length, cases: tests },
  };
}

runCli(import.meta.url, () => {
  const { values } = parseArgs({
    options: { output: { type: 'string' }, image: { type: 'string', default: kcov } },
  });

  if (!values.output) {
    throw new Error('Shell coverage requires --output');
  }

  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output);
  const work = join(output, 'fixture');
  mkdirSync(work);
  const tests = shellCases();
  prepare(work, tests);
  const run = loggedCommand(output, 'docker.log', [
    'docker',
    'run',
    '--rm',
    '--security-opt',
    'seccomp=unconfined',
    '--entrypoint',
    '/bin/bash',
    '-v',
    work + ':/work',
    values.image,
    '/work/run.sh',
  ]);
  if (run.code !== 0) {
    throw new Error('kcov container failed, see ' + join(output, run.log));
  }

  const report = join(output, 'coverage.json');
  writeJson(report, collect(work, tests, values.image));

  if (within(join(root, 'artifacts/testing'), output)) {
    writeJson(join(root, 'artifacts/testing/shell-coverage-latest.json'), {
      report: relative(root, report),
      sha256: digest(report),
    });
  }

  console.log(JSON.stringify({ report, contracts: tests.length }));
  return 0;
});
