import { jsonObject, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { describe, expect, it } from 'vitest';
import { clientRetryExtraProbe, clientServiceProbe } from '../../../../tests/runtime/harness.js';

export function registerClientRetryExtraCases(): void {
  describe('Client observed policy and streaming request contracts', () => {
    it('converts query flags, empty values, encoded names and malformed header bytes', async () => {
      expect(jsonValue(await clientRetryExtraProbe({}, 'query-fields'))).toEqual({
        ok: true,
        value: {
          url: 'https://service.example/api?a%26b=first%20value&flag&empty=',
          header: '\ufffd',
        },
      });
    });
    it('reports scoped reader failure and recovers', async () => {
      const failed = {
        async fetch(): Promise<Response> {
          return new Response(
            new ReadableStream({
              pull(controller: ReadableStreamDefaultController<unknown>): void {
                controller.error(new Error('scoped-reader-failed'));
              },
            }),
          );
        },
      };
      const result = jsonValue(await clientRetryExtraProbe(failed, 'service-strict'));
      expect(jsonObject(result).ok).toBe(true);
      expect(jsonObject(jsonObject(result).value).body).toContain('scoped-reader-failed');
      expect(
        jsonValue(
          await clientRetryExtraProbe(
            {
              async fetch(): Promise<Response> {
                return new Response('recovered');
              },
            },
            'service-strict',
          ),
        ),
      ).toEqual({
        ok: true,
        value: { status: 200, reason: '', body: 'recovered' },
      });
    });
    for (const mode of [
      'stream-put',
      'zero-retry',
      'negative-retry',
      'no-retry-post',
      'stream-request-error',
    ]) {
      it(`returns the first successful response in ${mode}`, async () => {
        const original = globalThis.fetch;
        let calls = 0;
        const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          calls += 1;
          const request = new Request(input, init);

          if (mode === 'stream-request-error') {
            await request.body?.cancel();
          } else {
            await request.text();
          }
          return new Response('first-success');
        };
        try {
          globalThis.fetch = fetch;
          expect(jsonValue(await clientServiceProbe({ fetch }, mode))).toEqual({
            ok: true,
            value: 'first-success',
          });
          expect(calls).toBe(1);
        } finally {
          globalThis.fetch = original;
        }
      });
    }
    it('preserves service dispatch order and selected values through instance defaults', async () => {
      const original = globalThis.fetch;
      const calls: string[] = [];
      let globalCalls = 0;
      try {
        globalThis.fetch = async () => {
          globalCalls += 1;
          return new Response('wrong');
        };
        const binding = {
          async fetch(request: Request): Promise<Response> {
            calls.push(request.url);
            return new Response(String(calls.length));
          },
        };
        expect(jsonValue(await clientRetryExtraProbe(binding, 'instances'))).toEqual({
          ok: true,
          value: { replaced: 'selected', combined: '23', right: '5', left: '6' },
        });
        expect(calls).toEqual(Array(7).fill('https://service.example/api'));
        expect(globalCalls).toBe(0);
      } finally {
        globalThis.fetch = original;
      }
    });
    it('compares normalized options and preserves typed error diagnostics', async () => {
      const result = jsonValue(await clientRetryExtraProbe({}, 'derived'));
      const options =
        'FetchClientOptions {fetchClientOptionsTimeoutMillis = 1, fetchClientOptionsMaxRetryAttempts = 0, fetchClientOptionsRetryBaseDelayMillis = 0}';
      expect(result).toEqual({
        ok: true,
        value: {
          optionsEqual: true,
          optionsDistinct: true,
          optionsShow: options,
          optionsList: `[${options}]`,
          errorsEqual: true,
          errorsDistinct: true,
          errorsShow: [
            'FetchTimedOut',
            'FetchSubrequestLimitExceeded',
            'FetchNetworkFailure "detail"',
          ],
          errorsList: '[FetchTimedOut,FetchSubrequestLimitExceeded,FetchNetworkFailure "detail"]',
          caught: 'FetchNetworkFailure "detail"',
          backtrace: true,
        },
      });
    });
    it('saturates an already-capped retry delay without sleeping', async () => {
      expect(jsonValue(await clientRetryExtraProbe({}, 'policy'))).toEqual({
        ok: true,
        value: { delays: [60000, 60000, 60000], constructor: 'FetchSubrequestLimitExceeded' },
      });
    });
    it('retains diagnostic request coordinates while erasing request bytes', async () => {
      expect(jsonValue(await clientRetryExtraProbe({}, 'diagnostic'))).toEqual({
        ok: true,
        value: { path: '/items/%2F', host: 'service.example', bodyErased: true, status: 503 },
      });
    });
    for (const mode of ['service-strict', 'service-lazy', 'global-strict', 'global-lazy']) {
      it(`observes both request and response metadata in ${mode}`, async () => {
        const original = globalThis.fetch;
        const bodies: string[] = [];
        const fetch = async (input: RequestInfo | URL): Promise<Response> => {
          bodies.push(await new Request(input).text());
          return new Response('received', { status: 201, statusText: 'Created' });
        };
        try {
          globalThis.fetch = fetch;
          expect(jsonValue(await clientRetryExtraProbe({ fetch }, mode))).toEqual({
            ok: true,
            value: {
              status: 201,
              reason: mode.startsWith('global') ? 'Created' : '',
              body: 'received',
            },
          });
          expect(bodies).toEqual([mode.endsWith('lazy') ? 'lazy-stream' : 'strict-stream']);
        } finally {
          globalThis.fetch = original;
        }
      });
    }
    it('preserves buffered status reason and bytes', async () => {
      const original = globalThis.fetch;
      try {
        globalThis.fetch = async () =>
          new Response('buffered', { status: 202, statusText: 'Accepted' });
        expect(jsonValue(await clientRetryExtraProbe({}, 'buffered-metadata'))).toEqual({
          ok: true,
          value: { status: 202, reason: 'Accepted', body: 'buffered' },
        });
      } finally {
        globalThis.fetch = original;
      }
    });
    it('classifies streaming dispatch failure before invoking its body callback', async () => {
      const original = globalThis.fetch;
      let calls = 0;
      try {
        globalThis.fetch = async () => {
          calls += 1;
          throw new Error('Too many subrequests');
        };
        const failure = jsonValue(await clientRetryExtraProbe({}, 'global-strict'));
        expect(jsonObject(failure).ok).toBe(false);
        expect(jsonObject(failure).message).toContain('FetchSubrequestLimitExceeded');
        expect(calls).toBe(1);
        globalThis.fetch = async () => new Response('recovered');
        expect(jsonValue(await clientServiceProbe({}, 'global-buffered'))).toEqual({
          ok: true,
          value: 'recovered',
        });
      } finally {
        globalThis.fetch = original;
      }
    });
  });
}
