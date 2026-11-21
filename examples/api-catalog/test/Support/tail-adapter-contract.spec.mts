import type * as Module from 'node:module';
import {
  callTestMethod,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import { jsonString, jsonValue } from '../../../../scripts/testing/Support/json.mts';
/** Tail envelope observation only; no native Tail delivery is simulated. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mock, test } from 'node:test';
const calls: unknown[][] = [];
let failure: unknown;
const slot = Symbol.for('cloudflare-workers-hs.tail-contract');
Reflect.set(globalThis, slot, async (...args: unknown[]) => {
  calls.push(args);

  if (failure) {
    throw failure;
  }
});
const hooks = registerHooks({
  resolve(
    specifier: string,
    context: Module.ResolveHookContext,
    nextResolve: (
      specifier: string,
      context?: Partial<Module.ResolveHookContext>,
    ) => Module.ResolveFnOutput,
  ): import('module').ResolveFnOutput {
    if (specifier === '../../worker/entry') {
      return {
        url: "data:text/javascript,export default {tail:globalThis[Symbol.for('cloudflare-workers-hs.tail-contract')]};",
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});
let adapter;
try {
  adapter = (await loadTestModule(new URL('./tail-entry.ts', import.meta.url).href)).default;
} finally {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, slot);
}

void test('tail records optional envelope fields and forwards original objects unchanged', async (t) => {
  const log = mock.method(console, 'log', () => {});
  t.after(() => log.mock.restore());
  const events = [
    {
      outcome: 'ok',
      eventTimestamp: 12,
      scriptName: 'worker',
      event: { request: { url: 'https://worker.invalid/path' } },
    },
    {
      outcome: 'exception',
      eventTimestamp: 13,
      scriptName: null,
      event: { scheduledTime: 13 },
    },
    { outcome: 'canceled', eventTimestamp: 14 },
  ];
  const original = structuredClone(events);
  const env = {},
    context = {};
  await callTestMethod(adapter, 'tail', events, env, context);
  const message = jsonString(log.mock.calls[0].arguments[0]);
  assert.ok(message.startsWith('native-tail-envelope '));
  assert.deepEqual(jsonValue(message.slice('native-tail-envelope '.length)), [
    {
      outcome: 'ok',
      timestamp: 12,
      scriptName: 'worker',
      requestURL: 'https://worker.invalid/path',
    },
    { outcome: 'exception', timestamp: 13, scriptName: null, requestURL: null },
    { outcome: 'canceled', timestamp: 14, scriptName: null, requestURL: null },
  ]);
  assert.deepEqual(events, original);
  const forwarded = calls.pop();
  assert.ok(forwarded);
  assert.equal(forwarded[0], events);
  assert.equal(forwarded[1], env);
  assert.equal(forwarded[2], context);
  failure = new Error('native tail failed');
  await assert.rejects(
    Promise.resolve(callTestMethod(adapter, 'tail', [], env, context)),
    (error) => error === failure,
  );
  assert.equal(log.mock.calls[1].arguments[0], 'native-tail-envelope []');
});
