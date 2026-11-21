import {
  jsonArray,
  jsonObject,
  jsonSequence,
  jsonString,
} from '../../../../scripts/testing/Support/json.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

export function registerClientPolicyTests(
  request: (path: string, method?: string) => Promise<unknown>,
): void {
  void test('typed client reports HTTP errors separately without retrying them', async () => {
    const result = await request('/client-policy?fixture=http-error');
    for (const name of ['retry', 'post', 'malformed', 'exhausted']) {
      assert.equal(jsonObject(jsonObject(result)[name]).error, 'UnexpectedClientError');
      assert.match(jsonString(jsonObject(jsonObject(result)[name]).detail), /FailureResponse/);
      assert.match(jsonString(jsonObject(jsonObject(result)[name]).detail), /503/);
    }
    assert.deepEqual(
      jsonArray(jsonObject(result).transportAttempts).map((item) => {
        const { path } = jsonObject(item);
        return path;
      }),
      [
        '/client-target/retry',
        '/client-target/no-retry',
        '/client-target/malformed',
        '/client-target/exhausted',
      ],
    );
  });
  void test('typed Service Binding client classifies decode errors and bounds transport retries', async () => {
    const result = await request('/client-policy');
    assert.deepEqual(jsonObject(result).retry, {
      result: { key: 'client-example-stable-key', payload: 'stable payload' },
    });
    assert.deepEqual(jsonObject(result).post, {
      error: 'ConnectionError',
      transport: 'FetchNetworkFailure',
    });
    assert.equal(jsonObject(jsonObject(result).malformed).error, 'DecodeFailure');
    assert.equal(jsonObject(jsonObject(result).malformed).status, 200);
    assert.equal(jsonObject(jsonObject(result).malformed).body, '{invalid-json');
    assert.ok(jsonSequence(jsonObject(jsonObject(result).malformed).message).length > 0);
    assert.deepEqual(jsonObject(result).exhausted, {
      error: 'ConnectionError',
      transport: 'FetchNetworkFailure',
    });
    const calls = (path: string): unknown[] =>
      jsonArray(jsonObject(result).transportAttempts).filter(
        (call) => jsonObject(call).path === `/client-target/${path}`,
      );
    assert.equal(calls('retry').length, 3, 'two retries then real destination success');
    for (const call of calls('retry')) {
      assert.deepEqual(call, {
        path: '/client-target/retry',
        method: 'PUT',
        key: 'client-example-stable-key',
        body: '"stable payload"',
      });
    }
    assert.deepEqual(
      calls('no-retry'),
      [
        {
          path: '/client-target/no-retry',
          method: 'POST',
          key: 'client-example-post-key',
          body: '"mutation payload"',
        },
      ],
      'an idempotency key alone does not authorize retrying a mutation',
    );
    assert.equal(
      calls('malformed').length,
      1,
      'decode failure must not retry successful HTTP transport',
    );
    assert.equal(
      calls('exhausted').length,
      3,
      'GET retries stop after the configured default two attempts',
    );
    assert.equal(jsonSequence(jsonObject(result).transportAttempts).length, 8);
  });
}
