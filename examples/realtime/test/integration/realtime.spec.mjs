import { request as httpRequest } from "node:http";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { startDev } from "../Support/dev.mjs";
let runtime;
const openSockets = [];
before(
  async () => {
    runtime = await startDev();
  },
  { timeout: 65000 },
);
after(async () => {
  for (const socket of openSockets) {
    socket.close();
  }
  await runtime?.close();
});
async function json(path) {
  const response = await fetch(runtime.base + path, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function socket(room, path = `/rooms/${room}/connect`) {
  const ws = new WebSocket(runtime.base.replace("http:", "ws:") + path);
  ws.binaryType = "arraybuffer";
  const queue = [],
    pending = [];
  ws.addEventListener("message", (event) => {
    const receiver = pending.shift();
    if (receiver) {
      receiver(event.data);
    } else {
      queue.push(event.data);
    }
  });
  openSockets.push(ws);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  async function next() {
    if (queue.length) {
      return queue.shift();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("WebSocket message timeout")),
        5000,
      );
      pending.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }
  const greeting = await next();
  assert.match(greeting, /^connected:/);
  return { ws, next, identifier: greeting.slice("connected:".length) };
}
test("SQL typed values, parameter safety, rollback, row and byte limits", async () => {
  const result = await json("/__sql");
  assert.deepEqual(result.typed, [
    [
      { tag: "null" },
      { tag: "number", value: 1.25 },
      { tag: "text", value: "'; DROP TABLE checks; --" },
      { tag: "blob", value: [0, 128, 255] },
    ],
  ]);
  assert.equal(result.rollback, true);
  assert.deepEqual(result.count, [[{ tag: "number", value: 0 }]]);
  assert.deepEqual(result.afterLimit, [[{ tag: "number", value: 0 }]]);
  assert.equal(result.rowLimit, true);
  assert.equal(result.byteLimit, true);
  assert.equal(result.inputChecks.length, 7);
  for (const check of result.inputChecks) {
    assert.equal(check.rejected, true, check.name);
  }
  assert.deepEqual(result.recovery, [[{ tag: "number", value: 0 }]]);
});
test("NamedRoutes HTTP root rejects a missing Upgrade header", async () => {
  const response = await fetch(runtime.base + "/rooms/general/connect");
  assert.equal(response.status, 426);
});
test("two hibernating sockets broadcast text and binary, retain attachments and SQL history", async () => {
  const a = await socket("general"),
    b = await socket("general");
  a.ws.send("こんにちは");
  assert.equal(await a.next(), "こんにちは");
  assert.equal(await b.next(), "こんにちは");
  b.ws.send(new Uint8Array([0, 128, 255]));
  assert.deepEqual(Array.from(new Uint8Array(await a.next())), [0, 128, 255]);
  assert.deepEqual(Array.from(new Uint8Array(await b.next())), [0, 128, 255]);
  const connections = await json("/rooms/general/connections");
  assert.equal(connections.count, 2);
  assert.deepEqual(
    new Set(connections.attachments),
    new Set([a.identifier, b.identifier]),
  );
  const history = await json("/rooms/general/history");
  assert.equal(history.rows.length, 2);
  assert.deepEqual(history.rows[0][2], { tag: "blob", value: [0, 128, 255] });
  a.ws.send("ping");
  assert.equal(await a.next(), "pong");
  assert.equal(
    (await json("/rooms/general/history")).rows.length,
    2,
    "auto-response must not invoke message handler",
  );
  a.ws.close(1000, "bye");
  const deadline = Date.now() + 5000;
  while (
    (await json("/rooms/general/connections")).count !== 1 &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 25));
  assert.equal((await json("/rooms/general/connections")).count, 1);
  b.ws.close();
});
test("room state is isolated and oversized messages close with policy code", async () => {
  assert.equal((await json("/rooms/other/history")).rows.length, 0);
  const client = await socket("other");
  const closed = new Promise((resolve) =>
    client.ws.addEventListener("close", resolve, { once: true }),
  );
  client.ws.send("x".repeat(4097));
  assert.equal((await closed).code, 1009);
  assert.equal((await json("/rooms/other/history")).rows.length, 0);
});

test(
  "native hibernation rebuilds the constructor while retaining the live WebSocket attachment",
  { timeout: 25000 },
  async () => {
    const client = await socket("hibernate");
    client.ws.send("before sleep");
    assert.equal(await client.next(), "before sleep");
    const before = await json("/rooms/hibernate/connections");
    // The platform documents hibernation after 10 seconds with no active work.
    // Waiting happens in the external client, never in the Durable Object.
    await new Promise((resolve) => setTimeout(resolve, 12000));
    client.ws.send("after sleep");
    assert.equal(await client.next(), "after sleep");
    const after = await json("/rooms/hibernate/connections");
    assert.ok(
      after.constructors > before.constructors,
      `native hibernation was not observed (${before.constructors} -> ${after.constructors})`,
    );
    assert.deepEqual(after.attachments, [client.identifier]);
    assert.equal((await json("/rooms/hibernate/history")).rows.length, 2);
    client.ws.close();
  },
);

