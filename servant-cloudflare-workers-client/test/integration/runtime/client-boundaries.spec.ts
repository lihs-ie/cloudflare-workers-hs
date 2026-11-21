import assert from 'node:assert/strict';
import { test } from 'vitest';
import { clientRetryExtraProbe } from '../../../../tests/runtime/harness.js';
import { jsonObject, jsonString, jsonValue } from '../../../../scripts/testing/Support/json.mts';

for (const mode of ['invalid-global-target', 'invalid-service-target']) {
  test(`Client ${mode} rejects malformed URLs before dispatch`, async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls += 1;
      return new Response('unexpected dispatch');
    };
    try {
      globalThis.fetch = fetch;

      const result = jsonObject(jsonValue(await clientRetryExtraProbe({ fetch }, mode)));

      assert.equal(result.ok, false);
      assert.match(jsonString(result.message), /FetchNetworkFailure/);
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
}

for (const mode of ['global-timeout', 'global-subrequest-limit']) {
  test(`Client ${mode} classifies the transport failure without replay and recovers`, async () => {
    const original = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        calls += 1;

        if (mode === 'global-subrequest-limit') {
          throw new Error('Too many subrequests.');
        }

        const request = new Request(input, init);
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => reject(new DOMException('aborted by timeout', 'AbortError'));

          if (request.signal.aborted) {
            abort();
          } else {
            request.signal.addEventListener('abort', abort, { once: true });
          }
        });
      };

      const failed = jsonObject(jsonValue(await clientRetryExtraProbe({}, mode)));

      assert.equal(failed.ok, false);
      assert.match(
        jsonString(failed.message),
        mode === 'global-timeout' ? /FetchTimedOut/ : /FetchSubrequestLimitExceeded/,
      );
      assert.equal(calls, 1);

      globalThis.fetch = async (): Promise<Response> => new Response('recovered');
      const recovered = jsonObject(jsonValue(await clientRetryExtraProbe({}, 'global-strict')));
      assert.equal(recovered.ok, true);
      assert.equal(jsonObject(recovered.value).body, 'recovered');
    } finally {
      globalThis.fetch = original;
    }
  });
}
