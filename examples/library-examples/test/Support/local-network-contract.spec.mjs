import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { startClientHttpFixture } from "./client-http-fixture.mjs";
import { certificate, startSocketFixtures } from "./socket-fixtures.mjs";
import { logRecordsFor, waitForRequestCompletion } from "./log-records.mjs";

function createStartTlsTransport(raw) {
  let first = true;
  const transport = new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      const bytes = first
        ? Buffer.concat([Buffer.from("STARTTLS\n"), chunk])
        : chunk;
      first = false;
      raw.write(bytes, callback);
    },
    final(callback) {
      raw.end(callback);
    },
    destroy(error, callback) {
      raw.destroy();
      callback(error);
    },
  });
  raw.on("data", (chunk) => transport.push(chunk));
  raw.on("end", () => transport.push(null));
  raw.on("error", (error) => transport.destroy(error));
  return transport;
}

async function connect(address) {
  const port = Number(address.split(":").at(-1));
  const socket = net.connect({ host: "127.0.0.1", port });
  await once(socket, "connect");
  return socket;
}

function observeData(socket) {
  const received = [];
  socket.on("data", (chunk) => received.push(chunk));
  return received;
}

function observeErrors(target) {
  const errors = [];
  target.on("error", (error) => errors.push(error));
  return errors;
}

async function rejectedInput(address, chunks, expected = Buffer.alloc(0)) {
  const socket = await connect(address);
  const received = observeData(socket);
  const closed = once(socket, "close");
  for (const chunk of chunks) {
    socket.write(chunk);
  }
  await closed;
  assert.deepEqual(Buffer.concat(received), expected);
}

test(
  "TCP fixtures reject oversized input and malformed STARTTLS without echoing",
  { timeout: 10000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    await rejectedInput(fixture.variables.TCP_ADDRESS, [
      Buffer.alloc(4097, 65),
    ]);
    await rejectedInput(fixture.variables.STARTTLS_ADDRESS, ["INVALID\n"]);
    await rejectedInput(fixture.variables.STARTTLS_ADDRESS, [
      Buffer.alloc(4097, 65),
    ]);
    const socket = await connect(fixture.variables.TCP_ADDRESS);
    const data = once(socket, "data");
    socket.write("hello");
    socket.write("\n");
    assert.equal((await data)[0].toString(), "hello\n");
    socket.destroy();
  },
);

test("closing socket fixtures disconnects an unfinished prelude", async () => {
  const fixture = await startSocketFixtures();
  const socket = await connect(fixture.variables.STARTTLS_ADDRESS);
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.on("error", (error) => assert.equal(error.code, "ECONNRESET"));
  socket.write("START");
  await fixture.close();
  await closed;
});

test("HTTP echo preserves absent and explicit headers and upload observations are copies", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  const absent = await (await fetch(`${fixture.origin}/stream-echo`)).json();
  assert.deepEqual(absent, {
    method: "GET",
    bytes: [],
    contentType: null,
    trace: null,
    attempts: 1,
  });
  const explicit = await (
    await fetch(`${fixture.origin}/stream-echo`, {
      method: "POST",
      body: new Uint8Array([0, 255]),
      headers: {
        "content-type": "application/octet-stream",
        "x-stream-trace": "contract",
      },
    })
  ).json();
  assert.deepEqual(explicit, {
    method: "POST",
    bytes: [0, 255],
    contentType: "application/octet-stream",
    trace: "contract",
    attempts: 2,
  });
  assert.throws(
    () => fixture.failNextUpload("invalid"),
    /Unknown upload failure mode/,
  );
  await (
    await fetch(`${fixture.origin}/stream-upload`, {
      method: "POST",
      body: "abc",
    })
  ).text();
  const observations = fixture.uploads();
  assert.equal(observations[0].bytes, 3);
  assert.equal(observations[0].ended, true);
  observations[0].bytes = 999;
  assert.equal(fixture.uploads()[0].bytes, 3);
  assert.equal(fixture.stats()["/stream-echo"], 2);
});

