import { describe, expect, it } from 'vitest';
import { jsonObject, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { clientServiceProbe } from '../../../../tests/runtime/harness.js';
export function registerClientBodyTransportCases(): void {
  describe('Service Binding client body ownership', () => {
    for (const mode of ['throw', 'abandon']) {
      it(`cancels and releases an unread body on ${mode}, then recovers`, async () => {
        let cancelled = 0;
        const stream = new ReadableStream<Uint8Array>({
          cancel(): void {
            cancelled += 1;
          },
        });
        const first = jsonValue(
          await clientServiceProbe(
            {
              fetch(): Promise<Response> {
                return Promise.resolve(new Response(stream));
              },
            },
            mode,
          ),
        );
        expect(jsonObject(first).ok).toBe(mode === 'abandon');
        expect(cancelled).toBe(1);
        expect(stream.locked).toBe(false);
        const next = jsonValue(
          await clientServiceProbe(
            {
              fetch(): Promise<Response> {
                return Promise.resolve(new Response('recovered'));
              },
            },
            'buffered',
          ),
        );
        expect(next).toEqual({ ok: true, value: 'recovered' });
      });
    }
    it('reports response stream failure and permits subsequent calls', async () => {
      const binding = {
        fetch(): Promise<Response> {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                pull(c: ReadableStreamDefaultController<unknown>): void {
                  c.error(new Error('body-failed'));
                },
              }),
              { status: 500 },
            ),
          );
        },
      };
      const failure = jsonValue(await clientServiceProbe(binding, 'drain'));
      expect(jsonObject(failure).ok).toBe(false);
      expect(jsonObject(failure).message).toContain('body-failed');
      expect(
        jsonValue(
          await clientServiceProbe(
            {
              fetch(): Promise<Response> {
                return Promise.resolve(new Response('ok'));
              },
            },
            'buffered',
          ),
        ),
      ).toEqual({ ok: true, value: 'ok' });
    });
  });
  describe('Client transport response variants', () => {
    for (const mode of [
      'strict-request',
      'lazy-request',
      'global-strict-request',
      'global-lazy-request',
    ]) {
      it(`preserves native request bytes for ${mode}`, async () => {
        const original = globalThis.fetch;
        const fetch = async (input: RequestInfo | URL): Promise<Response> =>
          new Response(await new Request(input).text());
        try {
          globalThis.fetch = fetch;
          const result = jsonValue(await clientServiceProbe({ fetch }, mode));
          expect(result).toEqual({
            ok: true,
            value: mode.includes('strict') ? 'strict-body' : 'lazy-body',
          });
        } finally {
          globalThis.fetch = original;
        }
      });
    }
    for (const mode of ['buffered', 'global-buffered', 'global-drain']) {
      it(`propagates body failure on ${mode} and recovers`, async () => {
        const original = globalThis.fetch;
        const fetch = async (): Promise<Response> =>
          new Response(
            new ReadableStream({
              pull(controller: ReadableStreamDefaultController<unknown>): void {
                controller.error(new Error('reader-failure'));
              },
            }),
          );
        try {
          globalThis.fetch = fetch;
          const failure = jsonValue(await clientServiceProbe({ fetch }, mode));
          expect(jsonObject(failure).ok).toBe(false);
          expect(jsonObject(failure).message).toContain('reader-failure');
          globalThis.fetch = async () => new Response('recovered');
          expect(jsonValue(await clientServiceProbe({ fetch: globalThis.fetch }, mode))).toEqual({
            ok: true,
            value: 'recovered',
          });
        } finally {
          globalThis.fetch = original;
        }
      });
    }
    it('handles a successful empty streaming response', async () => {
      const original = globalThis.fetch;
      try {
        globalThis.fetch = async () => new Response(null, { status: 204 });
        expect(jsonValue(await clientServiceProbe({}, 'global-drain'))).toEqual({
          ok: true,
          value: '',
        });
      } finally {
        globalThis.fetch = original;
      }
    });
    it('does not retry the global subrequest limit', async () => {
      const original = globalThis.fetch;
      let calls = 0;
      try {
        globalThis.fetch = async () => {
          calls += 1;
          throw new Error('Too many subrequests');
        };
        const failure = jsonValue(await clientServiceProbe({}, 'global-retry'));
        expect(jsonObject(failure).ok).toBe(false);
        expect(calls).toBe(1);
      } finally {
        globalThis.fetch = original;
      }
    });
  });
  describe('Client request streaming and global fetch recovery', () => {
    for (const mode of ['stream-request', 'stream-request-error']) {
      it(`preserves request producer outcome: ${mode}`, async () => {
        const binding = {
          async fetch(request: Request): Promise<Response> {
            return new Response(new TextDecoder().decode(await request.arrayBuffer()));
          },
        };
        const result = jsonValue(await clientServiceProbe(binding, mode));

        if (mode === 'stream-request') {
          expect(result).toEqual({ ok: true, value: 'firstsecond' });
        } else {
          expect(jsonObject(result).ok).toBe(false);
          expect(jsonObject(result).message).toContain('client request producer failed');
        }
        expect(jsonValue(await clientServiceProbe(binding, 'stream-request'))).toEqual({
          ok: true,
          value: 'firstsecond',
        });
      });
    }
    for (const [mode, failures, expectedCalls, succeeds] of [
      ['global-retry', 2, 3, true],
      ['global-retry', 3, 3, false],
      ['global-no-retry-post', 3, 1, false],
    ] as const) {
      it(`${mode} preserves retry budget with ${failures} failures`, async () => {
        const original = globalThis.fetch;
        let calls = 0;
        try {
          globalThis.fetch = async () => {
            calls += 1;

            if (calls <= failures) {
              throw new Error('network connection failed');
            }

            return new Response('recovered');
          };
          const result = jsonValue(await clientServiceProbe({}, mode));
          expect(calls).toBe(expectedCalls);
          expect(jsonObject(result).ok).toBe(succeeds);

          if (succeeds) {
            expect(jsonObject(result).value).toBe('recovered');
          }

          globalThis.fetch = async () => new Response('following-request');
          expect(jsonValue(await clientServiceProbe({}, 'global-buffered'))).toEqual({
            ok: true,
            value: 'following-request',
          });
        } finally {
          globalThis.fetch = original;
        }
      });
    }
    for (const mode of ['global-throw', 'global-abandon']) {
      it(`releases the global response reader on ${mode}`, async () => {
        const original = globalThis.fetch;
        let cancelled = 0;
        const body = new ReadableStream<Uint8Array>({
          cancel(): void {
            cancelled += 1;
          },
        });
        try {
          globalThis.fetch = async () => new Response(body);
          const result = jsonValue(await clientServiceProbe({}, mode));
          expect(jsonObject(result).ok).toBe(mode === 'global-abandon');
          expect(cancelled).toBe(1);
          expect(body.locked).toBe(false);
        } finally {
          globalThis.fetch = original;
        }
      });
    }
  });
}
