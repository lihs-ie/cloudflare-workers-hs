/** Tests the TS fixture router and injected control handles, not the WASM implementation. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const boundary = { reactor: {}, calls: [] };
const slot = Symbol.for("cloudflare-workers-hs.workflow-fixture-contract");
globalThis[slot] = boundary;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./coverage-upload") {
      return nextResolve("./coverage-upload.ts", context);
    }
    if (specifier === "../../worker/runtime") {
      return {
        url: "data:text/javascript,const b=globalThis[Symbol.for('cloudflare-workers-hs.workflow-fixture-contract')]; export async function createWorkflowReactor(){return b.reactor}",
        shortCircuit: true,
      };
    }
    if (specifier === "./runtime") {
      return {
        url: "data:text/javascript,const b=globalThis[Symbol.for('cloudflare-workers-hs.workflow-fixture-contract')]; export async function createFixtureReactor(){return b.reactor}",
        shortCircuit: true,
      };
    }
    if (specifier === "../../worker/entry") {
      return {
        url: "data:text/javascript,const b=globalThis[Symbol.for('cloudflare-workers-hs.workflow-fixture-contract')]; export class ApprovalWorkflow {constructor(ctx,env){this.env=env} async run(event,step){b.calls.push([event,step]);return 'production'}}; export default {fetch:async(...args)=>b.fetch ? b.fetch(...args) : new Response('production')}",
        shortCircuit: true,
      };
    }
    if (specifier === "cloudflare:workflows") {
      return {
        url: "data:text/javascript,export class NonRetryableError extends Error{}",
        shortCircuit: true,
      };
    }
    if (
      specifier === "./control-probe" ||
      specifier === "./application-probe"
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
let entry, control;
try {
  entry = await import("./entry.ts");
  control = await import("./control-probe.ts");
} finally {
  hooks.deregister();
  delete globalThis[slot];
}

test("fixture input guards reject incomplete objects without invoking bindings", async () => {
  const env = {};
  const send = (path, input) =>
    entry.default.fetch(
      new Request(`https://fixture.invalid/__fixture/${path}`, {
        method: "POST",
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
    { identifier: "x" },
    { identifier: "x", type: 3 },
    { identifier: "x", type: "approved" },
  ]) {
    const response = await send("event", input);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid fixture event");
  }
  for (const input of [
    null,
    3,
    {},
    { identifier: 3 },
    { identifier: "x" },
    { identifier: "x", parameters: null },
    { identifier: "x", parameters: [] },
    { identifier: "x", parameters: "bad" },
  ]) {
    const response = await send("create", input);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid fixture input");
  }
  assert.equal(
    (
      await entry.default.fetch(
        new Request("https://fixture.invalid/__fixture/control"),
        env,
        {},
      )
    ).status,
    400,
  );
});

test("fixture passes event payload and create parameters without changing native keys", async () => {
  const calls = [];
  const env = {
    AUDIT: {},
    APPROVALS: {
      async get(identifier) {
        calls.push(["get", identifier]);
        return {
          async sendEvent(event) {
            calls.push(["event", event]);
          },
        };
      },
      async create(options) {
        calls.push(["create", options]);
        return { id: options.id };
      },
    },
  };
  for (const [path, body, expected] of [
    [
      "event",
      { identifier: "one", type: "approved", payload: null },
      { accepted: true },
    ],
    [
      "create",
      { identifier: "two", parameters: { amount: 12 } },
      { identifier: "two" },
    ],
  ]) {
    const response = await entry.default.fetch(
      new Request(`https://fixture.invalid/__fixture/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      env,
      {},
    );
    assert.deepEqual(await response.json(), expected);
  }
  assert.deepEqual(calls, [
    ["get", "one"],
    ["event", { type: "approved", payload: null }],
    ["create", { id: "two", params: { amount: 12 } }],
  ]);
  boundary.reactor.d1QueryFixture = async (binding) => {
    assert.equal(binding, env.AUDIT);
    return '{"ok":true}';
  };
  assert.deepEqual(
    await (
      await entry.default.fetch(
        new Request("https://fixture.invalid/__fixture/d1-query"),
        env,
        {},
      )
    ).json(),
    { ok: true },
  );
  assert.equal(
    await (
      await entry.default.fetch(
        new Request("https://fixture.invalid/"),
        env,
        {},
      )
    ).text(),
    "production",
  );
});

test("workflow selects fixture behaviors only and preserves native failure", async () => {
  const env = {},
    step = {};
  const instance = new entry.ApprovalWorkflow({}, env);
  for (const payload of [
    null,
    3,
    {},
    { behavior: 3 },
    { behavior: "normal" },
  ]) {
    const event = { payload };
    assert.equal(await instance.run(event, step), "production");
    assert.deepEqual(boundary.calls.pop(), [event, step]);
  }
  for (const behavior of [
    "timeout",
    "lazy-output",
    "lazy-step",
    "unsafe-integer",
    "event-timeout",
    "event-payload",
    "backoff-constant",
    "backoff-linear",
    "backoff-exponential",
  ]) {
    const event = { payload: { behavior } };
    boundary.reactor.workflowFixture = async (...args) => {
      assert.equal(args[0], event);
      assert.equal(args[1], step);
      assert.equal(args[2], env);
      assert.equal(args[3].name, "NonRetryableError");
      return { ok: true, value: behavior };
    };
    assert.equal(await instance.run(event, step), behavior);
  }
  const failure = new Error("original");
  boundary.reactor.workflowFixture = async () => ({
    ok: false,
    message: "other",
    nativeError: failure,
  });
  await assert.rejects(
    instance.run({ payload: { behavior: "timeout" } }, step),
    (error) => error === failure,
  );
});

test("control handles expose configured operation failures and status retries", async () => {
  for (const scenario of ["unknown", "constructor", "toString", "__proto__"]) {
    assert.equal((await control.controlProbe(scenario)).status, 400);
  }
  for (const [scenario, operation, failures, status] of [
    ["malformed", "pause", 0, 42],
    ["paused", "pause", 1, "paused"],
    ["delayed", "pause", 3, "paused"],
    ["resumed", "resume", 1, "running"],
    ["terminated", "terminate", 1, "terminated"],
    ["restart", "restart", 1, "queued"],
    ["success", "pause", 0, "running"],
    ["persistent", "pause", 100, "paused"],
    ["forbidden", "pause", 1, "paused"],
    ["statusForbidden", "pause", 1, "paused"],
  ]) {
    boundary.reactor.workflowControlFixture = async (binding, selected) => {
      assert.equal(selected, operation);
      const handle = await binding.get();
      assert.equal(handle.id, "control-test");
      if (scenario === "forbidden") {
        await assert.rejects(handle[selected](), /permission denied/);
      } else {
        await handle[selected]();
      }
      for (let index = 0; index < failures; index++) {
        await assert.rejects(
          handle.status(),
          scenario === "statusForbidden"
            ? /permission denied/
            : /internal error/,
        );
      }
      assert.deepEqual(await handle.status(), { status });
      return JSON.stringify({ observed: scenario });
    };
    assert.deepEqual(await (await control.controlProbe(scenario)).json(), {
      result: { observed: scenario },
      calls: 1,
      reads: failures + 1,
    });
  }
});

test("hanging control status stays pending after its initial retry failure", async () => {
  boundary.reactor.workflowControlFixture = async (binding, operation) => {
    const handle = await binding.get();
    await handle[operation]();
    await assert.rejects(handle.status(), /internal error/);
    const pending = handle.status();
    const marker = Symbol("microtask checkpoint");
    assert.equal(
      await Promise.race([pending, Promise.resolve(marker)]),
      marker,
    );
    return JSON.stringify({ pending: true });
  };
  assert.deepEqual(await (await control.controlProbe("hanging")).json(), {
    result: { pending: true },
    calls: 1,
    reads: 2,
  });
});

test("fixture preserves binding failures instead of returning accepted", async () => {
  const failure = new Error("workflow binding unavailable");
  for (const [path, input, binding] of [
    [
      "event",
      { identifier: "x", type: "approved", payload: {} },
      {
        get: async () => {
          throw failure;
        },
      },
    ],
    [
      "event",
      { identifier: "x", type: "approved", payload: {} },
      {
        get: async () => ({
          sendEvent: async () => {
            throw failure;
          },
        }),
      },
    ],
    [
      "create",
      { identifier: "x", parameters: {} },
      {
        create: async () => {
          throw failure;
        },
      },
    ],
  ]) {
    await assert.rejects(
      entry.default.fetch(
        new Request(`https://fixture.invalid/__fixture/${path}`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
        { APPROVALS: binding },
        {},
      ),
      (error) => error === failure,
    );
  }
  boundary.reactor.d1QueryFixture = async () => "malformed";
  await assert.rejects(
    entry.default.fetch(
      new Request("https://fixture.invalid/__fixture/d1-query"),
      {},
      {},
    ),
    SyntaxError,
  );
});

test("control endpoint forwards the selected scenario and rejects malformed reactor output", async () => {
  boundary.reactor.workflowControlFixture = async (binding, operation) => {
    assert.equal(operation, "resume");
    assert.equal((await binding.get()).id, "control-test");
    return "malformed";
  };
  await assert.rejects(
    entry.default.fetch(
      new Request("https://fixture.invalid/__fixture/control?scenario=resumed"),
      {},
      {},
    ),
    SyntaxError,
  );
});

test("application probe preserves uninjected binding methods and data", async () => {
  const { applicationProbe } = await import("./application-probe.ts");
  const statement = {
    label: "statement",
    first() {
      assert.equal(this, statement);
      return "native";
    },
  };
  const database = {
    label: "database",
    native() {
      assert.equal(this, database);
      return this.label;
    },
    prepare() {
      assert.equal(this, database);
      return statement;
    },
  };
  const approvals = {
    label: "approvals",
    native() {
      assert.equal(this, approvals);
      return this.label;
    },
  };
  const env = { APPROVALS: approvals, AUDIT: database };
  boundary.fetch = async (_request, configured) => {
    assert.equal(configured.APPROVALS.label, "approvals");
    assert.equal(configured.APPROVALS.native(), "approvals");
    assert.equal(configured.AUDIT.label, "database");
    assert.equal(configured.AUDIT.native(), "database");
    const wrapped = configured.AUDIT.prepare("SELECT count(*)");
    assert.equal(wrapped.label, "statement");
    assert.equal(wrapped.first(), "native");
    return new Response("forwarded");
  };
  try {
    for (const scenario of ["binding-error", "empty-audit"]) {
      assert.equal(
        (
          await (
            await applicationProbe(
              new Request(
                `https://fixture/__fixture/application?scenario=${scenario}`,
              ),
              env,
              {},
            )
          ).json()
        ).body,
        "forwarded",
      );
    }
  } finally {
    delete boundary.fetch;
  }
  assert.equal(
    (
      await entry.default.fetch(
        new Request("https://fixture/__coverage/upload-failure"),
        {},
        {},
      )
    ).status,
    409,
  );
});
