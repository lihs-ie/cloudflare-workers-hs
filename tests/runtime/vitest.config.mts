import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { verifyBuild } from '../../scripts/testing/build-manifest.mts';

export default defineConfig(() => {
  verifyBuild('library-runtime');

  return {
    plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
    test: {
      env: { WASM_COVERAGE_ENDPOINT: process.env.WASM_COVERAGE_ENDPOINT ?? '' },
      setupFiles: process.env.WASM_COVERAGE === '1' ? ['./coverage-setup.ts'] : [],
      include: [
        '../../cloudflare-workers/test/integration/runtime/**/*.spec.ts',
        '../../servant-cloudflare-workers*/test/integration/runtime/**/*.spec.ts',
      ],
      passWithNoTests: false,
      retry: 0,
      fileParallelism: false,
      coverage: {
        provider: 'custom' as const,
        allowExternal: true,
        customProviderModule: '../../scripts/testing/Support/coverage-provider.mts',
        reportsDirectory: 'test-artifacts/coverage/runtime',
        reporter: ['text', 'json', 'json-summary', 'html'],
        include: [
          '**/*.ts',
          '../../cloudflare-workers/test/**/*.ts',
          '../../servant-cloudflare-workers*/test/**/*.ts',
        ],
        exclude: ['**/*.d.ts', '**/*.d.mts', 'worker/*-jsffi.mjs'],
        reportOnFailure: true,
      },
    },
  };
});
