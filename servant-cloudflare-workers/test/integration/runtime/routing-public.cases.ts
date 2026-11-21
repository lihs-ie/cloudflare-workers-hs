import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { routingProbe } from '../../../../tests/runtime/harness.js';
export function registerRoutingPublicCases(): void {
  describe('Servant routes through real WASM', () => {
    for (const [mode, method, path, status] of [
      ['no-content-get', 'GET', '/', 204],
      ['no-content-delete', 'DELETE', '/', 204],
      ['no-content-failure', 'DELETE', '/', 400],
      ['no-content-get', 'POST', '/', 405],
      ['head', 'HEAD', '/', 200],
      ['method-choice', 'PUT', '/', 405],
      ['capture-all', 'GET', '/1/2', 200],
      ['capture-all', 'GET', '/oops', 400],
      ['empty', 'GET', '/', 404],
    ] as const) {
      it(`${mode} ${method} ${path}`, async () => {
        const response = await routingProbe(
          mode,
          new Request(`https://fixture.test${path}`, { method }),
          createExecutionContext(),
        );
        expect(response.status).toBe(status);

        if (method === 'HEAD' || status === 204) {
          expect(await response.text()).toBe('');
        }

        if (mode === 'head') {
          expect(response.headers.get('X-Result')).toBe('present');
        }

        if (mode === 'method-choice') {
          const allow = response.headers.get('Allow') ?? '';
          expect(allow).toContain('GET');
          expect(allow).toContain('POST');
        }
      });
    }
    for (const mode of ['empty-prefix', 'named-context']) {
      it(`reaches the ${mode} route instance`, async () => {
        const response = await routingProbe(
          mode,
          new Request('https://fixture.test/'),
          createExecutionContext(),
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toBe(42);
      });
    }
    for (const flag of ['flag', 'flag=1', 'flag=']) {
      it(`recognizes the flag form ${flag} with semicolon separators`, async () => {
        const response = await routingProbe(
          'parameters',
          new Request(`https://fixture.test/?one=7;${flag}`),
          createExecutionContext(),
        );
        expect(await response.json()).toEqual([7, [], true, null]);
      });
    }
    for (const [path, count, status] of [
      ['/12', '3', 200],
      ['/bad', '3', 400],
      ['/12', 'bad', 400],
    ] as const) {
      it(`keeps delayed capture/header failures before Raw: ${path} ${count}`, async () => {
        const response = await routingProbe(
          'capture-raw',
          new Request(`https://fixture.test${path}`, { headers: { 'X-Count': count } }),
          createExecutionContext(),
        );
        expect(response.status).toBe(status);

        if (status === 200) {
          expect(await response.json()).toEqual([12, 3]);
        }
      });
    }
    for (const [method, accept, status] of [
      ['GET', 'application/octet-stream', 206],
      ['HEAD', '*/*', 206],
      ['POST', '*/*', 405],
      ['GET', 'text/plain', 406],
    ] as const) {
      it(`negotiates the native stream ${method} ${accept}`, async () => {
        const response = await routingProbe(
          'native-stream',
          new Request('https://fixture.test/', { method, headers: { Accept: accept } }),
          createExecutionContext(),
        );
        expect(response.status).toBe(status);

        if (status === 206) {
          expect(response.headers.get('X-Stream')).toBe('present');
          expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
          expect(await response.text()).toBe(method === 'HEAD' ? '' : 'stream-body');
        }
      });
    }
    it('checks parameter, body, fallback and cache contracts through the router', async () => {
      const response = await routingProbe(
        'matrix',
        new Request('https://fixture.test/'),
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      const names: unknown = await response.json();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toHaveLength(27);
    });
  });
}
