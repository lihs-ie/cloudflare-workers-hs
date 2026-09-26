import { registerR2ExampleExtraTests } from "./r2-example-extra.cases.mjs";
import { registerMiscExampleExtraCases } from "./misc-example-extra.cases.mjs";
import { registerArchiveTests } from "./archives.cases.mjs";
import { registerSocketFailureTests } from "./socket-failures.cases.mjs";
import { registerCachePurgeTests } from "./cache-purge.cases.mjs";
import { registerClientUploadTests } from "./client-upload.cases.mjs";
import { registerClientStreamTests } from "./client-stream.cases.mjs";
import { registerAttachmentsTests } from "./attachments.cases.mjs";
import { registerClientOptionsTests } from "./client-options.cases.mjs";
import { registerConfigurationCases } from "./configuration.cases.mjs";
import { registerR2Tests } from "./r2.cases.mjs";
import { registerClientPolicyTests } from "./client-policy.cases.mjs";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startRuntime } from "../Support/dev-runtime.mjs";
import { registerWorkersAICases } from "./workers-ai.cases.mjs";

let runtime;
before(
  async () => {
    runtime = await startRuntime();
  },
  { timeout: 125000 },
);
after(async () => {
  await runtime?.close();
});
async function request(path, method = "GET") {
  const response = await fetch(runtime.base + path, {
    method,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(
    response.status,
    200,
    `${method} ${path}: ${await response.clone().text()}`,
  );
  return response.json();
}
test("Servant root handler serves health", async () =>
  assert.deepEqual(await request("/health"), { status: "ok" }));
test("real KV stores TTL metadata and reads a batch and key listing", async () => {
  const result = await request("/settings", "POST");
  assert.equal(result.value, "Download exports from the management API");
  assert.equal(JSON.parse(result.metadata).version, 1);
  assert.deepEqual(result.keys, ["display:guide"]);
  assert.equal(result.complete, true);
  assert.deepEqual(result.batch, [
    { key: "display:guide", value: result.value },
    { key: "display:absent", value: null },
  ]);
});
test("real Cache transitions miss to hit and invalidates", async () => {
  await request("/guide", "DELETE");
  assert.deepEqual(await request("/guide"), { cache: "miss" });
  assert.deepEqual(await request("/guide"), { cache: "hit" });
  assert.deepEqual(await request("/guide", "DELETE"), { removed: true });
  assert.deepEqual(await request("/guide"), { cache: "miss" });
});
test("real Service Binding calls the second Haskell worker", async () =>
  assert.deepEqual(await request("/service"), {
    status: 200,
    health: { status: "ok" },
    echo: "typed body",
    conflict: 409,
  }));
test("real TCP connector sends bytes and reads the bounded fixture echo", async () =>
  assert.deepEqual(await request("/tcp"), { message: "library-examples\n" }));

test("producer stream tolerates empty chunks and terminates at EOF", async () =>
  assert.deepEqual(await request("/stream"), { message: "streamed" }));

test("binary drain preserves bytes and releases the reader at EOF", async () => {
  const result = await request("/__fixture/stream?mode=success");
  assert.deepEqual(result.bytes, [0, 128, 255]);
  assert.equal(result.locked, false);
  assert.equal(result.cancelled, 0);
});
for (const mode of ["limit", "cancel-failure"])
  test(`byte limit cancels before WASM copy and releases lock (${mode})`, async () => {
    const result = await request(`/__fixture/stream?mode=${mode}`);
    assert.equal(result.outcome, "ReadableStreamExceededByteLimit");
    assert.equal(result.locked, false);
    assert.equal(result.cancelled, 1);
    assert.ok(
      result.memoryGrowth < 16 * 1024 * 1024,
      `unexpected WASM growth: ${result.memoryGrowth}`,
    );
  });
test("read failure releases reader and preserves original failure", async () => {
  const result = await request("/__fixture/stream?mode=failure");
  assert.match(result.error, /original stream failure/);
  assert.equal(result.locked, false);
});
for (const mode of ["cancel-delayed", "cancel-delayed-failure"]) {
  test(`byte limit waits for asynchronous producer cancellation (${mode})`, async () => {
    const result = await request(`/__fixture/stream?mode=${mode}`);
    assert.equal(result.outcome, "ReadableStreamExceededByteLimit");
    assert.equal(result.cancelled, 1);
    assert.equal(result.cancellationFinished, true);
    assert.equal(result.locked, false);
  });
}
test("native-shaped Tail events reach the real Haskell entrypoint", async () => {
  assert.deepEqual(await request("/__fixture/tail"), { delivered: true });
  const expected =
    /tail outcome=ok script=library-tail-fixture timestamp=Just 1788739200000/;
  const deadline = Date.now() + 5000;
  let log = "";
  while (Date.now() < deadline) {
    log = await readFile(`${runtime.state}/wrangler.log`, "utf8");
    if (expected.test(log)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(log, expected);
});

test("refused socket observes both failure promises and becomes closed", async () => {
  assert.deepEqual(await request("/__fixture/socket-failure"), {
    openedFailed: true,
    closedFailed: true,
    state: "SocketClosed",
  });
  const log = await readFile(`${runtime.state}/wrangler.log`, "utf8");
  assert.doesNotMatch(log, /Uncaught.*[Pp]romise|unhandled.*rejection/i);
});

for (const status of [200, 204, 205, 304])
  for (const variant of [0, 1]) {
    test(`native Response handles empty ${variant === 0 ? "strict" : "lazy"} bytes for ${status}`, async () => {
      assert.deepEqual(
        await request(
          `/__fixture/empty-response?status=${status}&variant=${variant}`,
        ),
        {
          status,
          nullBody: status !== 200,
          header: "retained",
          body: "",
        },
      );
    });
  }

registerClientPolicyTests(request);

registerR2Tests({ request });

test("real TLS socket verifies the fixture CA and exchanges encrypted bytes", async () => {
  assert.deepEqual(await request("/tls"), {
    message: "library-tls\n",
    upgraded: false,
    secureTransport: "SecureTransportOn",
  });
});
test("real StartTLS upgrades the existing TCP connection exactly once", async () => {
  assert.deepEqual(await request("/starttls"), {
    message: "library-tls\n",
    upgraded: true,
    secureTransport: "SecureTransportOn",
  });
});
test("workerd delivers the producer event to the configured Haskell Tail Worker", async () => {
  const { readFile } = await import("node:fs/promises");
  await request("/service");
  const deadline = Date.now() + 5000;
  let output = "";
  let delivered;
  while (Date.now() < deadline) {
    output = await readFile(`${runtime.state}/wrangler.log`, "utf8");
    const envelopes = [
      ...output.matchAll(/native-tail-envelope (\[[^\n]+\])/g),
    ].flatMap((match) => JSON.parse(match[1]));
    delivered = envelopes.find(
      (event) =>
        event.outcome === "ok" &&
        event.requestURL?.endsWith("/health") &&
        typeof event.timestamp === "number",
    );
    if (
      delivered &&
      output.includes(
        `tail outcome=ok script=${delivered.scriptName ?? "unknown"} timestamp=Just ${delivered.timestamp}`,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    delivered,
    "Real runtime Tail envelope should contain the guide HTTP event",
  );
  assert.ok(
    output.includes(
      `tail outcome=ok script=${delivered.scriptName ?? "unknown"} timestamp=Just ${delivered.timestamp}`,
    ),
    "Haskell tail decoder preserves the real envelope fields (scriptName is optional locally)",
  );
});

registerConfigurationCases(() => runtime);

registerAttachmentsTests(() => runtime);
registerClientOptionsTests(() => runtime);

test("declarative cache policy and uncached edge diagnostic", async () => {
  const guide = await fetch(runtime.base + "/guide");
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get("cache-control"), /public/);
  assert.match(guide.headers.get("cache-control"), /max-age=60/);
  const edge = await fetch(runtime.base + "/diagnostics/edge");
  assert.equal(edge.status, 200);
  assert.equal(edge.headers.get("cache-control"), "no-store");
  const value = await edge.json();
  assert.ok(value.colo === null || typeof value.colo === "string");
});

registerClientStreamTests(() => runtime);

registerClientUploadTests(() => runtime);

test("D1 catalog uses prepared parameters and typed reads repeatably", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await request("/database/catalog", "POST");
    assert.equal(result.written, true);
    assert.equal(result.firstPresent, true);
    assert.equal(result.rows, 1);
    assert.equal(result.title, "Worker's guide");
    assert.equal(result.setup.count, 1);
    for (const meta of [result.setup, result.writeMeta, result.readMeta]) {
      assert.equal(Number.isFinite(meta.durationMs), true);
      assert.ok(meta.durationMs >= 0);
    }
    for (const meta of [result.writeMeta, result.readMeta]) {
      for (const field of [
        "changes",
        "lastRowIdentifier",
        "rowsRead",
        "rowsWritten",
      ]) {
        assert.equal(
          Number.isSafeInteger(meta[field]),
          true,
          `${field} must be a native integer`,
        );
      }
    }
    assert.equal(result.writeMeta.changes, 1);
    assert.ok(Number.isInteger(result.writeMeta.lastRowIdentifier));
    assert.ok(result.writeMeta.lastRowIdentifier > 0);
    assert.ok(result.writeMeta.rowsWritten >= 1);
    assert.ok(result.writeMeta.rowsRead >= 0);
    assert.equal(result.readMeta.changes, 0);
    assert.equal(result.readMeta.rowsWritten, 0);
    assert.ok(result.readMeta.rowsRead >= 1);
  }
});
test("D1 syntax and constraint failures allow subsequent successful writes", async () => {
  assert.deepEqual(await request("/__fixture/database-failure"), {
    syntaxRejected: true,
    constraintRejected: true,
    recovered: 7,
  });
});

registerCachePurgeTests(() => runtime);

registerSocketFailureTests(request);

test("structured TCP address reaches the same server and observes peer EOF", async () => {
  const text = await request("/tcp");
  const structured = await request("/tcp-structured");
  assert.equal(structured.message, text.message);
  assert.equal(Number.isInteger(structured.port), true);
  assert.ok(structured.port >= 1 && structured.port <= 65535);
  assert.equal(structured.state, "SocketClosed");
});

registerArchiveTests(() => runtime);

test(
  "concurrent stream and service requests preserve independent I/O",
  { timeout: 20000 },
  async () => {
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        if (index % 2 === 0) {
          assert.deepEqual(await request("/stream"), { message: "streamed" });
        } else {
          assert.deepEqual(await request("/service"), {
            status: 200,
            health: { status: "ok" },
            echo: "typed body",
            conflict: 409,
          });
        }
      }),
    );
  },
);

registerR2ExampleExtraTests(() => runtime);
registerMiscExampleExtraCases(() => runtime);

registerWorkersAICases({ request });
