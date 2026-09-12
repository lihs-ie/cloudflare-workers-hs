import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Script, createContext } from "node:vm";
import { test } from "node:test";
const filename = fileURLToPath(new URL("./workerd_js_runtime.mjs", import.meta.url));
const source = await readFile(filename, "utf8");
function harness({ coverage = {}, ok = true } = {}) {
  const records = [];
  const context = createContext({
    endpoint: "http://collector.invalid", bundle: "bundle", crypto: { randomUUID: () => "isolate" },
    __workerdCoverage__: coverage,
    fetch: async (endpoint, init) => { records.push({ endpoint, ...JSON.parse(init.body) }); return { ok, status: 503 }; },
  });
  new Script(source + "\nglobalThis.api = {wrapHandler,wrapClass,flush};", { filename }).runInContext(context);
  return { ...context.api, records };
}

test("handler preserves its receiver, symbols and getters while observing success and failure", async () => {
  const { wrapHandler, records } = harness();
  const symbol = Symbol("metadata");
  const original = { marker: 42, [symbol]: "tag", get settings() { return 7; },
    fetch(value) { assert.equal(this, original); return value + this.marker; },
    async queue() { throw new Error("original failure"); },
  };
  const handler = wrapHandler(original);
  assert.equal(await handler.fetch(1), 43);
  await assert.rejects(handler.queue(), /original failure/);
  assert.equal(handler[symbol], "tag");
  assert.equal(handler.settings, 7);
  assert.deepEqual(records.map(record => record.sequence), [1, 2]);
  assert.equal(records[0].isolate, records[1].isolate);
  assert.equal(wrapHandler(undefined), undefined);
});

test("class wrapping preserves identity, receiver and inheritance without wrapping native bases twice", async () => {
  const { wrapClass, wrapHandler, records } = harness();
  class DurableObject { native() { return "native"; } }
  class Parent extends DurableObject { fetch() { return this.value; } }
  class Child extends Parent { value = 7; get settings() { return this.value; } async alarm() { return "alarm"; } }
  const native = DurableObject.prototype.native;
  assert.equal(wrapClass(Child), Child);
  assert.equal(wrapHandler(Child), Child);
  wrapClass(Child);
  const instance = new Child();
  assert.equal(await instance.fetch(), 7);
  assert.equal(await instance.alarm(), "alarm");
  assert.equal(instance.settings, 7);
  assert.equal(instance.native(), "native");
  assert.equal(DurableObject.prototype.native, native);
  assert.equal(records.length, 2);
  assert.equal(wrapClass(42), 42);
  const arrow = () => 1;
  assert.equal(wrapClass(arrow), arrow);
  assert.equal(arrow(), 1);
});

test("collector failure and missing instrumentation are surfaced", async () => {
  await assert.rejects(harness({ ok: false }).flush(), /Coverage collector failed: 503/);
  await assert.rejects(harness({ coverage: null }).flush(), /Missing workerd instrumentation/);
});
