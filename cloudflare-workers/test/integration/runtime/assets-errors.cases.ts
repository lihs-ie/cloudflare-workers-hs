import { expect, it } from 'vitest';
import { emptyResponse, probe } from './binding-error-fixtures.js';
export function registerAssetsErrorsCases(): void {
  it('converts Assets native and metadata failures without touching its request-scoped body', async () => {
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
      ...[-1, 0.25, Infinity, 2147483648].map((status) => ({ fetch: () => ({ status }) })),
    ];
    for (const binding of failures) {
      expect(await probe(binding, 'assets')).toMatchObject({
        ok: false,
        kind: 'AssetsFetchFailed',
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
        'assets',
      ),
    ).toEqual({
      ok: true,
      value: {
        status: 204,
        headers: [['x-fixture', 'response']],
        body: { kind: 'passthrough' },
      },
    });
    expect(
      await probe(
        {
          fetch: () => ({
            status: 200,
            headers: new Headers(),
            get body(): void {
              throw new Error('body getter');
            },
          }),
        },
        'assets',
      ),
    ).toMatchObject({ ok: true, value: { body: { kind: 'passthrough' } } });
    expect(await probe({ fetch: () => new Response('stream') }, 'assets')).toMatchObject({
      ok: true,
      value: { body: { kind: 'passthrough' } },
    });
  });
}
