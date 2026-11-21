import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { createCoverageObserver } from '../Support/workerd_js_runtime.mts';
import { jsonValue } from '../Support/coverage-schema.mts';

function harness(options: { coverage?: unknown; ok?: boolean } = {}): {
  records: { sequence: number; isolate: string }[];
  observer: ReturnType<typeof createCoverageObserver>;
} {
  const records: { sequence: number; isolate: string }[] = [];
  const observer = createCoverageObserver({
    endpoint: 'http://collector.invalid',
    bundle: 'fixture',
    identify: () => 'isolate',
    readCoverage: () => ('coverage' in options ? options.coverage : {}),
    async send(_request: URL | RequestInfo, init: RequestInit | undefined): Promise<Response> {
      assert.equal(typeof init?.body, 'string');
      records.push(
        z
          .object({ sequence: z.number(), isolate: z.string() })
          .parse(jsonValue(String(init?.body))),
      );
      return new Response('', { status: options.ok === false ? 503 : 200 });
    },
  });
  return { records, observer };
}

async function invoke(target: unknown, name: PropertyKey, ...args: unknown[]): Promise<unknown> {
  assert.ok(typeof target === 'object' && target !== null);
  const method: unknown = Reflect.get(target, name);
  assert.equal(typeof method, 'function');

  if (typeof method !== 'function') {
    throw new TypeError('Expected an observed method');
  }

  return Reflect.apply(method, target, args);
}

void test('handler retains its receiver, getters and metadata while observing success and failure', async () => {
  const { observer, records } = harness();
  const metadata = Symbol('metadata');
  const original = {
    marker: 42,
    [metadata]: 'tag',
    get settings(): number {
      return 7;
    },
    fetch(value: number): number {
      assert.equal(this, original);
      return value + this.marker;
    },
    async queue(): Promise<never> {
      throw new Error('original failure');
    },
  };
  const wrapped = observer.wrapHandler(original);

  assert.equal(await invoke(wrapped, 'fetch', 1), 43);
  await assert.rejects(invoke(wrapped, 'queue'), /original failure/);
  assert.ok(typeof wrapped === 'object' && wrapped !== null);
  assert.equal(Reflect.get(wrapped, metadata), 'tag');
  assert.equal(Reflect.get(wrapped, 'settings'), 7);
  assert.deepEqual(
    records.map((record) => record.sequence),
    [1, 2],
  );
  assert.equal(records[0].isolate, records[1].isolate);
});

void test('class wrapping preserves class identity and leaves platform base methods untouched', async () => {
  const { observer, records } = harness();
  class DurableObject {
    native(): string {
      return 'native';
    }
  }
  class Parent extends DurableObject {
    async fetch(): Promise<number> {
      return 7;
    }
  }
  class Child extends Parent {
    async alarm(): Promise<string> {
      return 'alarm';
    }
  }
  const native = DurableObject.prototype.native;

  assert.equal(observer.wrapClass(Child), Child);
  observer.wrapClass(Child);
  const child = new Child();
  assert.equal(await child.fetch(), 7);
  assert.equal(await child.alarm(), 'alarm');
  assert.equal(DurableObject.prototype.native, native);
  assert.equal(records.length, 2);
  assert.equal(observer.wrapHandler(undefined), undefined);
  assert.equal(observer.wrapClass(42), 42);
});

void test('collector failures and missing instrumentation are surfaced', async () => {
  await assert.rejects(harness({ ok: false }).observer.flush(), /503/);
  await assert.rejects(harness({ coverage: null }).observer.flush(), /Missing/);
});

void test('Workflow cancellation starts no finalizer I/O and a later handler can flush its counters', async () => {
  const { observer, records } = harness();
  class WorkflowEntrypoint {}
  class Approval extends WorkflowEntrypoint {
    async run(): Promise<never> {
      throw new Error('workflow cancelled');
    }
  }
  const original = Approval.prototype.run;
  observer.wrapClass(Approval);
  assert.equal(Approval.prototype.run, original);
  await assert.rejects(new Approval().run(), /workflow cancelled/);
  assert.equal(records.length, 0);

  const handler = observer.wrapHandler({ fetch: async () => 'health' });
  assert.equal(await invoke(handler, 'fetch'), 'health');
  assert.equal(records.length, 1);
});

void test('frozen handlers retain immutable descriptors and their receiver while being observed', async () => {
  const { observer, records } = harness();
  const symbol = Symbol('method');
  const original = Object.freeze({
    marker: 42,
    fetch(): number {
      assert.equal(this, original);
      return this.marker;
    },
    [symbol](): string {
      return 'symbol';
    },
  });
  const wrapped = observer.wrapHandler(original);
  assert.equal(Object.isFrozen(wrapped), true);
  assert.equal(await invoke(wrapped, 'fetch'), 42);
  assert.equal(await invoke(wrapped, symbol), 'symbol');
  assert.equal(records.length, 2);
  assert.equal(Object.getOwnPropertyDescriptor(wrapped, 'fetch')?.configurable, false);
  assert.equal(Object.getOwnPropertyDescriptor(wrapped, 'fetch')?.writable, false);
});