test("HTTP close cancels a pending body interruption and rejects a second close", async () => {
  const fixture = await startClientHttpFixture();
  fixture.interruptResponseBodies(1);
  const request = http.get(fixture.origin);
  observeErrors(request);
  const [response] = await once(request, "response");
  response.on("error", () => {});
  assert.equal(response.headers["content-length"], "1024");
  const closed = once(response, "close");
  // A premature response close intentionally emits an error as well.
  const closeObserved = closed.catch((error) => {
    assert.equal(error.code, "ECONNRESET");
  });
  await fixture.close();
  await closeObserved;
  await assert.rejects(fixture.close(), { code: "ERR_SERVER_NOT_RUNNING" });
});

test("flat log parser rejects nonfinite numbers and empty displays", async () => {
  const overflow = "9".repeat(400);
  for (const text of [
    "{\n }",
    `{\nrequest_id: 'current',\nstatus: ${overflow}\n}`,
    "{\nrequest_id: 'current',\nstatus: 'bad\\escape'\n}",
  ]) {
    assert.deepEqual(logRecordsFor(text, "current"), []);
  }
  assert.deepEqual(
    logRecordsFor(
      "\u001b[31m{\n\nrequest_id: 'current',\nstatus: -2.5\n}\u001b[0m",
      "current",
    ),
    [{ request_id: "current", status: -2.5 }],
  );
  await assert.rejects(
    waitForRequestCompletion(async () => {
      throw new Error("log read failed");
    }, "current"),
    /log read failed/,
  );
});

test("HTTP slow response survives normally and tolerates client cancellation", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  const successful = await (await fetch(`${fixture.origin}/slow`)).json();
  assert.deepEqual(successful, { received: true, attempts: 1 });
  const request = http.get(`${fixture.origin}/slow`);
  observeErrors(request);
  // Wait until the actual server has registered the request before aborting.
  const deadline = Date.now() + 1000;
  while (fixture.stats()["/slow"] !== 2) {
    assert.ok(Date.now() < deadline, "slow request must arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.deepEqual(await (await fetch(fixture.origin)).json(), {
    received: true,
    attempts: 1,
  });
});

test("HTTP stream disconnection is one-shot and interrupted responses recover", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  fixture.disconnectNextStream();
  await assert.rejects(
    fetch(`${fixture.origin}/stream-echo`, { method: "POST", body: "first" }),
  );
  const recovery = await (await fetch(`${fixture.origin}/stream-echo`)).json();
  assert.equal(recovery.attempts, 2);
  fixture.interruptResponseBodies(1);
  const interrupted = await fetch(fixture.origin);
  await assert.rejects(interrupted.text());
  assert.deepEqual(await (await fetch(fixture.origin)).json(), {
    received: true,
    attempts: 2,
  });
});

test("upload failures are consumed once and distinguish interrupted from completed bodies", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  for (const mode of ["during", "after"]) {
    fixture.failNextUpload(mode);
    await assert.rejects(
      fetch(`${fixture.origin}/stream-upload`, {
        method: "POST",
        body: "payload",
      }),
    );
    assert.deepEqual(
      await (
        await fetch(`${fixture.origin}/stream-upload`, {
          method: "POST",
          body: "ok",
        })
      ).json(),
      { ok: true },
    );
    const [failed, recovered] = fixture.uploads().slice(-2);
    assert.equal(failed.mode, mode);
    assert.equal(failed.bytes, 7);
    if (mode === "after") {
      assert.equal(failed.ended, true);
    }
    assert.equal(recovered.mode, null);
    assert.equal(recovered.ended, true);
    assert.equal(recovered.bytes, 2);
  }
  fixture.failNextUpload("early-success");
  assert.deepEqual(
    await (
      await fetch(`${fixture.origin}/stream-upload`, {
        method: "POST",
        body: "early",
      })
    ).json(),
    { ok: true },
  );
  assert.equal(fixture.uploads().at(-1).responseAtBytes, 5);
});

