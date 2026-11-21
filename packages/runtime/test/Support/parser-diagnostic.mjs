import assert from 'node:assert/strict';
import { mock } from 'node:test';

// OxcError permits an empty labels array, so upstream diagnostics can lack a span.
mock.module('oxc-parser', {
  namedExports: {
    parseSync: () => ({ errors: [{ message: 'upstream diagnostic', labels: [] }] }),
  },
});
const { checkSource } = await import('../../scripts/check-docs.mjs');
assert.deepEqual(checkSource('invalid'), [
  { line: 1, message: 'TypeScript syntax: upstream diagnostic' },
]);
