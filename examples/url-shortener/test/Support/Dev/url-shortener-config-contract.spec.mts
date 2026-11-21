import type * as Module from 'node:module';
import {
  jsonArray,
  jsonObject,
  jsonSequence,
  jsonValue,
} from '../../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  loadTestModule,
} from '../../../../../scripts/testing/Support/test-boundary.mts';
import { moduleBoundary } from '../../../../../scripts/testing/Support/module-boundaries.mts';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, mock } from 'node:test';
const example = fileURLToPath(new URL('../../..', import.meta.url));
for (const coverage of [false, true]) {
  void test(`runtime Vitest configuration preserves collection contract: ${coverage}`, async () => {
    const saved = [process.env.WASM_COVERAGE, process.env.WASM_COVERAGE_ENDPOINT];

    if (coverage) {
      process.env.WASM_COVERAGE = '1';
      process.env.WASM_COVERAGE_ENDPOINT = 'http://collector.invalid';
    } else {
      delete process.env.WASM_COVERAGE;
      delete process.env.WASM_COVERAGE_ENDPOINT;
    }
    let verified = 0;
    const migration = { fixture: true };
    const boundaries = [
      moduleBoundary('vitest/config', {
        namedExports: { defineConfig: (value: unknown) => value },
      }),
      moduleBoundary('@cloudflare/vitest-plugin', {
        namedExports: {
          readD1Migrations: async (directory: unknown) => {
            assert.equal(directory, './migrations');
            return migration;
          },
          cloudflareTest: (config: unknown) => config,
        },
      }),
      moduleBoundary(pathToFileURL(path.join(example, 'test/Support/Runtime/build-manifest.mts')), {
        namedExports: {
          verifyBuild: (target: unknown) => {
            assert.equal(target, 'runtime-tests');
            verified++;
          },
        },
      }),
    ];
    try {
      const { default: factory } = await loadTestModule(
        `${pathToFileURL(path.join(example, 'vitest.runtime.config.mts'))}?coverage=${coverage}`,
      );
      const config = await callTestBoundary(factory);
      assert.equal(verified, 1);
      assert.equal(jsonObject(jsonObject(config).test).passWithNoTests, false);
      assert.equal(jsonObject(jsonObject(config).test).fileParallelism, false);
      assert.equal(jsonObject(jsonObject(config).test).retry, 0);
      assert.equal(
        jsonObject(jsonObject(jsonObject(config).test).env).WASM_COVERAGE_ENDPOINT,
        coverage ? 'http://collector.invalid' : '',
      );
      assert.deepEqual(
        jsonObject(jsonObject(config).test).setupFiles,
        coverage ? ['./test/Support/Runtime/coverage-setup.ts'] : [],
      );
      assert.equal(
        jsonObject(
          jsonObject(jsonObject(jsonArray(jsonObject(config).plugins)[0]).miniflare).bindings,
        ).TEST_MIGRATIONS,
        migration,
      );
      assert.equal(jsonObject(jsonObject(jsonObject(config).test).coverage).reportOnFailure, true);
      assert.equal(jsonObject(jsonObject(jsonObject(config).test).coverage).provider, 'custom');
    } finally {
      for (const boundary of boundaries) {
        boundary.restore();
      }
      for (const [index, name] of ['WASM_COVERAGE', 'WASM_COVERAGE_ENDPOINT'].entries()) {
        if (saved[index] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[index];
        }
      }
    }
  });
}

