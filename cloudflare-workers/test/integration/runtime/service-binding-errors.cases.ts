import { expect, it } from 'vitest';
import { jsonObject } from '../../../../scripts/testing/Support/json.mts';
import { emptyResponse, probe } from './binding-error-fixtures.js';
export function registerServiceBindingErrorsCases(): void {
  it('converts Service Binding native failures and invalid response decoding to ServiceFetchFailed', async () => {
    const failures = [
      {
        fetch(): never {
          throw new Error('native failed');
        },
      },
      {
        get fetch(): void {
          throw new Error('fetch getter');
        },
      },
      {
        fetch: () => ({
          get status(): void {
            throw new Error('status getter');
          },
        }),
      },
      {
        fetch: () => ({
          status: 200,
          get headers(): void {
            throw new Error('headers getter');
          },
        }),
      },
      {
        fetch: () => ({
          status: 200,
          headers: new Headers(),
          get body(): void {
            throw new Error('body getter');
          },
        }),
      },
      ...[-1, 0.25, Infinity, 2147483648].map((status) => ({ fetch: () => ({ status }) })),
    ];
    for (const binding of failures) {
      expect(await probe(binding, 'service')).toMatchObject({
        ok: false,
        kind: 'ServiceFetchFailed',
      });
    }
    expect(
      await probe(
        {
          fetch(request: Request): Response {
            expect(request.headers.get('x-fixture')).toBe('request');
            return emptyResponse();
          },
        },
        'service',
      ),
    ).toEqual({
      ok: true,
      value: {
        status: 204,
        headers: [['x-fixture', 'response']],
        body: { kind: 'bytes', length: 0 },
      },
    });
    expect(await probe({ fetch: () => new Response('stream') }, 'service')).toMatchObject({
      ok: true,
      value: { body: { kind: 'stream' } },
    });
  });
  it('classifies invalid service request construction before invoking the binding', async () => {
    let calls = 0;
    expect(
      await probe(
        {
          fetch(): Response {
            calls += 1;
            return emptyResponse();
          },
        },
        'service-invalid-request',
      ),
    ).toMatchObject({ ok: false, kind: 'ServiceFetchFailed' });
    expect(calls).toBe(0);
  });
  it('returns service RPC failures as Left and forwards arguments and receiver during recovery', async () => {
    for (const binding of [
      {},
      {
        operation(): never {
          throw new Error('RPC failed');
        },
      },
    ]) {
      const result = await probe(binding, 'call');
      expect(jsonObject(result).ok).toBe(true);
      expect(jsonObject(jsonObject(result).value).callError).toContain('ServiceCallFailed');
    }
    expect(
      await probe(
        {
          prefix: 'receiver:',
          operation(this: { prefix: string }, argument: string): string {
            return this.prefix + argument;
          },
        },
        'call',
      ),
    ).toEqual({ ok: true, value: { output: 'receiver:argument' } });
  });
}