test("WebSocket response preserves outer headers and rejects changing 101 to HTTP denial", async () => {
  assert.deepEqual(await json("/__upgrade"), {
    header: "retained",
    statusMutationRejected: true,
    invalidIdentifierRejected: true,
    throwingIdentifierRejected: true,
  });
});

async function handshake(method, upgrade) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(runtime.base + "/rooms/handshake/connect", {
      method,
      agent: false,
      headers: {
        Connection: "Upgrade",
        Upgrade: upgrade,
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, headers: response.headers });
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode, headers: response.headers });
    });
    request.on("error", reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error("handshake timeout")),
    );
    request.end();
  });
}
test("WebSocket Upgrade token is case-insensitive and HTTP method is enforced", async () => {
  const accepted = await handshake("GET", "WebSocket");
  assert.equal(accepted.status, 101);
  assert.equal(accepted.headers["x-realtime"], "haskell");
  // workerd rejects a malformed POST Upgrade at its ingress, before Worker
  // dispatch (the pinned runtime returns 500). Assert denial, not app status.
  const invalidUpgrade = await handshake("POST", "websocket");
  assert.ok(invalidUpgrade.status >= 400);
  const rejected = await fetch(runtime.base + "/rooms/handshake/connect", {
    method: "POST",
  });
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET");
  await rejected.arrayBuffer();
});

