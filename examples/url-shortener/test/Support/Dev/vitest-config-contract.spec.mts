import {
  jsonArray,
  jsonObject,
  jsonSequence,
} from '../../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  loadTestModule,
} from '../../../../../scripts/testing/Support/test-boundary.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleBoundary } from '../../../../../scripts/testing/Support/module-boundaries.mts';

const example = new URL('../../..', import.meta.url);

// Evaluate the real configuration factory. These are configuration contracts,
// not evidence that Vitest or a Worker has started.
for (const scenario of [
  'no-endpoint',
  'empty-endpoint',
  'endpoint',
  'build-failure',
  'migration-failure',
]) {
  void test(`production Vitest configuration: ${scenario}`, async () => {
    const previous = process.env.WASM_COVERAGE_ENDPOINT;
    const endpoint = 'https://collector.invalid/coverage?label="production"';

    if (scenario === 'no-endpoint') {
      delete process.env.WASM_COVERAGE_ENDPOINT;
    } else {
      process.env.WASM_COVERAGE_ENDPOINT = scenario === 'endpoint' ? endpoint : '';
    }
    const calls: unknown[][] = [];
    const migrations = [{ name: '0001.sql', queries: ['CREATE TABLE entries (value TEXT)'] }];
    const failure = new Error(`sentinel ${scenario}`);
    const boundaries = [
      moduleBoundary('vitest/config', {
        namedExports: { defineConfig: (factory: unknown) => factory },
      }),
      moduleBoundary('@cloudflare/vitest-plugin', {
        namedExports: {
          readD1Migrations: async (directory: unknown) => {
            jsonArray(calls).push(['migrations', directory]);

            if (scenario === 'migration-failure') {
              throw failure;
            }

            return migrations;
          },
          cloudflareTest: (options: unknown) => {
            jsonArray(calls).push(['plugin']);
            return { options };
          },
        },
      }),
      moduleBoundary(new URL('test/Support/Runtime/build-manifest.mts', example), {
        namedExports: {
          verifyBuild: (target: unknown) => {
            jsonArray(calls).push(['build', target]);

            if (scenario === 'build-failure') {
              throw failure;
            }
          },
        },
      }),
      moduleBoundary('./test/Support/Production/auth.js', {
        namedExports: {
          accessTeam: 'team-contract',
          accessAudience: 'audience-contract',
          jwksURL: 'https://keys.invalid/certs',
        },
      }),
    ];
    try {
      const { default: factory } = await loadTestModule(
        `${new URL('vitest.config.mts', example)}?contract=${scenario}`,
      );
      assert.deepEqual(calls, [], 'imports must not verify builds or read migrations');

      if (scenario.endsWith('failure')) {
        await assert.rejects(
          Promise.resolve(callTestBoundary(factory)),
          (error) => error === failure,
        );
        assert.deepEqual(
          calls,
          scenario === 'build-failure'
            ? [['build', 'url-shortener']]
            : [
                ['build', 'url-shortener'],
                ['migrations', './migrations'],
              ],
        );
        return;
      }

      const config = await callTestBoundary(factory);
      assert.deepEqual(calls, [
        ['build', 'url-shortener'],
        ['migrations', './migrations'],
        ['plugin'],
      ]);
      assert.deepEqual(
        jsonObject(config).define,
        scenario === 'endpoint' ? { WASM_COVERAGE_ENDPOINT: JSON.stringify(endpoint) } : {},
      );
      assert.equal(jsonSequence(jsonObject(config).plugins).length, 1);
      assert.deepEqual(jsonObject(jsonArray(jsonObject(config).plugins)[0]).options, {
        main: './worker/export-coordinator.ts',
        wrangler: { configPath: './apps/management/wrangler.jsonc' },
        miniflare: {
          durableObjects: { COORDINATOR: { className: 'ExportCoordinator', useSQLite: true } },
          d1Databases: ['DB'],
          r2Buckets: ['EXPORTS'],
          queueProducers: ['CLICKS', 'EXPORT_QUEUE'],
          bindings: {
            TEST_MIGRATIONS: migrations,
            ACCESS_TEAM: 'team-contract',
            ACCESS_AUDIENCE: 'audience-contract',
            ACCESS_JWKS_URL: 'https://keys.invalid/certs',
          },
        },
      });
      assert.equal(
        jsonObject(
          jsonObject(
            jsonObject(jsonObject(jsonArray(jsonObject(config).plugins)[0]).options).miniflare,
          ).bindings,
        ).TEST_MIGRATIONS,
        migrations,
      );
      assert.deepEqual(jsonObject(jsonObject(config).test).include, [
        'test/integration/production/**/*.spec.ts',
      ]);
      assert.equal(jsonObject(jsonObject(config).test).passWithNoTests, false);
      assert.equal(jsonObject(jsonObject(config).test).retry, 0);
      assert.equal(jsonObject(jsonObject(config).test).fileParallelism, false);
      assert.deepEqual(jsonObject(jsonObject(config).test).coverage, {
        provider: 'custom',
        customProviderModule: '../../scripts/testing/Support/coverage-provider.mts',
        reportsDirectory: 'test-artifacts/coverage/production',
        reporter: ['text', 'json', 'json-summary', 'html'],
        include: [
          'worker/**/*.ts',
          'test/integration/production/**/*.ts',
          'test/Support/Production/**/*.ts',
        ],
        exclude: ['**/*.d.ts', '**/*.d.mts'],
        reportOnFailure: true,
      });
    } finally {
      for (const boundary of boundaries) {
        boundary.restore();
      }

      if (previous === undefined) {
        delete process.env.WASM_COVERAGE_ENDPOINT;
      } else {
        process.env.WASM_COVERAGE_ENDPOINT = previous;
      }
    }
  });
}