void test('coverage inventory distinguishes execution, empty maps and missing measurements', async () => {
  const files: Record<string, string[]> = {
    worker: [
      'executed.ts',
      'zero.mts',
      'empty.mjs',
      'missing.ts',
      'types.d.ts',
      'generated-jsffi.mjs',
      'asset.txt',
    ],
    test: ['nested'],
    'test/nested': ['case.ts'],
    scripts: [],
  };
  const reports = {
    [path.join(example, 'worker/executed.ts')]: { s: { 0: 2, 1: 0 }, b: { 0: [1, 0] } },
    [path.join(example, 'worker/zero.mts')]: { s: { 0: 0 }, b: {} },
    [path.join(example, 'worker/empty.mjs')]: { s: {}, b: {} },
  };
  let written: Record<string, unknown> = {};
  const boundary = moduleBoundary('node:fs', {
    namedExports: {
      readFileSync: () => JSON.stringify(reports),
      readdirSync: (directory: string, options: unknown) => {
        if (!options) {
          return ['vitest.config.mts', 'README.md'];
        }

        const relative = path.relative(example, directory);
        return files[relative].map((name: string) => ({
          name,
          isDirectory: () => name === 'nested',
        }));
      },
      writeFileSync: (filename: unknown, value: string) => {
        assert.equal(
          filename,
          path.join(example, 'test-artifacts/coverage/runtime/inventory.json'),
        );
        written = jsonObject(jsonValue(value));
      },
    },
  });
  try {
    await loadTestModule(
      `${pathToFileURL(path.join(example, 'test/Support/Runtime/coverage-inventory.mts'))}?inventory-contract`,
    );
    assert.equal(written.wasmInternalCoverage, 'unmeasured');
    assert.deepEqual(
      jsonArray(written.files).map((value) => {
        const { file, status } = jsonObject(value);
        return [file, status];
      }),
      [
        ['test/nested/case.ts', 'unmeasured'],
        ['vitest.config.mts', 'unmeasured'],
        ['worker/empty.mjs', 'no-instrumentation-points'],
        ['worker/executed.ts', 'executed'],
        ['worker/missing.ts', 'unmeasured'],
        ['worker/zero.mts', 'unexecuted'],
      ],
    );
    assert.deepEqual(
      jsonObject(
        jsonArray(written.files).find((value) => jsonObject(value).file === 'worker/executed.ts'),
      ).branches,
      { total: 2, covered: 1 },
    );
    assert.deepEqual(
      jsonObject(
        jsonArray(written.files).find((value) => jsonObject(value).file === 'worker/executed.ts'),
      ).statements,
      { total: 2, covered: 1 },
    );
    assert.equal(jsonObject(jsonArray(written.files)[0]).statements, null);
  } finally {
    boundary.restore();
  }
});

for (const scenario of ['success', 'snapshot-failure', 'missing-endpoint', 'upload-failure']) {
  void test(`coverage teardown reports ${scenario} without losing snapshot bytes`, async () => {
    let teardown;
    const uploaded: unknown[] = [];
    const previousEndpoint = process.env.WASM_COVERAGE_ENDPOINT;

    if (scenario === 'missing-endpoint') {
      delete process.env.WASM_COVERAGE_ENDPOINT;
    } else {
      process.env.WASM_COVERAGE_ENDPOINT = 'https://collector.invalid/teardown';
    }
    const cloudflareURL = `data:text/javascript,export const SELF = {};#${scenario}`;
    const hooks = registerHooks({
      resolve(
        specifier: string,
        context: Module.ResolveHookContext,
        next: (
          specifier: string,
          context?: Partial<Module.ResolveHookContext>,
        ) => Module.ResolveFnOutput,
      ): import('module').ResolveFnOutput {
        if (specifier === 'cloudflare:test') {
          return { url: cloudflareURL, shortCircuit: true };
        }

        return next(specifier, context);
      },
    });
    const boundaries = [
      moduleBoundary('vitest', {
        namedExports: {
          afterAll: (callback: unknown) => {
            teardown = callback;
          },
        },
      }),
      moduleBoundary(cloudflareURL, {
        namedExports: {
          SELF: {
            fetch: async (url: unknown) => {
              assert.equal(url, 'https://coverage.invalid/__coverage');
              return new Response('exact snapshot\n', {
                status: scenario === 'snapshot-failure' ? 503 : 200,
              });
            },
          },
        },
      }),
    ];
    const fetchMock = mock.method(globalThis, 'fetch', async (url: unknown, options: unknown) => {
      jsonArray(uploaded).push([url, options]);
      return new Response('saved', { status: scenario === 'upload-failure' ? 500 : 200 });
    });
    try {
      await loadTestModule(
        `${pathToFileURL(path.join(example, 'test/Support/Runtime/coverage-setup.ts'))}?teardown=${scenario}`,
      );
      assert.equal(typeof teardown, 'function');

      if (scenario === 'success') {
        await callTestBoundary(teardown);
        assert.deepEqual(uploaded, [
          ['https://collector.invalid/teardown', { method: 'POST', body: 'exact snapshot\n' }],
        ]);
      } else {
        await assert.rejects(
          Promise.resolve(callTestBoundary(teardown)),
          (() => {
            if (scenario === 'snapshot-failure') {
              return /snapshot failed: 503/;
            }

            if (scenario === 'missing-endpoint') {
              return /wasm-coverage.py/;
            }

            return /collection failed: 500/;
          })(),
        );
        assert.equal(jsonSequence(uploaded).length, scenario === 'upload-failure' ? 1 : 0);
      }
    } finally {
      fetchMock.mock.restore();
      for (const boundary of boundaries) {
        boundary.restore();
      }
      hooks.deregister();

      if (previousEndpoint === undefined) {
        delete process.env.WASM_COVERAGE_ENDPOINT;
      } else {
        process.env.WASM_COVERAGE_ENDPOINT = previousEndpoint;
      }
    }
  });
}
