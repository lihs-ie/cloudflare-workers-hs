import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { OxcError } from 'oxc-parser';

// OxcError permits an empty labels array, so upstream diagnostics can lack a span.
const diagnostic: Pick<OxcError, 'message' | 'labels'> = {
  message: 'upstream diagnostic',
  labels: [],
};
mock.module('oxc-parser', {
  namedExports: {
    parseSync: () => ({ errors: [diagnostic] }),
    visitorKeys: {},
  },
});
const { checkSource } = await import('../../scripts/check-docs.ts');
assert.deepEqual(checkSource('invalid'), [
  { line: 1, message: 'TypeScript syntax: upstream diagnostic' },
]);