async function update(path, body, method = "PUT") {
  const response = await fetch(runtime.base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
test("unique room identifiers round-trip into the same isolated Durable Object", async () => {
  const first = await update("/rooms", undefined, "POST");
  const second = await update("/rooms", undefined, "POST");
  assert.match(first.identifier, /^[0-9a-f]{64}$/i);
  assert.notEqual(first.identifier, second.identifier);
  const client = await socket(
    "unused",
    `/room-identifiers/${first.identifier}/connect`,
  );
  client.ws.send("retained by identifier");
  assert.equal(await client.next(), "retained by identifier");
  assert.equal(
    (await json(`/room-identifiers/${first.identifier}/history`)).rows.length,
    1,
  );
  assert.equal(
    (await json(`/room-identifiers/${second.identifier}/history`)).rows.length,
    0,
  );
  const invalid = await fetch(
    runtime.base + "/room-identifiers/not-an-identifier/history",
  );
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();
  client.ws.close();
});
test("all connections includes monitor tags while chat broadcast remains isolated", async () => {
  const chat = await socket("tags");
  const monitor = await socket("tags", "/rooms/tags/monitor");
  assert.equal((await json("/rooms/tags/connections")).count, 1);
  const all = await json("/rooms/tags/all-connections");
  assert.equal(all.count, 2);
  assert.deepEqual(
    new Set(all.attachments),
    new Set([chat.identifier, monitor.identifier]),
  );
  const seen = [];
  monitor.ws.addEventListener("message", (event) => seen.push(event.data));
  chat.ws.send("chat only");
  assert.equal(await chat.next(), "chat only");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(seen, []);
  const closed = new Promise((resolve) =>
    monitor.ws.addEventListener("close", resolve, { once: true }),
  );
  monitor.ws.send("cannot publish");
  assert.equal((await closed).code, 1008);
  chat.ws.close();
});
test("auto-response can be removed and restored without replacing the socket", async () => {
  const client = await socket("auto-toggle");
  client.ws.send("ping");
  assert.equal(await client.next(), "pong");
  assert.equal((await json("/rooms/auto-toggle/history")).rows.length, 0);
  assert.deepEqual(await update("/rooms/auto-toggle/auto-response", false), {
    enabled: false,
  });
  client.ws.send("ping");
  assert.equal(await client.next(), "ping");
  assert.equal((await json("/rooms/auto-toggle/history")).rows.length, 1);
  await update("/rooms/auto-toggle/auto-response", true);
  client.ws.send("ping");
  assert.equal(await client.next(), "pong");
  assert.equal((await json("/rooms/auto-toggle/history")).rows.length, 1);
  client.ws.close();
});
for (const mode of ["missing", "wrong-type"]) {
  test(`invalid ${mode} attachment closes only the affected connection`, async () => {
    const client = await socket(`attachment-${mode}`);
    await json(`/__attachment?room=attachment-${mode}&mode=${mode}`);
    const closed = new Promise((resolve) =>
      client.ws.addEventListener("close", resolve, { once: true }),
    );
    client.ws.send("must not persist");
    assert.equal((await closed).code, 1008);
    assert.equal(
      (await json(`/rooms/attachment-${mode}/history`)).rows.length,
      0,
    );
    const healthy = await socket(`attachment-${mode}`);
    healthy.ws.send("recovered");
    assert.equal(await healthy.next(), "recovered");
    healthy.ws.close();
  });
}

test("disabled auto-response survives native hibernation reconstruction", { timeout: 25000 }, async () => {
  const client = await socket("disabled-hibernation");
  await update("/rooms/disabled-hibernation/auto-response", false);
  const before = await json("/rooms/disabled-hibernation/connections");
  await new Promise((resolve) => setTimeout(resolve, 12000));
  client.ws.send("ping");
  assert.equal(await client.next(), "ping");
  const after = await json("/rooms/disabled-hibernation/connections");
  assert.ok(after.constructors > before.constructors);
  assert.equal((await json("/rooms/disabled-hibernation/history")).rows.length, 1);
  await update("/rooms/disabled-hibernation/auto-response", true);
  client.ws.send("ping");
  assert.equal(await client.next(), "pong");
  client.ws.close();
});

test("malformed constructor count falls back to zero without corrupting SQL", async () => {
  const result = await json("/__room-probe?scenario=malformed-count&room=count-probe");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { count: 0, attachments: [], constructors: 0 });
  assert.ok((await json("/rooms/count-probe/connections")).constructors >= 1);
});

test("a failed broadcast peer does not prevent delivery to healthy peers", async () => {
  const a = await socket("failed-peer");
  const b = await socket("failed-peer");
  const result = await json("/__room-probe?scenario=broadcast-failure&room=failed-peer");
  assert.equal(result.failures, 1);
  assert.equal(await a.next(), "survives failed peer");
  assert.equal(await b.next(), "survives failed peer");
  assert.equal((await json("/rooms/failed-peer/history")).rows.length, 1);
  a.ws.send("recovered");
  assert.equal(await a.next(), "recovered");
  assert.equal(await b.next(), "recovered");
  a.ws.close();
  b.ws.close();
});

test("close callback records the event even when native close throws", async () => {
  const client = await socket("failed-close");
  const result = await json("/__room-probe?scenario=close-failure&room=failed-close");
  assert.equal(result.failures, 1);
  assert.equal(result.closed, 1);
  client.ws.send("still usable");
  assert.equal(await client.next(), "still usable");
  client.ws.close();
});

test("non-size WebSocket errors propagate from the entrypoint without storing a message", async () => {
  const client = await socket("message-failure");
  const result = await json("/__room-probe?scenario=message-failure&room=message-failure");
  assert.equal(result.rejected, true);
  assert.equal(result.failures, 1);
  assert.match(result.message, /fixture peer already closed/);
  assert.equal((await json("/rooms/message-failure/history")).rows.length, 0);
  client.ws.send("recovery after callback error");
  assert.equal(await client.next(), "recovery after callback error");
  client.ws.close();
});

test("room callback enforces its own limit independently of ingress decoding", async () => {
  const client = await socket("direct-oversize");
  const closed = new Promise((resolve) =>
    client.ws.addEventListener("close", resolve, { once: true }),
  );
  assert.deepEqual(await json("/__room-probe?scenario=direct-oversize&room=direct-oversize"), { dispatched: true });
  const event = await closed;
  assert.equal(event.code, 1009);
  assert.equal(event.reason, "Message exceeds 4096 bytes");
  assert.equal((await json("/rooms/direct-oversize/history")).rows.length, 0);
  const healthy = await socket("direct-oversize");
  healthy.ws.send("recovered after callback limit");
  assert.equal(await healthy.next(), "recovered after callback limit");
  healthy.ws.close();
});

test("room-level monitor route enforces GET independently of the outer connect guard", async () => {
  const response = await fetch(runtime.base + "/rooms/monitor-method/monitor", {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
  assert.equal(await response.text(), "GET required");
  const client = await socket("monitor-method", "/rooms/monitor-method/monitor");
  assert.equal((await json("/rooms/monitor-method/all-connections")).count, 1);
  client.ws.close();
});

test("nested room paths are forwarded intact and retain the room router's 404", async () => {
  for (const suffix of ["history/unexpected", "connections/unexpected"]) {
    const response = await fetch(`${runtime.base}/rooms/nested-path/${suffix}`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 404, `${suffix}: ${await response.clone().text()}`);
    await response.arrayBuffer();
  }
  assert.deepEqual((await json("/rooms/nested-path/history")).rows, []);
});