test("disconnect endpoint recovers on its third request and stream cancellation is counted", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(fetch(`${fixture.origin}/disconnect`));
  }
  assert.deepEqual(await (await fetch(`${fixture.origin}/disconnect`)).json(), {
    received: true,
    attempts: 3,
  });
  const response = await fetch(`${fixture.origin}/stream-response`);
  const reader = response.body.getReader();
  assert.deepEqual([...(await reader.read()).value], [0, 128, 255]);
  await reader.cancel();
  const deadline = Date.now() + 1000;
  while (fixture.closedStreamResponses() === 0) {
    assert.ok(Date.now() < deadline);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fixture.closedStreamResponses(), 1);
});

test("interrupted TCP endpoint returns its partial body then EOF", async (t) => {
  const fixture = await startSocketFixtures();
  t.after(() => fixture.close());
  const socket = await connect(fixture.variables.INTERRUPTED_TCP_ADDRESS);
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  const ended = once(socket, "end");
  socket.write("request\n");
  await ended;
  assert.equal(Buffer.concat(chunks).toString(), "partial");
});

test(
  "TLS fixtures verify their CA, reject an untrusted certificate, and upgrade STARTTLS",
  { timeout: 10000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    const ca = await readFile(certificate);
    for (const address of [
      fixture.variables.TLS_ADDRESS,
      fixture.variables.STARTTLS_ADDRESS,
    ]) {
      const raw = await connect(address);
      if (address === fixture.variables.STARTTLS_ADDRESS) {
        raw.write("STARTTLS\n");
      }
      const socket = tls.connect({ socket: raw, servername: "localhost", ca });
      t.after(() => socket.destroy());
      await once(socket, "secureConnect");
      assert.equal(socket.authorized, true);
      const chunks = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      const ended = once(socket, "end");
      socket.write("encrypted echo\n");
      await ended;
      assert.equal(Buffer.concat(chunks).toString(), "encrypted echo\n");
    }
    const raw = await connect(fixture.variables.UNTRUSTED_TLS_ADDRESS);
    const untrusted = tls.connect({ socket: raw, servername: "localhost", ca });
    t.after(() => untrusted.destroy());
    await assert.rejects(once(untrusted, "secureConnect"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });
  },
);

test(
  "TCP fixtures close idle connections at their configured deadline",
  { timeout: 8000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    const socket = await connect(fixture.variables.TCP_ADDRESS);
    t.after(() => socket.destroy());
    const received = observeData(socket);
    await once(socket, "end");
    assert.equal(Buffer.concat(received).length, 0);
  },
);

test("socket fixture startup releases earlier listeners when a later listen fails", async (t) => {
  const original = net.Server.prototype.listen;
  const servers = [];
  const failure = Object.assign(new Error("injected listen failure"), {
    code: "EADDRINUSE",
  });
  t.mock.method(net.Server.prototype, "listen", function (...args) {
    servers.push(this);
    if (servers.length === 3) {
      process.nextTick(() => this.emit("error", failure));
      return this;
    }
    return original.apply(this, args);
  });
  await assert.rejects(startSocketFixtures(), (error) => error === failure);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(servers.length, 3);
  assert.ok(servers.every((server) => !server.listening));
});

test("HTTP fixture propagates a listen failure", async (t) => {
  const failure = Object.assign(new Error("injected HTTP listen failure"), {
    code: "EACCES",
  });
  t.mock.method(net.Server.prototype, "listen", function () {
    process.nextTick(() => this.emit("error", failure));
    return this;
  });
  await assert.rejects(startClientHttpFixture(), (error) => error === failure);
});

