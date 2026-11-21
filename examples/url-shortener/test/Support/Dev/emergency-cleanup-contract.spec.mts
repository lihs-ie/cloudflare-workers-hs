import {
  callTestBoundary,
  callTestMethod,
} from '../../../../../scripts/testing/Support/test-boundary.mts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/** Reject incomplete, ambiguous or partially successful child TAP summaries. */
function requireSuccessfulContractRun(stdout: string, stderr: string): unknown {
  const summary = new Map();
  for (const [, name, raw] of stdout.matchAll(
    /^# (tests|pass|fail|cancelled|skipped) ([0-9]+)$/gm,
  )) {
    assert.equal(summary.has(name), false, `duplicate TAP summary field: ${name}`);
    const count = Number(raw);
    assert.ok(Number.isSafeInteger(count), `unsafe TAP count: ${name}`);
    summary.set(name, count);
  }
  assert.equal(summary.size, 5, 'incomplete TAP summary');
  for (const name of ['fail', 'cancelled', 'skipped']) {
    assert.equal(summary.get(name), 0, `child ${name} must be zero`);
  }
  assert.ok(summary.get('tests') > 0, 'child must execute tests');
  assert.equal(summary.get('tests'), summary.get('pass'), 'every child test must pass');
  assert.equal(
    [...stderr.matchAll(/^preexisting environment restored$/gm)].length,
    1,
    'exactly one restoration marker required',
  );
  return summary.get('pass');
}

const validSummary = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n';
for (const [name, output, diagnostic, expected] of [
  ['missing', '', 'preexisting environment restored', /incomplete TAP summary/],
  [
    'empty suite',
    validSummary.replaceAll('2', '0'),
    'preexisting environment restored',
    /child must execute tests/,
  ],
  [
    'partial pass',
    validSummary.replace('pass 2', 'pass 1'),
    'preexisting environment restored',
    /every child test must pass/,
  ],
  [
    'failure',
    validSummary.replace('fail 0', 'fail 1'),
    'preexisting environment restored',
    /child fail must be zero/,
  ],
  [
    'cancelled',
    validSummary.replace('cancelled 0', 'cancelled 1'),
    'preexisting environment restored',
    /child cancelled must be zero/,
  ],
  [
    'skipped',
    validSummary.replace('skipped 0', 'skipped 1'),
    'preexisting environment restored',
    /child skipped must be zero/,
  ],
  [
    'duplicate',
    validSummary + '# pass 2\n',
    'preexisting environment restored',
    /duplicate TAP summary field/,
  ],
  [
    'unsafe count',
    validSummary.replace('tests 2', 'tests 9007199254740992'),
    'preexisting environment restored',
    /unsafe TAP count/,
  ],
  [
    'malformed count',
    validSummary.replace('tests 2', 'tests unavailable'),
    'preexisting environment restored',
    /incomplete TAP summary/,
  ],
  ['missing restoration', validSummary, '', /exactly one restoration marker/],
  [
    'duplicate restoration',
    validSummary,
    'preexisting environment restored\npreexisting environment restored',
    /exactly one restoration marker/,
  ],
] as const) {
  void test(`child summary rejects ${name}`, () => {
    assert.throws(() => requireSuccessfulContractRun(output, diagnostic), expected);
  });
}

void test('child summary accepts changing positive test counts', () => {
  assert.equal(requireSuccessfulContractRun(validSummary, 'preexisting environment restored'), 2);
  assert.equal(
    requireSuccessfulContractRun(
      validSummary.replaceAll('2', '109'),
      'preexisting environment restored',
    ),
    109,
  );
});

// Exercise last-resort cleanup only on processes created by the isolated child.
const seededEnvironment = {
  WASM_COVERAGE: 'restoration-contract',
  WASM_COVERAGE_ENDPOINT: 'https://restoration.invalid/wasm',
  WORKERD_JS_COVERAGE_ENDPOINT: 'https://restoration.invalid/js',
  WORKERD_JS_COVERAGE_DIRECTORY: '/unused-restoration-contract',
};
for (const [file, seedGlobal = false] of [
  ['../../../../../scripts/testing/test/dev-lifecycle-contract.spec.mts'],
  ['../../../../../scripts/testing/test/runtime-lifecycle-contract.spec.mts'],
  ['url-shortener-config-contract.spec.mts'],
  ['dev-run-contract.spec.mts'],
  ['vitest-config-contract.spec.mts'],
  ['../../../../workflows/test/Support/coverage-upload-contract.spec.mts', true],
] as const) {
  void test(`preexisting environment survives all contracts: ${file}`, (context) => {
    const program = `
      import assert from 'node:assert/strict';
      import { after } from 'node:test';
      const globalDescriptor={value:'https://restoration.invalid/global-wasm',writable:true,configurable:true,enumerable:true};
      ${seedGlobal ? "Object.defineProperty(globalThis,'WASM_COVERAGE_ENDPOINT',globalDescriptor);" : ''}
      after(()=>{
        for(const [name, value] of Object.entries(${JSON.stringify(seededEnvironment)})) {
          assert.equal(process.env[name],value,'environment restoration: '+name);
        }
        ${seedGlobal ? "assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis,'WASM_COVERAGE_ENDPOINT'),globalDescriptor,'global endpoint descriptor restoration');" : ''}
        console.error('preexisting environment restored');
      });
      await import(${callTestMethod(JSON, 'stringify', new URL(file, import.meta.url).href)});
    `;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-test-module-mocks',
        '--test-reporter=tap',
        '--input-type=module',
        '--eval',
        program,
      ],
      {
        encoding: 'utf8',
        timeout: 60000,
        env: {
          ...process.env,
          ...Object.fromEntries(
            Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'),
          ),
          ...seededEnvironment,
          NODE_TEST_CONTEXT: undefined,
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const passed = requireSuccessfulContractRun(result.stdout, result.stderr);
    context.diagnostic(`${passed} child contracts passed with preexisting environment`);
  });
}
