/** Actual Worker adapter contracts with only Cloudflare/FFI boundaries substituted. */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
const calls = [];
const reactor = {};
const slot = Symbol.for("cloudflare-workers-hs.realtime-contract");
globalThis[slot] = reactor;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./coverage-upload") {
      return nextResolve("./coverage-upload.ts", context);
    }
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }",
        shortCircuit: true,
      };
    }
    if (specifier === "./runtime" || specifier === "../../worker/runtime") {
      return {
        url: `data:text/javascript,export const reactor=globalThis[Symbol.for('cloudflare-workers-hs.realtime-contract')];`,
        shortCircuit: true,
      };
    }
    if (specifier === "./room-probe") {
      return nextResolve("./room-probe.ts", context);
    }
    if (specifier === "../../worker/index") {
      return nextResolve("../../worker/index.ts", context);
    }
    return nextResolve(specifier, context);
  },
});
let production, fixture;
try {
  production = await import("../../worker/index.ts");
  fixture = await import("./entry.ts");
} finally {
  hooks.deregister();
  delete globalThis[slot];
}

test("ChatRoom registers native initialization and preserves each event's FFI arguments", async () => {
  const env = {};
  const storage = {};
  let initialization;
  const context = {
    storage,
    blockConcurrencyWhile(callback) {
      initialization = callback();
      return initialization;
    },
  };
  reactor.initializeRoom = async (...args) => {
    calls.push(["initialize", ...args]);
  };
  for (const name of ["roomFetch", "roomMessage", "roomClose", "fetch"]) {
    reactor[name] = async (...args) => {
      calls.push([name, ...args]);
      return name === "roomFetch" || name === "fetch"
        ? new Response("ok")
        : undefined;
    };
  }
  const room = new production.ChatRoom(context, env);
  const socket = {};
  await initialization;
  assert.deepEqual(calls, [["initialize", storage, context]]);
  await room.webSocketError(socket, new Error("private diagnostic"));
  assert.deepEqual(calls.pop(), [
    "roomClose",
    storage,
    socket,
    1011,
    "Socket failed",
    false,
    env,
  ]);
  const request = new Request("https://example.invalid/");
  assert.equal(await (await room.fetch(request)).text(), "ok");
  assert.deepEqual(calls.pop(), [
    "roomFetch",
    storage,
    context,
    request,
    env,
    context,
  ]);
  for (const message of ["hello", new ArrayBuffer(3)]) {
    await room.webSocketMessage(socket, message);
    assert.deepEqual(calls.pop(), [
      "roomMessage",
      storage,
      context,
      socket,
      message,
      env,
    ]);
  }
  await room.webSocketClose(socket, 1000, "done", true);
  assert.deepEqual(calls.pop(), [
    "roomClose",
    storage,
    socket,
    1000,
    "done",
    true,
    env,
  ]);
  assert.equal(
    await (await production.default.fetch(request, env, context)).text(),
    "ok",
  );
  assert.deepEqual(calls.pop(), ["fetch", request, env, context]);
  const failure = new Error("close failed");
  reactor.roomClose = async () => {
    throw failure;
  };
  await assert.rejects(
    room.webSocketError(socket, null),
    (error) => error === failure,
  );
});

test("fixture rejects invalid attachment changes without looking up a room", async () => {
  const changed = [];
  const attachments = [];
  const state = {
    storage: {},
    blockConcurrencyWhile(callback) {
      return callback();
    },
    getWebSockets(tag) {
      assert.equal(tag, "chat");
      return [
        {
          serializeAttachment(value) {
            attachments.push(value);
          },
        },
      ];
    },
  };
  reactor.initializeRoom = async () => {};
  reactor.sqlChecks = async (storage) => {
    assert.equal(storage, state.storage);
    return '{"sql":true}';
  };
  reactor.upgradeChecks = async () => '{"upgrade":true}';
  const room = new fixture.ChatRoom(state, {});
  const env = {
    ROOMS: {
      getByName(name) {
        changed.push(name);
        return room;
      },
    },
  };
  for (const query of ["", "?room=x", "?mode=missing", "?room=x&mode=other"]) {
    const response = await fixture.default.fetch(
      new Request(`https://example.invalid/__attachment${query}`),
      env,
      {},
    );
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Invalid fixture input");
  }
  assert.deepEqual(changed, []);
  for (const mode of ["missing", "wrong-type"]) {
    assert.deepEqual(
      await (
        await fixture.default.fetch(
          new Request(
            `https://example.invalid/__attachment?room=x&mode=${mode}`,
          ),
          env,
          {},
        )
      ).json(),
      { changed: true },
    );
  }
  assert.deepEqual(attachments, [null, 42]);
  assert.deepEqual(
    await (
      await fixture.default.fetch(
        new Request("https://example.invalid/__sql"),
        env,
        {},
      )
    ).json(),
    { sql: true },
  );
  assert.deepEqual(
    await (
      await fixture.default.fetch(
        new Request("https://example.invalid/__upgrade"),
        env,
        {},
      )
    ).json(),
    { upgrade: true },
  );
  assert.equal(
    await (
      await fixture.default.fetch(
        new Request("https://example.invalid/"),
        env,
        {},
      )
    ).text(),
    "ok",
  );
});

