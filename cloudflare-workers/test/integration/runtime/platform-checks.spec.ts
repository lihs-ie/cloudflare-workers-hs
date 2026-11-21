import { test } from 'vitest';
import { SELF } from 'cloudflare:test';
import assert from 'node:assert/strict';
import {
  jsonArray,
  jsonObject,
  jsonSequence,
  jsonString,
} from '../../../../scripts/testing/Support/json.mts';

async function json(path: string): Promise<unknown> {
  const response = await SELF.fetch('https://fixture.invalid' + path);
  assert.equal(response.status, 200);
  return response.json();
}

test('SQL typed values, parameter safety, rollback, row and byte limits', async () => {
  const result = await json('/__sql');
  assert.deepEqual(jsonObject(result).typed, [
    [
      { tag: 'null' },
      { tag: 'number', value: 1.25 },
      { tag: 'text', value: "'; DROP TABLE checks; --" },
      { tag: 'blob', value: [0, 128, 255] },
    ],
  ]);
  assert.equal(jsonObject(result).rollback, true);
  assert.deepEqual(jsonObject(result).count, [[{ tag: 'number', value: 0 }]]);
  assert.deepEqual(jsonObject(result).afterLimit, [[{ tag: 'number', value: 0 }]]);
  assert.equal(jsonObject(result).rowLimit, true);
  assert.equal(jsonObject(result).byteLimit, true);
  assert.equal(jsonSequence(jsonObject(result).inputChecks).length, 7);
  for (const check of jsonArray(jsonObject(result).inputChecks)) {
    assert.equal(jsonObject(check).rejected, true, jsonString(jsonObject(check).name));
  }
  assert.deepEqual(jsonObject(result).recovery, [[{ tag: 'number', value: 0 }]]);
});

test('WebSocket response preserves outer headers and rejects changing 101 to HTTP denial', async () => {
  assert.deepEqual(await json('/__upgrade'), {
    header: 'retained',
    statusMutationRejected: true,
    invalidIdentifierRejected: true,
    throwingIdentifierRejected: true,
  });
});
