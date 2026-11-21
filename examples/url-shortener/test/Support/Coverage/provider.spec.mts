import assert from 'node:assert/strict';
import { test } from 'node:test';
import module, {
  includeTestFiles,
} from '../../../../../scripts/testing/Support/coverage-provider.mts';

void test('includes authored specs while retaining explicit and dependency exclusions', async () => {
  const options = {
    exclude: [
      '**/*.spec.ts',
      '**/coverage-setup.ts',
      '**/node_modules/**',
      'explicit.ts',
      'config.mts',
    ],
  };
  const context = {
    config: {
      root: '/fixture',
      include: ['**/*.spec.ts'],
      setupFiles: ['/fixture/coverage-setup.ts'],
    },
  };
  let initialized: typeof context | undefined;
  const original = {
    async initialize(input: typeof context): Promise<void> {
      initialized = input;
    },
    resolveOptions(): { exclude: string[] } {
      return options;
    },
  };

  assert.equal(includeTestFiles(original), original);
  await original.initialize(context);

  assert.equal(initialized, context);
  assert.deepEqual(options.exclude, ['**/node_modules/**', 'explicit.ts', 'config.mts']);
});

void test('returns the existing Istanbul provider through the custom module contract', async () => {
  const provider = await module.getProvider();
  assert.equal(provider.name, 'istanbul');
  assert.equal(typeof module.takeCoverage, 'function');
  assert.equal(typeof module.startCoverage, 'function');
});
