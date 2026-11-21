import type * as Module from 'node:module';
import {
  callTestBoundary,
  callTestMethod,
  constructTestBoundary,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import { jsonArray, jsonObject } from '../../../../scripts/testing/Support/json.mts';
/** Tests the TS fixture router and injected control handles, not the WASM implementation. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
const boundary: { reactor: Record<string, unknown>; calls: unknown[][]; fetch?: unknown } = {
  reactor: {},
  calls: [],
};
const slot = Symbol.for('cloudflare-workers-hs.workflow-fixture-contract');
Reflect.set(globalThis, slot, boundary);
const hooks = registerHooks({
  resolve(
    specifier: string,
    context: Module.ResolveHookContext,
    nextResolve: (
      specifier: string,
      context?: Partial<Module.ResolveHookContext>,
    ) => Module.ResolveFnOutput,
  ): import('module').ResolveFnOutput {
    if (specifier === './coverage-upload') {
      return nextResolve('./coverage-upload.ts', context);
    }

    if (specifier === '../../worker/runtime') {
      return {
        url: "data:text/javascript,const b=globalThis[Symbol.for('cloudflare-workers-hs.workflow-fixture-contract')]; export async function createWorkflowReactor(){return b.reactor}",
        shortCircuit: true,
      };
    }

    if (specifier === './runtime') {
      return {
        url: "data:text/javascript,const b=globalThis[Symbol.for('cloudflare-workers-hs.workflow-fixture-contract')]; export async function createFixtureReactor(){return b.reactor}",
        shortCircuit: true,
      };
    }

    if (specifier === '../../worker/entry') {
      return {
        url: "data:text/javascript,const b=globalThis[Symbol.for('cloudflare-workers-hs.workflow-fixture-contract')]; export class ApprovalWorkflow {constructor(ctx,env){this.env=env} async run(event,step){b.calls.push([event,step]);return 'production'}}; export default {fetch:async(...args)=>b.fetch ? b.fetch(...args) : new Response('production')}",
        shortCircuit: true,
      };
    }

    if (specifier === 'cloudflare:workflows') {
      return {
        url: 'data:text/javascript,export class NonRetryableError extends Error{}',
        shortCircuit: true,
      };
    }

    if (specifier === './control-probe' || specifier === './application-probe') {
      return nextResolve(`${specifier}.ts`, context);
    }

    return nextResolve(specifier, context);
  },
});
let entry, control;
try {
  entry = await loadTestModule(new URL('./entry.ts', import.meta.url).href);
  control = await loadTestModule(new URL('./control-probe.ts', import.meta.url).href);
} finally {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, slot);
}

void test('fixture input guards reject incomplete objects without invoking bindings', async () => {
  const env = {};
  const send = (path: string, input?: unknown): unknown =>
    callTestMethod(
      entry.default,
      'fetch',
      new Request(`https://fixture.invalid/__fixture/${path}`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
      env,
      {},
    );
  for (const input of [
    null,
    3,
    {},
    { identifier: 3 },
    { identifier: 'x' },
    { identifier: 'x', type: 3 },
    { identifier: 'x', type: 'approved' },
  ]) {
    const response = await send('event', input);
    assert.equal(jsonObject(response).status, 400);
    assert.equal(await callTestMethod(jsonObject(response), 'text'), 'Invalid fixture event');
  }
  for (const input of [
    null,
    3,
    {},
    { identifier: 3 },
    { identifier: 'x' },
    { identifier: 'x', parameters: null },
    { identifier: 'x', parameters: [] },
    { identifier: 'x', parameters: 'bad' },
  ]) {
    const response = await send('create', input);
    assert.equal(jsonObject(response).status, 400);
    assert.equal(await callTestMethod(jsonObject(response), 'text'), 'Invalid fixture input');
  }
  assert.equal(
    jsonObject(
      await callTestMethod(
        entry.default,
        'fetch',
        new Request('https://fixture.invalid/__fixture/control'),
        env,
        {},
      ),
    ).status,
    400,
  );
});

void test('workflow selects fixture behaviors only and preserves native failure', async () => {
  const env = {},
    step = {};
  const instance = constructTestBoundary(entry.ApprovalWorkflow, {}, env);
  for (const payload of [null, 3, {}, { behavior: 3 }, { behavior: 'normal' }]) {
    const event = { payload };
    assert.equal(await callTestMethod(instance, 'run', event, step), 'production');
    assert.deepEqual(boundary.calls.pop(), [event, step]);
  }
  for (const behavior of [
    'timeout',
    'lazy-output',
    'lazy-step',
    'unsafe-integer',
    'event-timeout',
    'event-payload',
    'backoff-constant',
    'backoff-linear',
    'backoff-exponential',
  ]) {
    const event = { payload: { behavior } };
    boundary.reactor.workflowFixture = async (...args: { name: unknown }[]) => {
      assert.equal(args[0], event);
      assert.equal(args[1], step);
      assert.equal(args[2], env);
      assert.equal(args[3].name, 'NonRetryableError');
      return { ok: true, value: behavior };
    };
    assert.equal(await callTestMethod(instance, 'run', event, step), behavior);
  }
  const failure = new Error('original');
  boundary.reactor.workflowFixture = async () => ({
    ok: false,
    message: 'other',
    nativeError: failure,
  });
  await assert.rejects(
    Promise.resolve(callTestMethod(instance, 'run', { payload: { behavior: 'timeout' } }, step)),
    (error) => error === failure,
  );
});

void test('control handles expose configured operation failures and status retries', async () => {
  for (const scenario of ['unknown', 'constructor', 'toString', '__proto__']) {
    assert.equal(jsonObject(await callTestMethod(control, 'controlProbe', scenario)).status, 400);
  }
  for (const [scenario, operation, failures, status] of [
    ['malformed', 'pause', 0, 42],
    ['paused', 'pause', 1, 'paused'],
    ['delayed', 'pause', 3, 'paused'],
    ['resumed', 'resume', 1, 'running'],
    ['terminated', 'terminate', 1, 'terminated'],
    ['restart', 'restart', 1, 'queued'],
    ['success', 'pause', 0, 'running'],
    ['persistent', 'pause', 100, 'paused'],
    ['forbidden', 'pause', 1, 'paused'],
    ['statusForbidden', 'pause', 1, 'paused'],
  ] as const) {
    boundary.reactor.workflowControlFixture = async (
      binding: { get: () => unknown },
      selected: unknown,
    ) => {
      assert.equal(selected, operation);
      const handle = await binding.get();
      assert.equal(jsonObject(handle).id, 'control-test');

      if (scenario === 'forbidden') {
        await assert.rejects(
          Promise.resolve(callTestMethod(jsonObject(handle), selected)),
          /permission denied/,
        );
      } else {
        await callTestMethod(jsonObject(handle), selected);
      }
      for (let index = 0; index < failures; index++) {
        await assert.rejects(
          Promise.resolve(callTestMethod(jsonObject(handle), 'status')),
          scenario === 'statusForbidden' ? /permission denied/ : /internal error/,
        );
      }
      assert.deepEqual(await callTestMethod(jsonObject(handle), 'status'), { status });
      return JSON.stringify({ observed: scenario });
    };
    assert.deepEqual(
      await callTestMethod(await callTestMethod(control, 'controlProbe', scenario), 'json'),
      {
        result: { observed: scenario },
        calls: 1,
        reads: failures + 1,
      },
    );
  }
});

void test('hanging control status stays pending after its initial retry failure', async () => {
  boundary.reactor.workflowControlFixture = async (
    binding: { get: () => unknown },
    operation: string | number,
  ) => {
    const handle = await binding.get();
    await callTestMethod(jsonObject(handle), operation);
    await assert.rejects(
      Promise.resolve(callTestMethod(jsonObject(handle), 'status')),
      /internal error/,
    );
    const pending = callTestMethod(jsonObject(handle), 'status');
    const marker = Symbol('microtask checkpoint');
    assert.equal(await Promise.race([pending, Promise.resolve(marker)]), marker);
    return JSON.stringify({ pending: true });
  };
  assert.deepEqual(
    await callTestMethod(
      jsonObject(await callTestMethod(control, 'controlProbe', 'hanging')),
      'json',
    ),
    {
      result: { pending: true },
      calls: 1,
      reads: 2,
    },
  );
});

void test('control endpoint forwards the selected scenario and rejects malformed reactor output', async () => {
  boundary.reactor.workflowControlFixture = async (
    binding: { get: () => unknown },
    operation: unknown,
  ) => {
    assert.equal(operation, 'resume');
    assert.equal(jsonObject(await binding.get()).id, 'control-test');
    return 'malformed';
  };
  await assert.rejects(
    Promise.resolve(
      callTestMethod(
        entry.default,
        'fetch',
        new Request('https://fixture.invalid/__fixture/control?scenario=resumed'),
        {},
        {},
      ),
    ),
    SyntaxError,
  );
});

void test('application probe preserves uninjected binding methods and data', async () => {
  const { applicationProbe } = await loadTestModule(
    new URL('./application-probe.ts', import.meta.url).href,
  );
  const statement = {
    label: 'statement',
    first(): string {
      assert.equal(this, statement);
      return 'native';
    },
  };
  const database = {
    label: 'database',
    native(): string {
      assert.equal(this, database);
      return this.label;
    },
    prepare(): { label: string; first(): string } {
      assert.equal(this, database);
      return statement;
    },
  };
  const approvals = {
    label: 'approvals',
    native(): string {
      assert.equal(this, approvals);
      return this.label;
    },
  };
  const env = { APPROVALS: approvals, AUDIT: database };
  boundary.fetch = async (
    _request: unknown,
    configured: {
      APPROVALS: { label: unknown; native: () => unknown };
      AUDIT: { label: unknown; native: () => unknown; prepare: (arg0: string) => unknown };
    },
  ) => {
    assert.equal(configured.APPROVALS.label, 'approvals');
    assert.equal(configured.APPROVALS.native(), 'approvals');
    assert.equal(configured.AUDIT.label, 'database');
    assert.equal(configured.AUDIT.native(), 'database');
    const wrapped = configured.AUDIT.prepare('SELECT count(*)');
    assert.equal(jsonObject(wrapped).label, 'statement');
    assert.equal(callTestMethod(jsonObject(wrapped), 'first'), 'native');
    return new Response('forwarded');
  };
  try {
    for (const scenario of ['binding-error', 'empty-audit']) {
      assert.equal(
        jsonObject(
          await callTestMethod(
            await callTestBoundary(
              applicationProbe,
              new Request(`https://fixture/__fixture/application?scenario=${scenario}`),
              env,
              {},
            ),
            'json',
          ),
        ).body,
        'forwarded',
      );
    }
  } finally {
    delete boundary.fetch;
  }
  assert.equal(
    jsonObject(
      await callTestMethod(
        entry.default,
        'fetch',
        new Request('https://fixture/__coverage/upload-failure'),
        {},
        {},
      ),
    ).status,
    409,
  );
});
