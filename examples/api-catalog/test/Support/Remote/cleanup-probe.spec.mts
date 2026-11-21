import { jsonArray, jsonObject } from '../../../../../scripts/testing/Support/json.mts';
import { callTestMethod } from '../../../../../scripts/testing/Support/test-boundary.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import probe from './cleanup-probe.ts';
const key = 'archives/encrypted/remote-archive.bin';
function request(
  body?:
    | number
    | { uploads?: undefined }
    | { uploads: null }
    | { uploads: number[] }
    | { uploads: null[] }
    | { uploads: {}[] }
    | { uploads: { key: string }[] }
    | { uploads: { key: string; identifier: number }[] }
    | { uploads: { key: string; identifier: string }[] }
    | null,
): Request<unknown, CfProperties<unknown>> {
  return new Request('https://probe.invalid/run', { method: 'POST', body: JSON.stringify(body) });
}
void test('cleanup probe only aborts the exact recorded archive upload', async () => {
  const calls: unknown[] = [];
  const env = {
    EXAMPLE_BUCKET: {
      resumeMultipartUpload(...args: unknown[]): { abort(): Promise<void> } {
        jsonArray(calls).push(args);
        return {
          async abort(): Promise<void> {
            jsonArray(calls).push('aborted');
          },
        };
      },
    },
  };
  assert.equal(
    await callTestMethod(
      await callTestMethod(probe, 'fetch', new Request('https://probe.invalid/health'), env),
      'text',
    ),
    'ready',
  );
  assert.equal(
    jsonObject(await callTestMethod(probe, 'fetch', new Request('https://probe.invalid/run'), env))
      .status,
    404,
  );
  assert.equal(
    jsonObject(
      await callTestMethod(
        probe,
        'fetch',
        new Request('https://probe.invalid/other', { method: 'POST' }),
        env,
      ),
    ).status,
    404,
  );
  assert.deepEqual(
    await callTestMethod(
      await callTestMethod(
        probe,
        'fetch',
        request({ uploads: [{ key, identifier: 'receipt' }] }),
        env,
      ),
      'json',
    ),
    { passed: true },
  );
  assert.deepEqual(calls, [[key, 'receipt'], 'aborted']);
});
for (const value of [
  null,
  42,
  {},
  { uploads: null },
  { uploads: [] },
  { uploads: [1, 2] },
  { uploads: [null] },
  { uploads: [42] },
  { uploads: [{}] },
  { uploads: [{ key: 'other' }] },
  { uploads: [{ key }] },
  { uploads: [{ key, identifier: 42 }] },
  { uploads: [{ key, identifier: '' }] },
  { uploads: [{ key, identifier: 'x'.repeat(2049) }] },
]) {
  void test(`cleanup rejects invalid scope ${JSON.stringify(value).slice(0, 100)}`, async () => {
    const response = await callTestMethod(probe, 'fetch', request(value), {});
    assert.equal(jsonObject(response).status, 500);
    assert.deepEqual(await callTestMethod(response, 'json'), { passed: false });
  });
}
void test('cleanup contains malformed JSON and native abort failures', async () => {
  assert.equal(
    jsonObject(
      await callTestMethod(
        probe,
        'fetch',
        new Request('https://probe.invalid/run', { method: 'POST', body: '{' }),
        {},
      ),
    ).status,
    500,
  );
  const env = {
    EXAMPLE_BUCKET: {
      resumeMultipartUpload(): { abort(): Promise<never> } {
        return {
          async abort(): Promise<never> {
            throw new Error('native failure');
          },
        };
      },
    },
  };
  assert.equal(
    jsonObject(
      await callTestMethod(
        probe,
        'fetch',
        request({ uploads: [{ key, identifier: 'x'.repeat(2048) }] }),
        env,
      ),
    ).status,
    500,
  );
});
