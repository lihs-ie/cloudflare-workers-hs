import type * as Module from 'node:module';
import {
  jsonArray,
  jsonObject,
  jsonString,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  callTestMethod,
  constructTestBoundary,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
/** Node boundary tests of fixture orchestration, not Haskell or native service proofs. */
import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  resolve(
    specifier: string,
    context: Module.ResolveHookContext,
    next: (
      specifier: string,
      context?: Partial<Module.ResolveHookContext>,
    ) => Module.ResolveFnOutput,
  ): import('module').ResolveFnOutput {
    if (specifier === 'cloudflare:workers') {
      return {
        url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
        shortCircuit: true,
      };
    }

    if (specifier.startsWith('.') && (specifier.endsWith('.js') || specifier === './runtime')) {
      const path = specifier === './runtime' ? './runtime.ts' : specifier.slice(0, -3) + '.ts';
      return next(path, context);
    }

    return next(specifier, context);
  },
});
const reactor: Record<string, unknown> = {};
const runtimeMocks = ['./runtime.ts', '../../worker/runtime.ts'].map((path) =>
  mock.module(new URL(path, import.meta.url).href, {
    namedExports: { reactor },
  }),
);
const { inspectClientStream } = await loadTestModule(
  new URL('./client-stream.ts', import.meta.url).href,
);
void after(() => {
  runtimeMocks.forEach((item) => item.restore());
  hooks.deregister();
});
void test('stream fixtures reject unknown modes and expose controlled stream failures', async () => {
  for (const mode of [null, 'unknown']) {
    assert.equal(jsonObject(await callTestBoundary(inspectClientStream, mode)).status, 400);
  }
  for (const [mode, expectedMode] of [
    ['eof', 0],
    ['early', 1],
    ['consumer-before', 2],
    ['consumer-after', 3],
    ['read-failure', 0],
    ['cancel-failure', 3],
    ['http-error', 0],
  ] as const) {
    reactor.clientStreamLifecycle = async (
      binding: { fetch: () => unknown },
      callbackMode: unknown,
    ) => {
      assert.equal(callbackMode, expectedMode);
      const response = await binding.fetch();
      assert.equal(jsonObject(response).status, mode === 'http-error' ? 409 : 200);
      const reader = callTestMethod(jsonObject(jsonObject(response).body), 'getReader');
      try {
        if (mode === 'read-failure') {
          await assert.rejects(
            Promise.resolve(callTestMethod(reader, 'read')),
            /original producer failure/,
          );
        } else {
          assert.deepEqual(
            jsonObject(await callTestMethod(reader, 'read')).value,
            new Uint8Array([0, 128, 255]),
          );

          if (mode === 'eof' || mode === 'http-error') {
            assert.equal(jsonObject(await callTestMethod(reader, 'read')).done, true);
          } else if (mode === 'cancel-failure') {
            await assert.rejects(
              Promise.resolve(callTestMethod(reader, 'cancel')),
              /cleanup must not replace/,
            );
          } else {
            await callTestMethod(reader, 'cancel');
          }
        }
      } finally {
        callTestMethod(reader, 'releaseLock');
      }
      return JSON.stringify({ observed: mode });
    };
    assert.deepEqual(
      await callTestMethod(await callTestBoundary(inspectClientStream, mode), 'json'),
      {
        observed: mode,
        locked: false,
        inputLocked: false,
        cancelled: callTestMethod(['eof', 'http-error', 'read-failure'], 'includes', mode) ? 0 : 1,
      },
    );
  }
});

void test('runtime fixtures preserve reactor failures and reject malformed encoded results', async () => {
  for (const invoke of [() => callTestBoundary(inspectClientStream, 'eof')]) {
    const failure = new Error('reactor unavailable');
    reactor.clientStreamLifecycle = async () => {
      throw failure;
    };
    await assert.rejects(Promise.resolve(invoke()), (error) => error === failure);
    reactor.clientStreamLifecycle = async () => 'not JSON';
    await assert.rejects(Promise.resolve(invoke()), SyntaxError);
  }
});
