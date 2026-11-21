import { jsonObject, jsonString } from '../../../../../../scripts/testing/Support/json.mts';
import { jsonValue } from '../../../../../../scripts/testing/Support/json.mts';
import { it, expect } from 'vitest';

export function registerUrlShortenerLeaseBoundaries(
  probe: (namespace: unknown, mode: number) => Promise<string>,
): void {
  for (const scenario of [
    'success',
    'release-conflict',
    'acquire-failure',
    'invalid-json',
    'oversized',
    'renew-failure',
    'release-failure',
    'transport-failure',
    'action-failure',
  ] as const) {
    it(`Haskell coordinator lease transport and cleanup: ${scenario}`, async () => {
      const calls: string[] = [];
      const namespace = {
        getByName(name: string): {
          fetch(request: Request<unknown, CfProperties<unknown>>): Promise<Response>;
        } {
          expect(name).toBe('csv-exports');
          return {
            async fetch(request: Request): Promise<Response> {
              const path = new URL(request.url).pathname;
              calls.push(path);
              const payload = jsonObject(await request.json());
              expect(payload.export).toBe('boundary-export');

              if (scenario === 'transport-failure') {
                throw new Error('transport_failed');
              }

              if (path === '/acquire') {
                if (scenario === 'acquire-failure') {
                  return new Response('busy', { status: 409 });
                }

                if (scenario === 'invalid-json') {
                  return new Response('not-json');
                }

                if (scenario === 'oversized') {
                  return new Response('x'.repeat(4097));
                }

                return Response.json({
                  export: 'boundary-export',
                  token: 'lease-token',
                  expiresAt: 9999999999999,
                });
              }

              expect(payload.token).toBe('lease-token');

              if (path === '/renew') {
                return new Response(null, {
                  status: scenario === 'renew-failure' ? 409 : 200,
                });
              }

              return new Response(null, {
                status: (() => {
                  if (scenario === 'release-failure') {
                    return 500;
                  }

                  if (scenario === 'release-conflict') {
                    return 409;
                  }

                  return 204;
                })(),
              });
            },
          };
        },
      };
      const result = jsonObject(
        jsonValue(await probe(namespace, scenario === 'action-failure' ? 1 : 0)),
      );
      const acquired = ![
        'acquire-failure',
        'invalid-json',
        'oversized',
        'transport-failure',
      ].includes(scenario);
      expect(result.ran).toBe(acquired);
      expect(result.ok).toBe(['success', 'release-conflict'].includes(scenario));
      expect(calls).toEqual(
        (() => {
          if (!acquired) {
            return ['/acquire'];
          }

          if (scenario === 'action-failure') {
            return ['/acquire', '/release'];
          }

          return ['/acquire', '/renew', '/release'];
        })(),
      );

      if (scenario === 'action-failure') {
        expect(result.error).toContain('action_failed');
      }
    });
  }
}
