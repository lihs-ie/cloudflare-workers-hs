import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authoredCoverageExclusions } from '../Support/coverage-provider.mts';

void test('authored test and setup files remain measurable while dependency exclusions stay intact', () => {
  const result = authoredCoverageExclusions(
    '/repo/runtime',
    ['test/**/*.spec.ts'],
    ['/repo/runtime/coverage-setup.ts'],
    [
      'test/**/*.spec.ts',
      '**/coverage-setup.ts',
      'coverage-setup.ts',
      '/repo/runtime/coverage-setup.ts',
      '**/node_modules/**',
      '**/other-setup.ts',
    ],
  );

  assert.deepEqual(result, ['**/node_modules/**', '**/other-setup.ts']);
});