test(
  "STARTTLS preserves a ClientHello delivered alongside the prelude",
  { timeout: 10000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    const raw = await connect(fixture.variables.STARTTLS_ADDRESS);
    const transport = createStartTlsTransport(raw);
    const socket = tls.connect({
      socket: transport,
      servername: "localhost",
      ca: await readFile(certificate),
    });
    t.after(() => socket.destroy());
    await once(socket, "secureConnect");
    assert.equal(socket.authorized, true);
    const data = once(socket, "data");
    const finished = once(transport, "finish");
    socket.end("coalesced\n");
    assert.equal((await data)[0].toString(), "coalesced\n");
    await finished;
  },
);

test(
  "early upload success keeps observing later chunks without issuing another response",
  { timeout: 5000 },
  async (t) => {
    const fixture = await startClientHttpFixture();
    t.after(() => fixture.close());
    fixture.failNextUpload("early-success");
    const socket = await connect(fixture.origin);
    t.after(() => socket.destroy());
    const response = once(socket, "data");
    socket.write(
      "POST /stream-upload HTTP/1.1\r\nHost: fixture.local\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n3\r\none\r\n",
    );
    assert.match((await response)[0].toString(), /200 OK/);
    assert.equal(fixture.uploads()[0].responseAtBytes, 3);
    assert.equal(fixture.uploads()[0].ended, false);
    socket.write("3\r\ntwo\r\n0\r\n\r\n");
    const deadline = Date.now() + 1000;
    while (!fixture.uploads()[0].ended) {
      assert.ok(Date.now() < deadline, "remaining upload must be observed");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(fixture.uploads()[0], {
      method: "POST",
      bytes: 6,
      ended: true,
      mode: "early-success",
      responseAtBytes: 3,
    });
  },
);

test(
  "STARTTLS waits for a complete prelude across separate server reads",
  { timeout: 5000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    const raw = await connect(fixture.variables.STARTTLS_ADDRESS);
    const originalEmit = net.Socket.prototype.emit;
    let observed;
    const firstRead = new Promise((resolve) => {
      observed = resolve;
    });
    t.mock.method(net.Socket.prototype, "emit", function (event, ...args) {
      const result = originalEmit.call(this, event, ...args);
      if (
        event === "data" &&
        Buffer.isBuffer(args[0]) &&
        args[0].equals(Buffer.from("START"))
      ) {
        observed();
      }
      return result;
    });
    raw.write("START");
    await firstRead;
    raw.write("TLS\n");
    const socket = tls.connect({
      socket: raw,
      servername: "localhost",
      ca: await readFile(certificate),
    });
    t.after(() => socket.destroy());
    await once(socket, "secureConnect");
    const response = once(socket, "data");
    socket.end("split prelude\n");
    assert.equal((await response)[0].toString(), "split prelude\n");
  },
);

test("malformed stream responses are consumed once and recover with valid JSON", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  fixture.malformNextStreamResponse();
  const malformed = await fetch(`${fixture.origin}/stream-echo`);
  await assert.rejects(malformed.json(), SyntaxError);
  assert.deepEqual(
    await (await fetch(`${fixture.origin}/stream-echo`)).json(),
    {
      method: "GET",
      bytes: [],
      contentType: null,
      trace: null,
      attempts: 2,
    },
  );
});

test(
  "TLS fixture rejects plaintext and stays available for authenticated clients",
  { timeout: 5000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    const invalid = await connect(fixture.variables.TLS_ADDRESS);
    t.after(() => invalid.destroy());
    const closed = once(invalid, "close");
    invalid.resume();
    invalid.write("plaintext is not a TLS record\n");
    await closed;
    const raw = await connect(fixture.variables.TLS_ADDRESS);
    const socket = tls.connect({
      socket: raw,
      servername: "localhost",
      ca: await readFile(certificate),
    });
    t.after(() => socket.destroy());
    await once(socket, "secureConnect");
    const response = once(socket, "data");
    socket.end("recovered\n");
    assert.equal((await response)[0].toString(), "recovered\n");
  },
);

