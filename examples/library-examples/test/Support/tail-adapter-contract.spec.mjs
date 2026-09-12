/** Tail envelope observation only; no native Tail delivery is simulated. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";
const calls = [];
let failure;
const slot = Symbol.for("cloudflare-workers-hs.tail-contract");
globalThis[slot] = async (...args) => {
  calls.push(args);
  if (failure) {
    throw failure;
  }
};
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../../worker/entry") {
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
  adapter = (await import("./tail-entry.ts")).default;
} finally {
  hooks.deregister();
  delete globalThis[slot];
}

test("tail records optional envelope fields and forwards original objects unchanged", async (t) => {
  const log = mock.method(console, "log", () => {});
  t.after(() => log.mock.restore());
  const events = [
    {
      outcome: "ok",
      eventTimestamp: 12,
      scriptName: "worker",
      event: { request: { url: "https://worker.invalid/path" } },
    },
    {
      outcome: "exception",
      eventTimestamp: 13,
      scriptName: null,
      event: { scheduledTime: 13 },
    },
    { outcome: "canceled", eventTimestamp: 14 },
  ];
  const original = structuredClone(events);
  const env = {},
    context = {};
  await adapter.tail(events, env, context);
  const [message] = log.mock.calls[0].arguments;
  assert.ok(message.startsWith("native-tail-envelope "));
  assert.deepEqual(JSON.parse(message.slice("native-tail-envelope ".length)), [
    {
      outcome: "ok",
      timestamp: 12,
      scriptName: "worker",
      requestURL: "https://worker.invalid/path",
    },
    { outcome: "exception", timestamp: 13, scriptName: null, requestURL: null },
    { outcome: "canceled", timestamp: 14, scriptName: null, requestURL: null },
  ]);
  assert.deepEqual(events, original);
  const forwarded = calls.pop();
  assert.equal(forwarded[0], events);
  assert.equal(forwarded[1], env);
  assert.equal(forwarded[2], context);
  failure = new Error("native tail failed");
  await assert.rejects(
    adapter.tail([], env, context),
    (error) => error === failure,
  );
  assert.equal(log.mock.calls[1].arguments[0], "native-tail-envelope []");
});
