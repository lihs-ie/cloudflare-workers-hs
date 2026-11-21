import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { outputReactor, schedulingReactor } from './Support/reactor-fixtures.mjs';
import {
  createReactor,
  bindExport,
  decodeResponse,
  decodeString,
  decodeVoid,
  decodeWorkflowResult,
  defineWorker,
  initializeObject,
  runObject,
  unwrapWorkflowResult,
} from '../src/index.ts';
// A real reactor with memory and an empty _initialize function.
const bytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 24, 2, 6, 109, 101,
  109, 111, 114, 121, 2, 0, 11, 95, 105, 110, 105, 116, 105, 97, 108, 105, 122, 101, 0, 0, 10, 4, 1,
  2, 0, 11,
]);
test('initializes real WASM with the shared JSFFI table and validates required exports', async () => {
  let table;
  const module = await WebAssembly.compile(bytes);
  const adapter = await createReactor(
    module,
    (exports) => {
      table = exports;
      return {};
    },
    (exports) => ({
      memory: exports.memory,
      initialize: bindExport(exports, '_initialize', decodeVoid),
    }),
  );
  assert.equal(adapter.memory, table.memory);
  assert.ok(adapter.memory instanceof WebAssembly.Memory);
  await adapter.initialize();
  await assert.rejects(
    createReactor(
      module,
      () => ({}),
      (exports) => bindExport(exports, 'fetch', decodeResponse),
    ),
    /function fetch/,
  );
});

test('ABI adapters validate resolved results and preserve arguments and failures', async () => {
  const response = new Response('ok');
  const request = new Request('https://example.com');
  const env = {};
  const context = {};
  const fetch = bindExport(
    {
      fetch: async (...args) => {
        assert.deepEqual(args, [request, env, context]);
        return response;
      },
    },
    'fetch',
    decodeResponse,
  );
  assert.equal(await fetch(request, env, context), response);
  for (const invalid of [null, {}, 'response', undefined]) {
    await assert.rejects(
      bindExport({ fetch: () => invalid }, 'fetch', decodeResponse)(),
      /Expected a Response/,
    );
  }
  assert.throws(() => bindExport({ fetch: 42 }, 'fetch', decodeResponse), /function fetch/);
  const failure = new Error('native');
  await assert.rejects(
    bindExport(
      {
        f: () => {
          throw failure;
        },
      },
      'f',
      decodeVoid,
    )(),
    (error) => error === failure,
  );
  assert.equal(decodeString('ok'), 'ok');
  assert.throws(() => decodeString(1), TypeError);
  assert.equal(decodeVoid(undefined), undefined);
  assert.throws(() => decodeVoid(null), TypeError);
});

test('Worker handlers retain identity and reject invalid registrations', () => {
  const fetch = () => 'response';
  assert.equal(fetch(), 'response');
  assert.equal(defineWorker({ fetch }).fetch, fetch);
  assert.deepEqual(defineWorker({}), {});
  assert.throws(() => defineWorker({ fetch: undefined }), /Invalid Worker/);
  assert.throws(() => defineWorker({ typo: fetch }), /Invalid Worker/);
});

test('Object helpers delegate initialization and optional event blocking', async () => {
  let blocks = 0;
  const initialized = {};
  let initialization = Promise.resolve(initialized);
  const context = {
    blockConcurrencyWhile: (fn) => {
      blocks++;
      initialization = fn();
      return initialization;
    },
  };
  initializeObject(context, async () => initialized);
  assert.equal(await initialization, initialized);
  assert.equal(blocks, 1);
  assert.equal(await runObject(context, async () => 'plain'), 'plain');
  assert.equal(blocks, 1);
  assert.equal(await runObject(context, async () => 'serialized', true), 'serialized');
  assert.equal(blocks, 2);
  const failure = new Error('native');
  await assert.rejects(
    runObject(
      context,
      async () => {
        throw failure;
      },
      true,
    ),
    (error) => error === failure,
  );
});

