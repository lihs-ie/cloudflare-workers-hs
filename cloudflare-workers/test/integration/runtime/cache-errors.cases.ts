import { expect, it } from 'vitest';
import { jsonObject } from '../../../../scripts/testing/Support/json.mts';
import { cacheProbe, emptyResponse, probe, withCache } from './binding-error-fixtures.js';
export function registerCacheErrorsCases(): void {
  it('converts cache open rejection to CacheOpenFailed and allows subsequent open', async () => {
    const result = await withCache(
      () => Promise.reject(new Error('open failed')),
      () => probe(null, 'open'),
    );
    expect(result).toMatchObject({ ok: false, kind: 'CacheOpenFailed' });
    expect(jsonObject(result).message).toContain('open failed');
    expect(await cacheProbe({}, 'open')).toEqual({ ok: true, value: { opened: true } });
  });
  it('classifies cache put failures while forwarding a public Request key and response', async () => {
    for (const [message, kind] of [
      ['request method invalid', 'CachePutInvalidMethod'],
      ['status 206', 'CachePutPartialResponse'],
      ['Vary: *', 'CachePutVaryWildcard'],
      ['not cacheable', 'CachePutNotCacheableOrTooLarge'],
      ['too large', 'CachePutNotCacheableOrTooLarge'],
      ['storage unavailable', 'CachePutOther'],
    ] as const) {
      const result = await cacheProbe(
        {
          put(): never {
            throw new Error(message);
          },
        },
        'put',
      );
      expect(result).toMatchObject({ ok: false, kind: `CachePutRejected:${kind}` });
      expect(jsonObject(result).message).toContain(message);
    }
    let calls = 0;
    const result = await cacheProbe(
      {
        async put(request: Request, response: Response): Promise<void> {
          expect(request.method).toBe('GET');
          expect(request.headers.get('x-fixture')).toBe('request');
          expect(await response.text()).toBe('payload');
          calls += 1;
        },
      },
      'put',
    );
    expect(result).toEqual({ ok: true, value: { stored: true } });
    expect(calls).toBe(1);
  });
  it('converts cache delete failures and observes false and true settlements with ignoreMethod', async () => {
    expect(
      await cacheProbe(
        {
          delete(): never {
            throw new Error('delete failed');
          },
        },
        'delete',
      ),
    ).toMatchObject({ ok: false, kind: 'CacheDeleteFailed' });
    for (const deleted of [false, true]) {
      expect(
        await cacheProbe(
          {
            delete(request: Request, options: CacheQueryOptions): Promise<boolean> {
              expect(request.url).toBe('https://cache.example/fixture?key=1');
              expect(options.ignoreMethod).toBe(true);
              return Promise.resolve(deleted);
            },
          },
          'delete',
        ),
      ).toEqual({ ok: true, value: { deleted } });
    }
  });
  it('decodes absent and bodyless cache matches and catches response getter failures', async () => {
    for (const absent of [null, undefined]) {
      expect(await cacheProbe({ match: () => absent }, 'match')).toEqual({
        ok: true,
        value: { missing: true },
      });
    }
    const failures = [
      {
        match(): never {
          throw new Error('match failed');
        },
      },
      {
        match: () => ({
          get status(): void {
            throw new Error('status getter');
          },
        }),
      },
      {
        match: () => ({
          status: 200,
          get headers(): void {
            throw new Error('headers getter');
          },
        }),
      },
      {
        match: () => ({
          status: 200,
          headers: new Headers(),
          get body(): void {
            throw new Error('body getter');
          },
        }),
      },
      ...[-1, 0.5, NaN, 2147483648].map((status) => ({ match: () => ({ status }) })),
    ];
    for (const cache of failures) {
      expect(await cacheProbe(cache, 'match')).toMatchObject({
        ok: false,
        kind: 'CacheMatchFailed',
      });
      expect(await cacheProbe({ match: emptyResponse }, 'match')).toEqual({
        ok: true,
        value: {
          status: 204,
          headers: [['x-fixture', 'response']],
          body: { kind: 'bytes', length: 0 },
        },
      });
    }
    expect(await cacheProbe({ match: () => new Response('stream') }, 'match')).toMatchObject({
      ok: true,
      value: { status: 200, body: { kind: 'stream' } },
    });
  });
  it('preserves the custom purge option contract independently of native availability', async () => {
    for (const [command, options] of [
      ['purge-tags', { tags: ['tag-one', 'tag-two'] }],
      ['purge-prefixes', { pathPrefixes: ['/one', '/two'] }],
      ['purge-all', { purgeEverything: true }],
    ] as const) {
      expect(
        await probe(
          {
            cache: {
              purge(actual: unknown): {
                success: boolean;
                errors: { code: number; message: string }[];
              } {
                expect(actual).toEqual(options);
                return { success: false, errors: [{ code: 42, message: 'policy rejection' }] };
              },
            },
          },
          command,
        ),
      ).toEqual({ ok: true, value: { success: false, errors: [[42, 'policy rejection']] } });
    }
  });
  it('converts rejected, malformed, and throwing purge results to CachePurgeFailed and recovers', async () => {
    const failures = [
      {},
      {
        cache: {
          purge(): never {
            throw new Error('purge failed');
          },
        },
      },
      {
        cache: {
          purge(): never {
            throw {
              toString(): never {
                throw new Error('unprintable');
              },
            };
          },
        },
      },
      ...[
        null,
        {},
        { success: 'true' },
        {
          get success(): void {
            throw new Error('success getter');
          },
        },
        {
          success: false,
          get errors(): void {
            throw new Error('errors getter');
          },
        },
        { success: false, errors: [{ code: -1, message: 'invalid' }] },
      ].map((result) => ({ cache: { purge: () => result } })),
    ];
    for (const context of failures) {
      expect(await probe(context, 'purge-all')).toMatchObject({
        ok: false,
        kind: 'CachePurgeFailed',
      });
      expect(await probe({ cache: { purge: () => ({ success: true }) } }, 'purge-all')).toEqual({
        ok: true,
        value: { success: true, errors: [] },
      });
    }
  });
  it('reads the cached stream payload through the public Haskell consumer', async () => {
    for (const bytes of [[0, 127, 128, 255], []] as const) {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>): void {
          pulls += 1;

          if (bytes.length > 0) {
            controller.enqueue(new Uint8Array(bytes));
          }

          controller.close();
        },
      });
      expect(await cacheProbe({ match: () => new Response(body) }, 'match-read')).toEqual({
        ok: true,
        value: { bytes },
      });
      expect(pulls).toBe(1);
    }
  });
  it('catches every late custom-purge field failure without leaking unhandled rejections', async () => {
    let successReads = 0;
    let errorsReads = 0;
    let changedErrorsReads = 0;
    const throwingEntry: unknown[] = [null];
    Object.defineProperty(throwingEntry, '0', {
      get(): never {
        throw new Error('entry getter failed');
      },
    });
    const throwingLength = new Proxy([], {
      get(target: never[], property: string | symbol, receiver: unknown): unknown {
        if (property === 'length') {
          throw new Error('length getter failed');
        }

        return Reflect.get(target, property, receiver);
      },
    });
    const results = [
      {
        success: false,
        errors: [
          {
            code: 42,
            get message(): void {
              throw new Error('message getter failed');
            },
          },
        ],
      },
      {
        get success(): boolean {
          successReads += 1;

          if (successReads === 1) {
            return false;
          }

          throw new Error('second success read failed');
        },
      },
      {
        success: false,
        get errors(): never[] {
          errorsReads += 1;

          if (errorsReads === 1) {
            return [];
          }

          throw new Error('second errors read failed');
        },
      },
      {
        success: 'malformed',
        get errors(): void {
          throw new Error('diagnostic getter failed');
        },
      },
      { success: false, errors: throwingEntry },
      { success: false, errors: throwingLength },
      {
        success: false,
        get errors(): {} {
          changedErrorsReads += 1;
          return changedErrorsReads === 1 ? [] : {};
        },
      },
      { success: false, errors: new Array(2147483648) },
    ];
    for (const result of results) {
      expect(await probe({ cache: { purge: () => result } }, 'purge-all')).toMatchObject({
        ok: false,
        kind: 'CachePurgeFailed',
      });
      expect(await probe({ cache: { purge: () => ({ success: true }) } }, 'purge-all')).toEqual({
        ok: true,
        value: { success: true, errors: [] },
      });
    }
    expect(successReads).toBe(2);
    expect(errorsReads).toBe(2);
    expect(changedErrorsReads).toBe(2);
  });
  it('reads public cache-policy selectors and reports comparable configuration diagnostics', async () => {
    const result = await probe(null, 'policy-contract');
    expect(jsonObject(result).ok).toBe(true);
    expect(jsonObject(jsonObject(result).value).policies).toEqual([
      {
        maxAge: 10,
        sharedMaxAge: 20,
        stale: 30,
        header: 'public, max-age=10, s-maxage=20, stale-while-revalidate=30',
      },
      { maxAge: null, sharedMaxAge: null, stale: null, header: 'private' },
    ]);
    for (const [key, constructor] of [
      ['directive', 'CachePublic'],
      ['query', 'CacheQueryOptions'],
      ['purge', 'PurgeTags'],
      ['error', 'CachePurgeError'],
    ] as const) {
      expect(jsonObject(jsonObject(result).value)[key]).toMatchObject({
        matches: true,
        differs: true,
      });
      expect(jsonObject(jsonObject(jsonObject(result).value)[key]).summary).toContain(constructor);
      expect(jsonObject(jsonObject(jsonObject(result).value)[key]).batch).toBe(
        `[${jsonObject(jsonObject(jsonObject(result).value)[key]).summary}]`,
      );
      expect(jsonObject(jsonObject(jsonObject(result).value)[key]).nested).toBe(
        `(${jsonObject(jsonObject(jsonObject(result).value)[key]).summary})`,
      );
    }
  });
  it('compares actual typed purge and cache failures with expected errors and renders diagnostics', async () => {
    const results = [
      await probe(
        {
          cache: {
            purge: () => ({ success: false, errors: [{ code: 42, message: 'policy rejection' }] }),
          },
        },
        'purge-contract',
      ),
      await probe(
        {
          cache: {
            purge(): never {
              throw new Error('purge failed');
            },
          },
        },
        'purge-failure-contract',
      ),
    ];
    for (const result of results) {
      expect(jsonObject(result).ok).toBe(true);
      expect(jsonObject(result).value).toMatchObject({ matches: true, differs: true });
      expect(jsonObject(jsonObject(result).value).summary).toContain('CachePurge');
      expect(jsonObject(jsonObject(result).value).batch).toBe(
        `[${jsonObject(jsonObject(result).value).summary}]`,
      );
      expect(jsonObject(jsonObject(result).value).nested).toBe(
        `(${jsonObject(jsonObject(result).value).summary})`,
      );
    }
    const put = await cacheProbe(
      {
        put(): never {
          throw new Error('request method invalid');
        },
      },
      'put-contract',
    );
    expect(jsonObject(put).ok).toBe(true);
    expect(jsonObject(jsonObject(put).value).failure).toMatchObject({
      matches: true,
      differs: true,
    });
    expect(jsonObject(jsonObject(jsonObject(put).value).failure).summary).toBe(
      'CachePutRejected CachePutInvalidMethod "Error: request method invalid"',
    );
    expect(jsonObject(jsonObject(jsonObject(put).value).failure).batch).toBe(
      `[${jsonObject(jsonObject(jsonObject(put).value).failure).summary}]`,
    );
    expect(jsonObject(jsonObject(jsonObject(put).value).failure).nested).toBe(
      `(${jsonObject(jsonObject(jsonObject(put).value).failure).summary})`,
    );
    expect(jsonObject(jsonObject(put).value).kind).toEqual({
      matches: true,
      differs: true,
      summary: 'CachePutInvalidMethod',
      batch: '[CachePutInvalidMethod]',
      nested: 'CachePutInvalidMethod',
    });
  });
  it('reports a cached stream read error and recovers with a new cached response', async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>): void {
          controller.error(new Error('cached stream failed'));
        },
      }),
    );
    const result = await cacheProbe({ match: () => response }, 'match-read');
    expect(result).toMatchObject({ ok: false, kind: 'UnexpectedException' });
    expect(jsonObject(result).message).toContain('cached stream failed');
    const oversized = await cacheProbe(
      { match: () => new Response(new Uint8Array(1025)) },
      'match-read',
    );
    expect(oversized).toMatchObject({ ok: false, kind: 'UnexpectedException' });
    expect(jsonObject(oversized).message).toContain('ReadableStreamExceededByteLimit');
    expect(
      await cacheProbe({ match: () => new Response(new Uint8Array([17, 255])) }, 'match-read'),
    ).toEqual({ ok: true, value: { bytes: [17, 255] } });
  });
}