test("ChatRoom surfaces initialization failure through the concurrency barrier", async () => {
  const failure = new Error("SQL initialization rejected");
  let initialization;
  reactor.initializeRoom = async () => {
    throw failure;
  };
  new production.ChatRoom(
    {
      storage: {},
      blockConcurrencyWhile(callback) {
        initialization = callback();
      },
    },
    {},
  );
  await assert.rejects(initialization, (error) => error === failure);
});

test("fixture propagates lookup and malformed SQL failures without reporting success", async () => {
  const failure = new Error("namespace unavailable");
  const request = (path) => new Request(`https://example.invalid${path}`);
  await assert.rejects(
    fixture.default.fetch(
      request("/__attachment?room=x&mode=missing"),
      {
        ROOMS: {
          getByName() {
            throw failure;
          },
        },
      },
      {},
    ),
    (error) => error === failure,
  );
  await assert.rejects(
    fixture.default.fetch(
      request("/__sql"),
      {
        ROOMS: {
          getByName() {
            return { sqlChecks: async () => "invalid-json" };
          },
        },
      },
      {},
    ),
    SyntaxError,
  );
  reactor.upgradeChecks = async () => {
    throw failure;
  };
  await assert.rejects(
    fixture.default.fetch(request("/__upgrade"), {}, {}),
    (error) => error === failure,
  );
});

test("fixture route defaults and coverage requirements remain explicit", async () => {
  const response = await fixture.default.fetch(
    new Request("https://room/__room-probe"),
    {
      ROOMS: {
        getByName(name) {
          assert.equal(name, "probe");
          return {
            async probe(scenario) {
              assert.equal(scenario, "");
              return { observed: true };
            },
          };
        },
      },
    },
    {},
  );
  assert.deepEqual(await response.json(), { observed: true });
  assert.equal(
    (
      await fixture.default.fetch(
        new Request("https://room/__coverage/upload-failure"),
        {},
        {},
      )
    ).status,
    409,
  );
});

test("room probe reports missing clients and preserves proxy receivers", async () => {
  const { roomProbe } = await import("./room-probe.ts");
  const socket = {
    label: "socket",
    native() {
      assert.equal(this, socket);
      return this.label;
    },
  };
  const sql = {
    label: "sql",
    native() {
      assert.equal(this, sql);
      return this.label;
    },
    exec(query) {
      assert.equal(this, sql);
      return { one: () => ({ total: 0 }), query };
    },
  };
  const storage = {
    sql,
    label: "storage",
    native() {
      assert.equal(this, storage);
      return this.label;
    },
  };
  const context = {
    storage,
    label: "context",
    native() {
      assert.equal(this, context);
      return this.label;
    },
    getWebSockets: () => [socket],
  };
  await assert.rejects(
    roomProbe("unknown", { ...context, getWebSockets: () => [] }, {}),
    /requires an active chat client/,
  );
  await assert.rejects(roomProbe("unknown", context, {}), /Unknown room probe/);
  reactor.roomFetch = async (wrapped) => {
    assert.equal(wrapped.label, "storage");
    assert.equal(wrapped.native(), "storage");
    assert.equal(wrapped.sql.label, "sql");
    assert.equal(wrapped.sql.native(), "sql");
    assert.equal(wrapped.sql.exec("SELECT 1").query, "SELECT 1");
    assert.deepEqual(wrapped.sql.exec("SELECT COUNT(*)").raw(), [
      ["not-a-number"],
    ]);
    return Response.json({ checked: true });
  };
  assert.deepEqual(await roomProbe("malformed-count", context, {}), {
    status: 200,
    body: { checked: true },
  });
  reactor.roomMessage = async (_storage, state, peer) => {
    if (state === context) {
      assert.equal(peer.label, "socket");
      assert.equal(peer.native(), "socket");
      assert.equal(peer.deserializeAttachment(), null);
    } else {
      assert.equal(state.label, "context");
      assert.equal(state.native(), "context");
      assert.throws(
        () => state.getWebSockets()[0].send(),
        /peer already closed/,
      );
    }
  };
  assert.deepEqual(await roomProbe("message-failure", context, {}), {
    rejected: false,
    failures: 0,
  });
  assert.deepEqual(await roomProbe("broadcast-failure", context, {}), {
    failures: 1,
    closed: 0,
  });
});