test("empty and failed stream responses are one-shot and upload HTTP failure records completion", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  assert.throws(
    () => fixture.nextStreamResponse("invalid"),
    /Unknown stream response mode/,
  );
  fixture.failNextUpload("http-error");
  const failed = await fetch(`${fixture.origin}/stream-upload`, {
    method: "POST",
    body: "complete",
  });
  assert.equal(failed.status, 409);
  assert.equal(fixture.uploads()[0].ended, true);
  assert.equal(fixture.uploads()[0].bytes, 8);
  await failed.text();
  for (const mode of ["empty", "read-failure"]) {
    fixture.nextStreamResponse(mode);
    const response = await fetch(`${fixture.origin}/stream-response`);
    assert.equal(response.status, 200);
    if (mode === "empty") {
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    } else {
      assert.equal(response.headers.get("content-length"), "10");
      await assert.rejects(response.arrayBuffer());
    }
    const recovered = await fetch(`${fixture.origin}/stream-response`);
    const reader = recovered.body.getReader();
    assert.deepEqual([...(await reader.read()).value], [0, 128, 255]);
    await reader.cancel();
  }
});

test("request error observer retains an explicit cancellation error", async (t) => {
  const fixture = await startClientHttpFixture();
  t.after(() => fixture.close());
  const request = http.get(`${fixture.origin}/slow`);
  const errors = observeErrors(request);
  const reported = once(request, "error");
  const failure = new Error("controlled request cancellation");
  request.destroy(failure);
  assert.equal((await reported)[0], failure);
  assert.deepEqual(errors, [failure]);
});

test("STARTTLS transport propagates raw socket errors and releases the connection", async (t) => {
  const fixture = await startSocketFixtures();
  t.after(() => fixture.close());
  const raw = await connect(fixture.variables.STARTTLS_ADDRESS);
  const transport = createStartTlsTransport(raw);
  const reported = once(transport, "error");
  const failure = new Error("controlled raw socket failure");
  raw.destroy(failure);
  assert.equal((await reported)[0], failure);
  assert.equal(raw.destroyed, true);
  assert.equal(transport.destroyed, true);
});

test(
  "TCP echo buffers separate chunks and recovers after a tracked socket error",
  { timeout: 5000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    // Positive control proves the same data collector used for rejection and idle
    // assertions observes bytes when the peer actually sends them.
    await rejectedInput(
      fixture.variables.TCP_ADDRESS,
      ["control\n"],
      Buffer.from("control\n"),
    );
    const raw = await connect(fixture.variables.TCP_ADDRESS);
    t.after(() => raw.destroy());
    const originalEmit = net.Socket.prototype.emit;
    let observed;
    const firstRead = new Promise((resolve) => {
      observed = resolve;
    });
    let accepted;
    t.mock.method(net.Socket.prototype, "emit", function (event, ...args) {
      const result = originalEmit.call(this, event, ...args);
      if (
        event === "data" &&
        Buffer.isBuffer(args[0]) &&
        args[0].equals(Buffer.from("buffered"))
      ) {
        accepted = this;
        observed();
      }
      return result;
    });
    raw.write("buffered");
    await firstRead;
    const response = once(raw, "data");
    raw.write("\n");
    assert.equal((await response)[0].toString(), "buffered\n");
    accepted.emit("error", new Error("controlled accepted socket error"));
    accepted.destroy();
    await rejectedInput(
      fixture.variables.TCP_ADDRESS,
      ["recovery\n"],
      Buffer.from("recovery\n"),
    );
  },
);

test(
  "transport forwards a graceful peer EOF to its readable consumer",
  { timeout: 5000 },
  async (t) => {
    const fixture = await startSocketFixtures();
    t.after(() => fixture.close());
    const raw = await connect(fixture.variables.INTERRUPTED_TCP_ADDRESS);
    const transport = createStartTlsTransport(raw);
    t.after(() => transport.destroy());
    const received = observeData(transport);
    const ended = once(transport, "end");
    transport.end("request");
    await ended;
    assert.equal(Buffer.concat(received).toString(), "partial");
  },
);
