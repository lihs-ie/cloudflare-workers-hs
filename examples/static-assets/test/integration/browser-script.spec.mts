import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Script, createContext } from 'node:vm';
import { test } from 'node:test';
const filename = fileURLToPath(new URL('../../public/app.js', import.meta.url));
const source = await readFile(filename, 'utf8');

for (const outcome of ['success', 'http-error', 'transport-error', 'invalid-json']) {
  void test(`browser health button handles ${outcome}`, async () => {
    const status = { textContent: 'initial' };
    let listener: (() => Promise<void>) | undefined;
    let called;
    const context = createContext({
      document: {
        querySelector(
          selector: unknown,
        ):
          | { textContent: string }
          | { addEventListener(event: unknown, callback: () => Promise<void>): void } {
          return selector === '#status'
            ? status
            : {
                addEventListener(event: unknown, callback: () => Promise<void>): void {
                  assert.equal(selector, '#check');
                  assert.equal(event, 'click');
                  listener = callback;
                },
              };
        },
      },
      fetch: async (url: unknown) => {
        called = url;

        if (outcome === 'transport-error') {
          throw new Error('Disconnected');
        }

        return {
          ok: outcome !== 'http-error',
          async json(): Promise<{ status: string; runtime: string }> {
            if (outcome === 'invalid-json') {
              throw new SyntaxError('Invalid JSON');
            }

            return { status: 'ok', runtime: 'Haskell' };
          },
        };
      },
    });
    new Script(source, { filename }).runInContext(context);
    assert.ok(listener);
    const pending = listener();
    assert.equal(status.textContent, '確認中…');
    await pending;
    assert.equal(called, '/api/health');
    assert.equal(
      status.textContent,
      outcome === 'success' ? 'ok — Haskell' : '接続できませんでした。もう一度お試しください。',
    );
  });
}
