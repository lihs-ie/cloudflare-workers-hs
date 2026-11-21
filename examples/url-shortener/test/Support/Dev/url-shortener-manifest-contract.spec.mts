import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInputs as genericInputs } from '../../../../../scripts/testing/build-manifest.mts';
import { buildInputs } from '../Runtime/build-manifest.mts';

void test('application fixture inputs use their own target and exclude transient generated files', () => {
  const inputs = buildInputs();

  assert.deepEqual(inputs, genericInputs('runtime-tests'));
  assert.ok(
    Object.keys(inputs).some((name) =>
      name.startsWith('examples/url-shortener/test/Support/Runtime/'),
    ),
  );
  assert.ok(
    Object.keys(inputs).every(
      (name) =>
        !name.includes('.dev-test-') && !name.endsWith('.tix') && !name.includes('node_modules'),
    ),
  );
  assert.ok(Object.keys(inputs).every((name) => !name.startsWith('tests/runtime/')));
});
