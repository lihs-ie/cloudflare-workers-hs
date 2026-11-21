import { jsonObject, jsonString, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import type { startRuntime } from '../Support/dev-runtime.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Application guards are exercised with controlled native binding responses. */
export function registerR2ExampleExtraTests(
  getRuntime: () => Awaited<ReturnType<typeof startRuntime>>,
): void {
  const run = async (
    mode?:
      | string
      | {
          invalidRangeRejected: boolean;
          accepted?: undefined;
          staleRejected?: undefined;
          unchanged?: undefined;
          wrongMatchHasNoBody?: undefined;
          unchangedHasNoBody?: undefined;
          headerConditionHasNoBody?: undefined;
          missing?: undefined;
          beforePastRejected?: undefined;
          afterFutureRejected?: undefined;
        }
      | {
          accepted: boolean;
          staleRejected: boolean;
          unchanged: boolean;
          invalidRangeRejected?: undefined;
          wrongMatchHasNoBody?: undefined;
          unchangedHasNoBody?: undefined;
          headerConditionHasNoBody?: undefined;
          missing?: undefined;
          beforePastRejected?: undefined;
          afterFutureRejected?: undefined;
        }
      | {
          wrongMatchHasNoBody: boolean;
          unchangedHasNoBody: boolean;
          headerConditionHasNoBody: boolean;
          missing: boolean;
          invalidRangeRejected?: undefined;
          accepted?: undefined;
          staleRejected?: undefined;
          unchanged?: undefined;
          beforePastRejected?: undefined;
          afterFutureRejected?: undefined;
        }
      | {
          beforePastRejected: boolean;
          afterFutureRejected: boolean;
          invalidRangeRejected?: undefined;
          accepted?: undefined;
          staleRejected?: undefined;
          unchanged?: undefined;
          wrongMatchHasNoBody?: undefined;
          unchangedHasNoBody?: undefined;
          headerConditionHasNoBody?: undefined;
          missing?: undefined;
        },
  ): Promise<unknown> => {
    const response = await fetch(`${getRuntime().base}/__fixture/r2-extra/${mode}`, {
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  void test('unknown R2 scenario is sanitized and worker remains usable', async () => {
    const response = await fetch(`${getRuntime().base}/r2/unknown-wave6`, { method: 'POST' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
    const healthy = await fetch(`${getRuntime().base}/health`);
    assert.equal(healthy.status, 200);
    await healthy.text();
  });
  void test('public Request PUT without body reader rejects before storage', async () => {
    const response = await fetch(`${getRuntime().base}/__fixture/attachment-missing-reader`);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'Attachment body is required');
  });
  for (const mode of [
    'store-rejected',
    'reader-missing',
    'checksum-rejected',
    'infrequent-rejected',
    'body-missing',
  ]) {
    void test(`R2 malformed binding outcome ${mode} does not become a successful response`, async () => {
      const result = await run(mode);
      assert.equal(jsonObject(result).status, 500);
      assert.deepEqual(jsonValue(jsonObject(result).body), { error: 'internal_error' });
      assert.deepEqual(jsonObject(result).calls, [
        ['reader-missing', 'body-missing'].includes(mode) ? 'get' : 'put',
      ]);
    });
  }
  for (const [mode, expected] of [
    ['range-ignored', { invalidRangeRejected: false }],
    ['write-reversed', { accepted: false, staleRejected: false, unchanged: false }],
    [
      'conditional-ignored',
      {
        wrongMatchHasNoBody: false,
        unchangedHasNoBody: false,
        headerConditionHasNoBody: false,
        missing: false,
      },
    ],
    ['browse-ignored', { beforePastRejected: false, afterFutureRejected: false }],
  ] as const) {
    void test(`R2 scenario reports unsupported native conditions honestly: ${mode}`, async () => {
      const result = await run(mode);
      assert.equal(jsonObject(result).status, 200);
      const body = jsonValue(jsonObject(result).body);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(jsonObject(body)[key], value, key);
      }
    });
  }
  for (const mode of ['unknown', 'reader-missing', 'stream-supported']) {
    void test(`R2 failure fixture handles ${mode} native outcome`, async () => {
      const response = await fetch(`${getRuntime().base}/__fixture/r2-failure-extra/${mode}`);
      assert.equal(response.status, 200);
      const result = await response.json();

      if (mode === 'stream-supported') {
        assert.deepEqual(result, { result: { unknownLengthRejected: false, objectAbsent: false } });
      } else {
        assert.equal(jsonObject(result).rejected, true);
        assert.match(
          jsonString(jsonObject(result).message),
          mode === 'unknown' ? /Unknown R2 failure scenario/ : /Reader failure fixture missing/,
        );
      }
    });
  }
  for (const [mode, body] of [
    ['archive-error', 'Archive storage failed'],
    ['archive-precondition', 'Archive body unavailable'],
    ['attachment-error', 'Attachment storage failed'],
    ['attachment-precondition', 'Attachment body is unavailable'],
  ] as const) {
    void test(`R2 application rejects ${mode} without exposing native exception`, async () => {
      const result = await run(mode);
      assert.deepEqual(result, { status: 502, body, calls: ['get'] });
    });
  }
  void test('attachment conditional write reports conflict', async () => {
    assert.deepEqual(await run('attachment-conflict'), {
      status: 409,
      body: 'Attachment write conflict',
      calls: ['put'],
    });
  });
  void test('archive failed part aborts multipart exactly once', async () => {
    assert.deepEqual(await run('multipart-abort'), {
      status: 502,
      body: 'Archive storage failed',
      calls: ['uploadPart', 'abort'],
    });
  });
  for (const [mode, pages] of [
    ['list-missing', 1],
    ['list-repeat', 2],
    ['list-bound', 10],
  ] as const) {
    void test(`R2 listing terminates malformed pagination ${mode}`, async () => {
      const result = await run(mode);
      assert.equal(jsonObject(result).status, 500);
      assert.deepEqual(jsonValue(jsonObject(result).body), { error: 'internal_error' });
      assert.deepEqual(jsonObject(result).calls, Array(pages).fill('list'));
      const health = await fetch(`${getRuntime().base}/health`);
      assert.equal(health.status, 200);
      await health.text();
    });
  }
}
