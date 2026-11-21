import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { outputReactor, schedulingReactor } from './Support/reactor-fixtures.ts';
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
  type ObjectContext,
} from '../src/index.ts';
// A real reactor with memory and an empty _initialize function.
const bytes = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 24, 2, 6, 109, 101,
  109, 111, 114, 121, 2, 0, 11, 95, 105, 110, 105, 116, 105, 97, 108, 105, 122, 101, 0, 0, 10, 4, 1,
  2, 0, 11,
]);
function responseHandler(): string {
  return 'response';
}

function noAdapter(): undefined {
  return undefined;
}

function recordEvent(name: string): (...args: unknown[]) => unknown {
  return (...args) => ({ name, args });
}

test('initializes real WASM with the shared JSFFI table and validates required exports', async () => {
  let table: Record<string, unknown> | undefined;
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
  assert.ok(table, 'import factory receives the shared export table');
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
      fetch: async (...args: [Request, object, object]): Promise<Response> => {
        assert.deepEqual(args, [request, env, context]);
        return response;
      },
    },
    'fetch',
    decodeResponse,
  );
  assert.equal(await fetch(request, env, context), response);
  await Promise.all(
    [null, {}, 'response', undefined].map((invalid) =>
      assert.rejects(
        bindExport({ fetch: () => invalid }, 'fetch', decodeResponse)(),
        /Expected a Response/,
      ),
    ),
  );
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
  assert.equal(defineWorker({ fetch: responseHandler }).fetch, responseHandler);
  assert.deepEqual(defineWorker({}), {});
  assert.throws(() => {
    // @ts-expect-error Invalid JavaScript event registrations must also fail at runtime.
    defineWorker({ fetch: undefined });
  }, /Invalid Worker/);
  assert.throws(() => {
    // @ts-expect-error Unknown JavaScript event names must also fail at runtime.
    defineWorker({ typo: responseHandler });
  }, /Invalid Worker/);
});

