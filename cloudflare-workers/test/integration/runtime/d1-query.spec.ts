import { it as test, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import assert from 'node:assert/strict';
import { jsonObject, jsonValue, jsonString } from '../../../../scripts/testing/Support/json.mts';
test('typed D1 queries preserve bindings, nullable rows and native batch rollback', async () => {
  const response = await SELF.fetch('https://runtime.test/__fixture/d1-query');
  expect(response.status).toBe(200);
  const result = jsonObject(await response.json());
  assert.equal(jsonObject(result).batchCount, 2);
  assert.deepEqual(jsonObject(result).rows, [
    ["quoted-' ; DROP TABLE typed_query_items; --", null, 7, [0, 255]],
    ['second', 'present', 8, [97]],
  ]);
  assert.equal(jsonObject(result).first, 7);
  assert.equal(jsonObject(result).absent, null);
  assert.equal(jsonObject(result).rolledBack, null);
  assert.equal(jsonObject(result).missing, 'D1RowDecodeFailed 1 (D1MissingColumn "count")');
  assert.equal(jsonObject(result).null, 'D1RowDecodeFailed 1 (D1UnexpectedNull "count")');
  assert.equal(
    jsonObject(result).wrongType,
    'D1RowDecodeFailed 1 (D1ColumnTypeMismatch "count" D1IntegerType D1TextType)',
  );
  assert.match(
    jsonString(jsonObject(result).unsafeInteger),
    /D1InvalidColumnValue.*exact JavaScript numeric range/,
  );
  assert.equal(jsonObject(result).exactLargeInteger, '9007199254740993');
  assert.equal(jsonObject(result).unsafeParameterRejected, true);
});
