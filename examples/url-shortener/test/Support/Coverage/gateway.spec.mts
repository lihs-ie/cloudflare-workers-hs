import { callTestMethod } from '../../../../../scripts/testing/Support/test-boundary.mts';
import { jsonObject } from '../../../../../scripts/testing/Support/json.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import gateway from '../Dev/gateway.ts';

void test('gateway preserves request method, headers, body, query and response identity', async () => {
  const expected = new Response('delegated', { status: 207 });
  const request = new Request('https://dev.invalid/management/links?cursor=next', {
    method: 'POST',
    headers: { 'X-Trace': 'request' },
    body: 'payload',
  });
  const response = await callTestMethod(gateway, 'fetch', request, {
    management: {
      async fetch(forwarded: unknown): Promise<Response> {
        assert.equal(jsonObject(forwarded).url, 'https://dev.invalid/links?cursor=next');
        assert.equal(jsonObject(forwarded).method, 'POST');
        assert.equal(
          callTestMethod(jsonObject(jsonObject(forwarded).headers), 'get', 'X-Trace'),
          'request',
        );
        assert.equal(await callTestMethod(forwarded, 'text'), 'payload');
        return expected;
      },
    },
  });
  assert.equal(response, expected);
});

void test('gateway rejects unknown bindings and maps an app root to slash', async () => {
  assert.equal((await gateway.fetch(new Request('https://dev.invalid/unknown'), {})).status, 404);
  await callTestMethod(gateway, 'fetch', new Request('https://dev.invalid/redirect'), {
    redirect: {
      async fetch(request: unknown): Promise<Response> {
        assert.equal(jsonObject(request).url, 'https://dev.invalid/');
        return new Response('root');
      },
    },
  });
});