test('Object helpers delegate initialization and optional event blocking', async () => {
  let blocks = 0;
  const initialized = {};
  let initialization: Promise<unknown> | undefined;
  const context: ObjectContext = {
    blockConcurrencyWhile<T>(operation: () => Promise<T>): Promise<T> {
      blocks++;
      const pending = operation();
      initialization = pending;
      return pending;
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
  const inherited = { ok: false, message: 'fallback' };
  Object.setPrototypeOf(inherited, { nativeError: 'ignored' });
  assert.equal(Object.hasOwn(decodeWorkflowResult(inherited), 'nativeError'), false);
});

test('rejects incomplete WASI reactors before invoking the application binder', async () => {
  const missingExports: [original: string, replacement: string, message: RegExp][] = [
    ['memory', 'memori', /export memory/],
    ['_initialize', '_initializf', /export function _initialize/],
  ];

  await Promise.all(
    missingExports.map(async ([original, replacement, message]) => {
      const malformed = Buffer.from(bytes);
      const offset = malformed.indexOf(original);
      assert.ok(offset > 0);
      malformed.write(replacement, offset);
      let bound = false;
      const bind = (): void => {
        bound = true;
      };
      await assert.rejects(
        createReactor(await WebAssembly.compile(malformed), () => ({}), bind),
        message,
      );
      assert.equal(bound, false);
      await createReactor(await WebAssembly.compile(bytes), () => ({}), bind);
      assert.equal(bound, true);
    }),
  );
});

test('reactor factories and binders preserve failures without poisoning later creation', async () => {
  const module = await WebAssembly.compile(bytes);
  const failure = new Error('factory failure');
  await createReactor(module, () => ({}), noAdapter);
  await assert.rejects(
    createReactor(
      module,
      () => {
        throw failure;
      },
      noAdapter,
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
  const registrations = {
    fetch: recordEvent('fetch'),
    queue: recordEvent('queue'),
    scheduled: recordEvent('scheduled'),
    tail: recordEvent('tail'),
  };
  const events: (keyof typeof registrations)[] = ['fetch', 'queue', 'scheduled', 'tail'];
  const worker = defineWorker(registrations);

  assert.ok(Object.isFrozen(worker));
  for (const name of events) {
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
  const inheritedResult = {};
  Object.setPrototypeOf(inheritedResult, { ok: true, value: 1 });
  assert.throws(() => decodeWorkflowResult(inheritedResult), TypeError);
  for (const value of [true, false, 1, 'value', undefined]) {
    assert.throws(() => decodeWorkflowResult(value), TypeError);
  }
  const ordinary = decodeWorkflowResult({
    ok: false,
    message: 'retry',
    nonRetryable: false,
  });
  assert.equal(ordinary.ok, false);
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
  const stdout: string[] = [];
  const stderr: string[] = [];
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
  const observations: string[] = [];
  const module = await WebAssembly.compile(schedulingReactor());
  const original = vi.fn();
  async function createObservedReactor(label: string): Promise<{
    imports: { scheduleWork: typeof original; observe: () => number };
    initialize: () => Promise<void>;
  }> {
    const imports = Object.freeze({
      scheduleWork: original,
      observe: () => observations.push(label),
    });
    const initialize = await createReactor(
      module,
      () => imports,
      (exports) => bindExport(exports, '_initialize', decodeVoid),
    );
    return { imports, initialize };
  }

  const first = await createObservedReactor('first');
  const second = await createObservedReactor('second');
  assert.deepEqual(observations, []);
  assert.equal(original.mock.calls.length, 0);
  vi.runAllTimers();
  assert.deepEqual(observations, ['first', 'second']);
  await first.initialize();
  assert.deepEqual(observations, ['first', 'second']);
  vi.runAllTimers();
  assert.deepEqual(observations, ['first', 'second', 'first']);
  assert.equal(first.imports.scheduleWork, original);
  assert.equal(second.imports.scheduleWork, original);
});

test('invalid scheduler exports and premature scheduling fail before leaving queued work', async () => {
  vi.useFakeTimers();
  const original = vi.fn();
  const observe = vi.fn();
  const imports = (): WebAssembly.ModuleImports => ({ scheduleWork: original, observe });
  const bind = vi.fn();
  const missingLoop = await WebAssembly.compile(bytes);
  const memoryLoop = await WebAssembly.compile(schedulingReactor({ loopKind: 'memory' }));
  await assert.rejects(
    createReactor(missingLoop, imports, bind),
    /export function rts_schedulerLoop/,
  );
  await assert.rejects(
    createReactor(memoryLoop, imports, bind),
    /export function rts_schedulerLoop/,
  );
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
  const imports = { observe: vi.fn() };
  Object.setPrototypeOf(imports, { scheduleWork: inherited });
  await createReactor(
    await WebAssembly.compile(schedulingReactor({ loopKind: 'memory' })),
    () => imports,
    vi.fn(),
  );
  assert.equal(inherited.mock.calls.length, 1);
  assert.equal(Object.hasOwn(imports, 'scheduleWork'), false);
  await createReactor(await WebAssembly.compile(bytes), () => ({ scheduleWork: 42 }), vi.fn());
});

test.each(['inherited', 'non-enumerable'])(
  'scheduler adaptation preserves %s foreign imports',
  async (visibility) => {
    vi.useFakeTimers();
    const module = await WebAssembly.compile(schedulingReactor());
    const observe = vi.fn();
    const original = vi.fn();
    const imports = { scheduleWork: original };

    if (visibility === 'inherited') {
      Object.setPrototypeOf(imports, { observe });
    } else {
      Object.defineProperty(imports, 'observe', { value: observe });
    }

    Object.freeze(imports);
    await createReactor(module, () => imports, vi.fn());
    vi.runAllTimers();

    assert.equal(observe.mock.calls.length, 1);
    assert.equal(original.mock.calls.length, 0);
  },
);