test('Workflow envelope decoder rejects malformed data and preserves failure identity', () => {
  class NonRetryableError extends Error {}
  for (const nativeError of [new Error('native'), null, 0, false, '', undefined]) {
    const outcome = decodeWorkflowResult({ ok: false, message: 'fallback', nativeError });
    assert.ok(Object.hasOwn(outcome, 'nativeError'));
    assert.throws(
      () => unwrapWorkflowResult(outcome, NonRetryableError),
      (error) => error === nativeError,
    );
  }
  for (const value of [
    null,
    [],
    {},
    { ok: 1 },
    { ok: true },
    { ok: false },
    { ok: false, message: 1 },
    { ok: false, message: 'bad', nonRetryable: 'yes' },
  ]) {
    assert.throws(() => decodeWorkflowResult(value), TypeError);
  }
  const value = {};
  assert.equal(unwrapWorkflowResult(decodeWorkflowResult({ ok: true, value }), Error), value);
  assert.throws(
    () =>
      unwrapWorkflowResult(
        decodeWorkflowResult({ ok: false, message: 'permanent', nonRetryable: true }),
        NonRetryableError,
      ),
    NonRetryableError,
  );
  assert.throws(
    () =>
      unwrapWorkflowResult(
        decodeWorkflowResult({ ok: false, message: 'retry' }),
        NonRetryableError,
      ),
    /retry/,
  );
  const inherited = Object.assign(Object.create({ nativeError: 'ignored' }), {
    ok: false,
    message: 'fallback',
  });
  assert.equal(Object.hasOwn(decodeWorkflowResult(inherited), 'nativeError'), false);
});

test('rejects incomplete WASI reactors before invoking the application binder', async () => {
  for (const [original, replacement, message] of [
    ['memory', 'memori', /export memory/],
    ['_initialize', '_initializf', /export function _initialize/],
  ]) {
    const malformed = Buffer.from(bytes);
    const offset = malformed.indexOf(original);
    assert.ok(offset > 0);
    malformed.write(replacement, offset);
    let bound = false;
    const bind = () => {
      bound = true;
    };
    await assert.rejects(
      createReactor(await WebAssembly.compile(malformed), () => ({}), bind),
      message,
    );
    assert.equal(bound, false);
    await createReactor(await WebAssembly.compile(bytes), () => ({}), bind);
    assert.equal(bound, true);
  }
});

