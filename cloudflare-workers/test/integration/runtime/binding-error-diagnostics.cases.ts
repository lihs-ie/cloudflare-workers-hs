import { expect, it } from 'vitest';
import { jsonObject } from '../../../../scripts/testing/Support/json.mts';
import { cacheProbe, emptyResponse, probe } from './binding-error-fixtures.js';
export function registerBindingErrorDiagnosticsCases(): void {
  it('compares and displays public Assets and ServiceBinding error values', async () => {
    for (const [command, constructor] of [
      ['assets-contract', 'AssetsFetchFailed'],
      ['service-contract', 'ServiceFetchFailed'],
    ] as const) {
      const failure = await probe(
        {
          fetch(): never {
            throw new Error('fetch failed');
          },
        },
        command,
      );
      expect(jsonObject(failure).ok).toBe(true);
      expect(jsonObject(failure).value).toEqual({
        matches: true,
        differs: true,
        summary: `${constructor} "Error: fetch failed"`,
        batch: `[${constructor} "Error: fetch failed"]`,
        nested: `(${constructor} "Error: fetch failed")`,
      });
      const expectedBody =
        command === 'assets-contract' ? { kind: 'passthrough' } : { kind: 'bytes', length: 0 };
      expect(await probe({ fetch: emptyResponse }, command)).toMatchObject({
        ok: true,
        value: { status: 204, body: expectedBody },
      });
    }
  });
  it('reports invalid fixture modes and unsatisfied scenario preconditions without poisoning subsequent probes', async () => {
    const results = [
      [await cacheProbe({}, 'unknown-mode'), 'Unknown cache/service scenario'],
      [
        await probe({ cache: { purge: () => ({ success: true }) } }, 'purge-failure-contract'),
        'Expected typed purge rejection',
      ],
      [await cacheProbe({ put(): void {} }, 'put-contract'), 'Expected typed cache put rejection'],
      [await cacheProbe({ match: emptyResponse }, 'match-read'), 'Expected cached stream body'],
      [await cacheProbe({ match: () => undefined }, 'match-read'), 'Expected cache hit'],
    ] as const;
    for (const [result, message] of results) {
      expect(result).toMatchObject({ ok: false, kind: 'UnexpectedException' });
      expect(jsonObject(result).message).toContain(message);
      expect(await cacheProbe({}, 'open')).toEqual({ ok: true, value: { opened: true } });
    }
  });
}
