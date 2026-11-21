import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleBoundary } from '../../../../scripts/testing/Support/module-boundaries.mts';
import {
  callTestBoundary,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import { jsonObject } from '../../../../scripts/testing/Support/json.mts';

for (const scenario of ['normal', 'coverage', 'build-failure']) {
  void test(`library runtime configuration ${scenario} validates its reactor and selects setup`, async () => {
    const previousMode = process.env.WASM_COVERAGE;
    const previousEndpoint = process.env.WASM_COVERAGE_ENDPOINT;
    process.env.WASM_COVERAGE = scenario === 'coverage' ? '1' : '0';
    process.env.WASM_COVERAGE_ENDPOINT = 'https://collector.invalid/snapshot';
    const calls: unknown[] = [];
    const failure = new Error('stale library reactor');
    const boundaries = [
      moduleBoundary('vitest/config', {
        namedExports: { defineConfig: (factory: unknown): unknown => factory },
      }),
      moduleBoundary('@cloudflare/vitest-plugin', {
        namedExports: { cloudflareTest: (options: unknown): unknown => ({ options }) },
      }),
      moduleBoundary(new URL('../../../../scripts/testing/build-manifest.mts', import.meta.url), {
        namedExports: {
          verifyBuild: (target: unknown): void => {
            calls.push(target);

            if (scenario === 'build-failure') {
              throw failure;
            }
          },
        },
      }),
    ];
    try {
      const module = await loadTestModule(
        `${new URL('../../vitest.config.mts', import.meta.url)}?contract=${scenario}`,
      );
      assert.deepEqual(calls, []);

      if (scenario === 'build-failure') {
        assert.throws(
          () => callTestBoundary(module.default),
          (error) => error === failure,
        );
      } else {
        const config = jsonObject(callTestBoundary(module.default));
        const settings = jsonObject(config.test);
        assert.deepEqual(
          settings.setupFiles,
          scenario === 'coverage' ? ['./coverage-setup.ts'] : [],
        );
        assert.equal(
          jsonObject(settings.env).WASM_COVERAGE_ENDPOINT,
          'https://collector.invalid/snapshot',
        );
        assert.equal(settings.fileParallelism, false);
      }
      assert.deepEqual(calls, ['library-runtime']);
    } finally {
      for (const boundary of boundaries.reverse()) {
        boundary.restore();
      }

      if (previousMode === undefined) {
        delete process.env.WASM_COVERAGE;
      } else {
        process.env.WASM_COVERAGE = previousMode;
      }

      if (previousEndpoint === undefined) {
        delete process.env.WASM_COVERAGE_ENDPOINT;
      } else {
        process.env.WASM_COVERAGE_ENDPOINT = previousEndpoint;
      }
    }
  });
}
