import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { verifyBuild } from './test/Support/Runtime/build-manifest.mts';
export default defineConfig(async () => {
  verifyBuild('runtime-tests');
  const migrations = await readD1Migrations('./migrations');
  const config = {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './test/Support/Runtime/wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      env: { WASM_COVERAGE_ENDPOINT: process.env.WASM_COVERAGE_ENDPOINT ?? '' },
      setupFiles:
        process.env.WASM_COVERAGE === '1' ? ['./test/Support/Runtime/coverage-setup.ts'] : [],
      include: ['test/integration/runtime/**/*.spec.ts'],
      passWithNoTests: false,
      retry: 0,
      fileParallelism: false,
      coverage: {
        provider: 'custom' as const,
        customProviderModule: '../../scripts/testing/Support/coverage-provider.mts',
        reportsDirectory: 'test-artifacts/coverage/runtime',
        reporter: ['text', 'json', 'json-summary', 'html'],
        // Node helpers use c8; production sources use the production report.
        include: [
          'test/integration/runtime/**/*.ts',
          'test/Support/Runtime/**/*.ts',
          'test/Support/Fixtures/**/*.ts',
        ],
        exclude: ['**/*.d.ts', '**/*.d.mts', 'worker/*-jsffi.mjs'],
        reportOnFailure: true,
      },
    },
  };
  return defineConfig(config);
});