test('reactor factories and binders preserve failures without poisoning later creation', async () => {
  const module = await WebAssembly.compile(bytes);
  const failure = new Error('factory failure');
  const bind = () => undefined;
  await createReactor(module, () => ({}), bind);
  await assert.rejects(
    createReactor(
      module,
      () => {
        throw failure;
      },
      bind,
    ),
    (error) => error === failure,
  );
  await assert.rejects(
    createReactor(
      module,
      () => ({}),
      () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  const memories = await Promise.all(
    [0, 1].map(() =>
      createReactor(
        module,
        () => ({}),
        (exports) => exports.memory,
      ),
    ),
  );
  assert.notEqual(memories[0], memories[1]);
});

test('all supported Worker events remain callable on a frozen independent registration', async () => {
  const registrations = Object.fromEntries(
    ['fetch', 'queue', 'scheduled', 'tail'].map((name) => [name, (...args) => ({ name, args })]),
  );
  const worker = defineWorker(registrations);
  assert.ok(Object.isFrozen(worker));
  for (const name of Object.keys(registrations)) {
    assert.deepEqual(worker[name](1, 'payload'), { name, args: [1, 'payload'] });
  }
  registrations.fetch = () => 'changed';
  assert.equal(registrations.fetch(), 'changed');
  assert.deepEqual(worker.fetch(), { name: 'fetch', args: [] });
  const failure = new Error('handler failure');
  await assert.rejects(
    defineWorker({
      fetch: async () => {
        throw failure;
      },
    }).fetch(),
    (error) => error === failure,
  );
});

test('workflow validation distinguishes inherited values, flags, and native failure priority', () => {
  class NonRetryableError extends Error {}
  assert.throws(() => decodeWorkflowResult(Object.create({ ok: true, value: 1 })), TypeError);
  for (const value of [true, false, 1, 'value', undefined]) {
    assert.throws(() => decodeWorkflowResult(value), TypeError);
  }
  const ordinary = decodeWorkflowResult({
    ok: false,
    message: 'retry',
    nonRetryable: false,
  });
  assert.equal(ordinary.nonRetryable, false);
  assert.throws(
    () => unwrapWorkflowResult(ordinary, NonRetryableError),
    (error) =>
      error instanceof Error && !(error instanceof NonRetryableError) && error.message === 'retry',
  );
  const native = new Error('original');
  assert.throws(
    () =>
      unwrapWorkflowResult(
        decodeWorkflowResult({
          ok: false,
          message: 'fallback',
          nonRetryable: true,
          nativeError: native,
        }),
        NonRetryableError,
      ),
    (error) => error === native,
  );
  assert.deepEqual(decodeWorkflowResult({ ok: true, value: undefined }), {
    ok: true,
    value: undefined,
  });
});

test('WASI initialization delivers stdout and stderr to configured destinations', async () => {
  const stdout = [];
  const stderr = [];
  await createReactor(
    await WebAssembly.compile(outputReactor()),
    () => ({}),
    () => undefined,
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  );
  assert.deepEqual(stdout, ['out']);
  assert.deepEqual(stderr, ['out']);
});

test('GHC scheduling uses deferred per-reactor callbacks without mutating generated imports', async () => {
  vi.useFakeTimers();
  const observations = [];
  const module = await WebAssembly.compile(schedulingReactor());
  const original = vi.fn();
  const factories = [];
  const reactors = [];
  for (const label of ['first', 'second']) {
    const imports = Object.freeze({
      scheduleWork: original,
      observe: () => observations.push(label),
    });
    factories.push(imports);
    reactors.push(
      await createReactor(
        module,
        () => imports,
        (exports) => ({
          initialize: bindExport(exports, '_initialize', decodeVoid),
        }),
      ),
    );
  }
  assert.deepEqual(observations, []);
  assert.equal(original.mock.calls.length, 0);
  vi.runAllTimers();
  assert.deepEqual(observations, ['first', 'second']);
  await reactors[0].initialize();
  assert.deepEqual(observations, ['first', 'second']);
  vi.runAllTimers();
  assert.deepEqual(observations, ['first', 'second', 'first']);
  assert.ok(factories.every((imports) => imports.scheduleWork === original));
});

test('invalid scheduler exports and premature scheduling fail before leaving queued work', async () => {
  vi.useFakeTimers();
  const original = vi.fn();
  const observe = vi.fn();
  const imports = () => ({ scheduleWork: original, observe });
  const bind = vi.fn();
  for (const module of [
    await WebAssembly.compile(bytes),
    await WebAssembly.compile(schedulingReactor({ loopKind: 'memory' })),
  ]) {
    await assert.rejects(createReactor(module, imports, bind), /export function rts_schedulerLoop/);
  }
  await assert.rejects(
    createReactor(await WebAssembly.compile(schedulingReactor({ start: true })), imports, bind),
    /scheduler is not initialized/,
  );
  vi.runAllTimers();
  assert.equal(original.mock.calls.length, 0);
  assert.equal(observe.mock.calls.length, 0);
  assert.equal(bind.mock.calls.length, 0);
});

test('scheduler callback failures retain exception identity', async () => {
  vi.useFakeTimers();
  const failure = new Error('scheduler failure');
  await createReactor(
    await WebAssembly.compile(schedulingReactor()),
    () => ({
      scheduleWork: vi.fn(),
      observe: () => {
        throw failure;
      },
    }),
    vi.fn(),
  );
  assert.throws(
    () => vi.runAllTimers(),
    (error) => error === failure,
  );
});

test('adapters without an own callable scheduleWork retain their original imports', async () => {
  const inherited = vi.fn();
  const imports = Object.create({ scheduleWork: inherited });
  imports.observe = vi.fn();
  await createReactor(
    await WebAssembly.compile(schedulingReactor({ loopKind: 'memory' })),
    () => imports,
    vi.fn(),
  );
  assert.equal(inherited.mock.calls.length, 1);
  assert.equal(Object.hasOwn(imports, 'scheduleWork'), false);
  await createReactor(await WebAssembly.compile(bytes), () => ({ scheduleWork: 42 }), vi.fn());
});

test('scheduler adaptation preserves inherited and non-enumerable foreign imports', async () => {
  vi.useFakeTimers();
  const module = await WebAssembly.compile(schedulingReactor());
  for (const inherited of [false, true]) {
    const observe = vi.fn();
    const original = vi.fn();
    const imports = { scheduleWork: original };

    if (inherited) {
      Object.setPrototypeOf(imports, { observe });
    } else {
      Object.defineProperty(imports, 'observe', { value: observe });
    }
    Object.freeze(imports);
    await createReactor(module, () => imports, vi.fn());
    vi.runAllTimers();
    assert.equal(observe.mock.calls.length, 1);
    assert.equal(original.mock.calls.length, 0);
  }
});
