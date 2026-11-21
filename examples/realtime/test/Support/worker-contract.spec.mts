import type * as Module from 'node:module';
import {
  callTestBoundary,
  callTestMethod,
  constructTestBoundary,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import { jsonArray, jsonObject } from '../../../../scripts/testing/Support/json.mts';
/** Actual Worker adapter contracts with only Cloudflare/FFI boundaries substituted. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
const calls: unknown[][] = [];
const reactor: Record<string, unknown> = {};
const slot = Symbol.for('cloudflare-workers-hs.realtime-contract');
Reflect.set(globalThis, slot, reactor);
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

    if (specifier === 'cloudflare:workers') {
      return {
        url: 'data:text/javascript,export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }',
        shortCircuit: true,
      };
    }

    if (
      specifier === './runtime' ||
      specifier === './runtime.js' ||
      specifier === '../../worker/runtime'
    ) {
      return {
        url: `data:text/javascript,export const reactor=globalThis[Symbol.for('cloudflare-workers-hs.realtime-contract')];`,
        shortCircuit: true,
      };
    }

    if (specifier === './room-probe') {
      return nextResolve('./room-probe.ts', context);
    }

    if (specifier === '../../worker/index') {
      return nextResolve('../../worker/index.ts', context);
    }

    return nextResolve(specifier, context);
  },
});
let production, fixture;
try {
  production = await loadTestModule(new URL('../../worker/index.ts', import.meta.url).href);
  fixture = await loadTestModule(new URL('./entry.ts', import.meta.url).href);
} finally {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, slot);
}

void test("ChatRoom registers native initialization and preserves each event's FFI arguments", async () => {
  const env = {};
  const storage = {};
  let initialization;
  const context = {
    storage,
    blockConcurrencyWhile(callback: () => unknown): unknown {
      initialization = callback();
      return initialization;
    },
  };
  reactor.initializeRoom = async (...args: unknown[]) => {
    jsonArray(calls).push(['initialize', ...args]);
  };
  for (const name of ['roomFetch', 'roomMessage', 'roomClose', 'fetch']) {
    reactor[name] = async (...args: unknown[]) => {
      jsonArray(calls).push([name, ...args]);
      return name === 'roomFetch' || name === 'fetch' ? new Response('ok') : undefined;
    };
  }
  const room = constructTestBoundary(production.ChatRoom, context, env);
  const socket = {};
  await initialization;
  assert.deepEqual(calls, [['initialize', storage, context]]);
  await callTestMethod(room, 'webSocketError', socket, new Error('private diagnostic'));
  assert.deepEqual(calls.pop(), ['roomClose', storage, socket, 1011, 'Socket failed', false, env]);
  const request = new Request('https://example.invalid/');
  assert.equal(
    await callTestMethod(jsonObject(await callTestMethod(room, 'fetch', request)), 'text'),
    'ok',
  );
  assert.deepEqual(calls.pop(), ['roomFetch', storage, context, request, env, context]);
  for (const message of ['hello', new ArrayBuffer(3)]) {
    await callTestMethod(room, 'webSocketMessage', socket, message);
    assert.deepEqual(calls.pop(), ['roomMessage', storage, context, socket, message, env]);
  }
  await callTestMethod(room, 'webSocketClose', socket, 1000, 'done', true);
  assert.deepEqual(calls.pop(), ['roomClose', storage, socket, 1000, 'done', true, env]);
  assert.equal(
    await callTestMethod(
      await callTestMethod(jsonObject(production.default), 'fetch', request, env, context),
      'text',
    ),
    'ok',
  );
  assert.deepEqual(calls.pop(), ['fetch', request, env, context]);
  const failure = new Error('close failed');
  reactor.roomClose = async () => {
    throw failure;
  };
  await assert.rejects(
    Promise.resolve(callTestMethod(room, 'webSocketError', socket, null)),
    (error) => error === failure,
  );
});

void test('fixture rejects invalid attachment changes without looking up a room', async () => {
  const changed: unknown[] = [];
  const attachments: unknown[] = [];
  const state = {
    storage: {},
    blockConcurrencyWhile(callback: () => unknown): unknown {
      return callback();
    },
    getWebSockets(tag: unknown): { serializeAttachment(value: unknown): void }[] {
      assert.equal(tag, 'chat');
      return [
        {
          serializeAttachment(value: unknown): void {
            jsonArray(attachments).push(value);
          },
        },
      ];
    },
  };
  reactor.initializeRoom = async () => {};
  const room = constructTestBoundary(fixture.ChatRoom, state, {});
  const env = {
    ROOMS: {
      getByName(name: unknown): Record<string, unknown> {
        jsonArray(changed).push(name);
        return room;
      },
    },
  };
  for (const query of ['', '?room=x', '?mode=missing', '?room=x&mode=other']) {
    const response = await callTestMethod(
      fixture.default,
      'fetch',
      new Request(`https://example.invalid/__attachment${query}`),
      env,
      {},
    );
    assert.equal(jsonObject(response).status, 400);
    assert.equal(await callTestMethod(jsonObject(response), 'text'), 'Invalid fixture input');
  }
  assert.deepEqual(changed, []);
  for (const mode of ['missing', 'wrong-type']) {
    assert.deepEqual(
      await callTestMethod(
        await callTestMethod(
          jsonObject(fixture.default),
          'fetch',
          new Request(`https://example.invalid/__attachment?room=x&mode=${mode}`),
          env,
          {},
        ),
        'json',
      ),
      { changed: true },
    );
  }
  assert.deepEqual(attachments, [null, 42]);
  assert.equal(
    await callTestMethod(
      await callTestMethod(
        jsonObject(fixture.default),
        'fetch',
        new Request('https://example.invalid/'),
        env,
        {},
      ),
      'text',
    ),
    'ok',
  );
});

void test('ChatRoom surfaces initialization failure through the concurrency barrier', async () => {
  const failure = new Error('SQL initialization rejected');
  let initialization;
  reactor.initializeRoom = async () => {
    throw failure;
  };
  constructTestBoundary(
    production.ChatRoom,
    {
      storage: {},
      blockConcurrencyWhile(callback: () => Promise<unknown>): void {
        initialization = callback();
      },
    },
    {},
  );
  await assert.rejects(Promise.resolve(initialization), (error: Error) => error === failure);
});

void test('fixture propagates room lookup failures without reporting success', async () => {
  const failure = new Error('namespace unavailable');
  const request = (path: string): Request<unknown, CfProperties<unknown>> =>
    new Request(`https://example.invalid${path}`);
  await assert.rejects(
    Promise.resolve(
      callTestMethod(
        fixture.default,
        'fetch',
        request('/__attachment?room=x&mode=missing'),
        {
          ROOMS: {
            getByName(): never {
              throw failure;
            },
          },
        },
        {},
      ),
    ),
    (error) => error === failure,
  );
});

void test('fixture route defaults and coverage requirements remain explicit', async () => {
  const response = await callTestMethod(
    fixture.default,
    'fetch',
    new Request('https://room/__room-probe'),
    {
      ROOMS: {
        getByName(name: string): { probe(scenario: string): Promise<{ observed: boolean }> } {
          assert.equal(name, 'probe');
          return {
            async probe(scenario: string): Promise<{ observed: boolean }> {
              assert.equal(scenario, '');
              return { observed: true };
            },
          };
        },
      },
    },
    {},
  );
  assert.deepEqual(await callTestMethod(jsonObject(response), 'json'), { observed: true });
  assert.equal(
    jsonObject(
      await callTestMethod(
        fixture.default,
        'fetch',
        new Request('https://room/__coverage/upload-failure'),
        {},
        {},
      ),
    ).status,
    409,
  );
});

void test('room probe reports missing clients and preserves proxy receivers', async () => {
  const { roomProbe } = await loadTestModule(new URL('./room-probe.ts', import.meta.url).href);
  const socket = {
    label: 'socket',
    native(): string {
      assert.equal(this, socket);
      return this.label;
    },
  };
  const sql = {
    label: 'sql',
    native(): string {
      assert.equal(this, sql);
      return this.label;
    },
    exec(query: unknown): { one: () => { total: number }; query: unknown } {
      assert.equal(this, sql);
      return { one: () => ({ total: 0 }), query };
    },
  };
  const storage = {
    sql,
    label: 'storage',
    native(): string {
      assert.equal(this, storage);
      return this.label;
    },
  };
  const context = {
    storage,
    label: 'context',
    native(): string {
      assert.equal(this, context);
      return this.label;
    },
    getWebSockets: () => [socket],
  };
  await assert.rejects(
    Promise.resolve(
      callTestBoundary(roomProbe, 'unknown', { ...context, getWebSockets: () => [] }, {}),
    ),
    /requires an active chat client/,
  );
  await assert.rejects(
    Promise.resolve(callTestBoundary(roomProbe, 'unknown', context, {})),
    /Unknown room probe/,
  );
  reactor.roomFetch = async (wrapped: {
    label: unknown;
    native: () => unknown;
    sql: {
      label: unknown;
      native: () => unknown;
      exec: (arg0: string) => {
        (): unknown;
        new (): unknown;
        query: unknown;
        raw: { (): unknown; new (): unknown };
      };
    };
  }) => {
    assert.equal(wrapped.label, 'storage');
    assert.equal(wrapped.native(), 'storage');
    assert.equal(wrapped.sql.label, 'sql');
    assert.equal(wrapped.sql.native(), 'sql');
    assert.equal(wrapped.sql.exec('SELECT 1').query, 'SELECT 1');
    assert.deepEqual(wrapped.sql.exec('SELECT COUNT(*)').raw(), [['not-a-number']]);
    return Response.json({ checked: true });
  };
  assert.deepEqual(await callTestBoundary(roomProbe, 'malformed-count', context, {}), {
    status: 200,
    body: { checked: true },
  });
  reactor.roomMessage = async (
    _storage: unknown,
    state: {
      label: unknown;
      native: unknown;
      getWebSockets: unknown;
      storage?: {
        sql: {
          label: string;
          native(): string;
          exec(query: unknown): { one: () => { total: number }; query: unknown };
        };
        label: string;
        native(): string;
      };
    },
    peer: { label: unknown; native: () => unknown; deserializeAttachment: () => unknown },
  ) => {
    if (state === context) {
      assert.equal(peer.label, 'socket');
      assert.equal(peer.native(), 'socket');
      assert.equal(peer.deserializeAttachment(), null);
    } else {
      assert.equal(state.label, 'context');
      assert.equal(callTestMethod(state, 'native'), 'context');
      assert.throws(
        () =>
          callTestMethod(jsonObject(jsonArray(callTestMethod(state, 'getWebSockets'))[0]), 'send'),
        /peer already closed/,
      );
    }
  };
  assert.deepEqual(await callTestBoundary(roomProbe, 'message-failure', context, {}), {
    rejected: false,
    failures: 0,
  });
  assert.deepEqual(await callTestBoundary(roomProbe, 'broadcast-failure', context, {}), {
    failures: 1,
    closed: 0,
  });
});
