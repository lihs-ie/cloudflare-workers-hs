/** Node boundary tests of fixture orchestration, not Haskell or native service proofs. */
import assert from "node:assert/strict";
import { test, mock, after } from "node:test";
import { registerHooks } from "node:module";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
        shortCircuit: true,
      };
    }
    if (
      specifier.startsWith(".") &&
      (specifier.endsWith(".js") || specifier === "./runtime")
    ) {
      const path =
        specifier === "./runtime"
          ? "./runtime.ts"
          : specifier.slice(0, -3) + ".ts";
      return next(path, context);
    }
    return next(specifier, context);
  },
});
const reactor = {};
const runtimeMocks = ["./runtime.ts", "../../worker/runtime.ts"].map((path) =>
  mock.module(new URL(path, import.meta.url).href, {
    namedExports: { reactor },
  }),
);
const { inspectJobsFailure } = await import("./jobs-failures.ts");
const { inspectClientStream } = await import("./client-stream.ts");
const { inspectQueueContract } = await import("./queue-contracts.ts");
const { consumeObservedJobs, jobsQueueFixture } =
  await import("./jobs-queue.ts");
const { JobsState } = await import("./jobs-state.ts");
after(() => {
  runtimeMocks.forEach((item) => item.restore());
  hooks.deregister();
});

test("stream fixtures reject unknown modes and expose controlled stream failures", async () => {
  for (const mode of [null, "unknown"]) {
    assert.equal((await inspectClientStream(mode)).status, 400);
  }
  for (const [mode, expectedMode] of [
    ["eof", 0],
    ["early", 1],
    ["consumer-before", 2],
    ["consumer-after", 3],
    ["read-failure", 0],
    ["cancel-failure", 3],
    ["http-error", 0],
  ]) {
    reactor.clientStreamLifecycle = async (binding, callbackMode) => {
      assert.equal(callbackMode, expectedMode);
      const response = await binding.fetch();
      assert.equal(response.status, mode === "http-error" ? 409 : 200);
      const reader = response.body.getReader();
      try {
        if (mode === "read-failure") {
          await assert.rejects(reader.read(), /original producer failure/);
        } else {
          assert.deepEqual(
            (await reader.read()).value,
            new Uint8Array([0, 128, 255]),
          );
          if (mode === "eof" || mode === "http-error") {
            assert.equal((await reader.read()).done, true);
          } else if (mode === "cancel-failure") {
            await assert.rejects(reader.cancel(), /cleanup must not replace/);
          } else {
            await reader.cancel();
          }
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.stringify({ observed: mode });
    };
    assert.deepEqual(await (await inspectClientStream(mode)).json(), {
      observed: mode,
      locked: false,
      inputLocked: false,
      cancelled: ["eof", "http-error", "read-failure"].includes(mode) ? 0 : 1,
    });
  }
});

test("queue fixture exposes rejection, absent and malformed metrics faithfully", async () => {
  const context = {};
  for (const mode of ["send", "send-batch", "metrics", "batch"]) {
    for (const variant of [
      "success",
      "reject",
      "absent",
      "invalid",
      "getter",
      "date",
    ]) {
      reactor.queueContract = async (receivedMode, input, env, ctx) => {
        assert.equal(receivedMode, mode);
        assert.equal(ctx, context);
        assert.deepEqual(env, {});
        let metrics;
        if (mode !== "batch") {
          const method = mode === "send-batch" ? "sendBatch" : mode;
          if (variant === "reject") {
            await assert.rejects(input[method](), /synthetic .* rejection/);
            return '"rejected"';
          }
          const result = await input[method]();
          metrics = mode === "metrics" ? result : result?.metadata.metrics;
        } else {
          assert.equal(input.queue, "synthetic-contract");
          assert.equal(input.messages[0].body, '{"valid":true}');
          assert.equal(input.messages[1].body, "{broken");
          input.messages[0].ack();
          input.messages[1].retry({});
          input.messages[1].retry({ delaySeconds: 5 });
          input.ackAll();
          input.retryAll({ delaySeconds: 7 });
          metrics = input.metadata?.metrics;
        }
        if (variant === "absent" && mode !== "metrics") {
          assert.equal(metrics, undefined);
        } else if (variant === "invalid") {
          assert.equal(
            mode === "batch" ? metrics : metrics.backlogCount,
            mode === "batch" ? null : -1,
          );
        } else if (variant === "getter") {
          assert.throws(() => metrics.backlogCount, /synthetic getter failure/);
        } else if (variant === "date") {
          assert.ok(Number.isNaN(metrics.oldestMessageTimestamp.getTime()));
        } else {
          assert.equal(metrics.backlogCount, 7);
        }
        return '"observed"';
      };
      const body = await (
        await inspectQueueContract(`${mode}~${variant}`, context)
      ).json();
      assert.deepEqual(
        body.calls,
        mode === "batch"
          ? ["ack:0", "retry:1:default", "retry:1:5", "ackAll", "retryAll:7"]
          : [mode === "send-batch" ? "sendBatch" : mode],
      );
    }
  }
});

function databaseFixture() {
  const queries = [];
  return {
    queries,
    async exec(sql) {
      queries.push(["exec", sql]);
    },
    prepare(sql) {
      return {
        bind(...args) {
          queries.push([sql, ...args]);
          return {
            async run() {},
            async all() {
              return { results: [{ attempts: 2 }] };
            },
          };
        },
      };
    },
  };
}

test("queue ingress validates identifiers, forwards mixed payloads and filters delivery query", async () => {
  const batches = [];
  const database = databaseFixture();
  const env = {
    JOBS_DB: database,
    JOBS_QUEUE: {
      async sendBatch(batch) {
        batches.push(batch);
      },
    },
  };
  const request = (suffix, method = "GET") =>
    new Request(`https://fixture.test/__fixture/jobs/queue/${suffix}`, {
      method,
    });
  for (const run of ["", "bad_underscore", "a".repeat(51)]) {
    assert.equal(
      (await jobsQueueFixture(request(`mixed?run=${run}`, "POST"), env)).status,
      400,
    );
  }
  assert.equal(
    (await jobsQueueFixture(request("mixed?run=abc", "POST"), env)).status,
    202,
  );
  assert.deepEqual(
    batches[0].map((item) => [
      item.body.identifier,
      item.body.payload,
      item.contentType,
    ]),
    [
      ["queue-contract-abc-good-a", "first valid job", "json"],
      ["queue-contract-abc-poison", 123, "json"],
      ["queue-contract-abc-good-b", "second valid job", "json"],
    ],
  );
  assert.deepEqual(
    await (await jobsQueueFixture(request("deliveries?run=abc"), env)).json(),
    [{ attempts: 2 }],
  );
  assert.deepEqual(database.queries[1].slice(1), [
    "queue-contract-abc-good-a",
    "queue-contract-abc-poison",
    "queue-contract-abc-good-b",
  ]);
  assert.equal(
    (await jobsQueueFixture(request("mixed?run=abc"), env)).status,
    404,
  );
});

test("observed jobs persist fixture deliveries before DLQ acknowledgement or delegation", async () => {
  for (const queue of ["library-jobs-dlq", "library-jobs"]) {
    const database = databaseFixture();
    let acked = false,
      delegated = false;
    const batch = {
      queue,
      messages: [
        null,
        "text",
        {},
        { identifier: 5 },
        { identifier: "ordinary" },
        { identifier: "queue-contract-a" },
      ].map((body) => ({ body, attempts: 2 })),
      ackAll() {
        assert.equal(database.queries.length, 2);
        acked = true;
      },
    };
    const env = { JOBS_DB: database },
      context = {};
    reactor.queue = async (received, bindings, ctx) => {
      assert.equal(received, batch);
      assert.equal(bindings, env);
      assert.equal(ctx, context);
      delegated = true;
    };
    await consumeObservedJobs(batch, env, context);
    assert.equal(acked, queue === "library-jobs-dlq");
    assert.equal(delegated, queue !== "library-jobs-dlq");
    assert.deepEqual(database.queries[1].slice(1, 4), [
      queue,
      "queue-contract-a",
      2,
    ]);
    assert.deepEqual(JSON.parse(database.queries[1][4]), [
      "unidentified",
      "unidentified",
      "unidentified",
      "unidentified",
      "ordinary",
      "queue-contract-a",
    ]);
  }
});

test("job state injects one transient error and tracks lost committed responses", async () => {
  const values = new Map();
  const storage = {
    async get(key) {
      return values.get(key);
    },
    async put(key, value) {
      values.set(key, value);
    },
  };
  reactor.jobsInitialize = async (received) => {
    assert.equal(received, storage);
  };
  let commits = 0;
  reactor.jobsCommit = async () => {
    commits += 1;
    return '"committed"';
  };
  reactor.jobsStatus = async () => '{"status":"done"}';
  const state = new JobsState(
    { storage, blockConcurrencyWhile: (action) => action() },
    {},
  );
  await assert.rejects(
    state.commit('{"identifier":"retry-once"}'),
    /transient storage failure/,
  );
  assert.equal(commits, 0);
  assert.equal(
    await state.commit('{"identifier":"retry-once"}'),
    '"committed"',
  );
  await assert.rejects(
    state.commit('{"identifier":"commit-response-lost"}'),
    /RPC response loss after commit/,
  );
  assert.equal(commits, 2);
  assert.equal(
    await state.commit('{"identifier":"commit-response-lost"}'),
    '"committed"',
  );
  assert.deepEqual(JSON.parse(await state.status("commit-response-lost")), {
    status: "done",
    attempts: 2,
  });
  assert.equal(await state.status("ordinary"), '{"status":"done"}');
  for (const value of [null, [], 1, {}, { identifier: "ordinary" }]) {
    assert.equal(await state.commit(JSON.stringify(value)), '"committed"');
  }
  for (const value of ["bad", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    values.set("fixture:response-loss-attempts", value);
    await assert.rejects(
      state.commit('{"identifier":"commit-response-lost"}'),
      /Invalid response-loss attempt counter/,
    );
  }
  for (const value of [undefined, "bad", 0, -1, 0.5]) {
    values.set("fixture:response-loss-attempts", value);
    await assert.rejects(
      state.status("commit-response-lost"),
      /Invalid response-loss attempt counter/,
    );
  }
  reactor.jobsStatus = async () => "null";
  assert.equal(await state.status("commit-response-lost"), "null");
  for (const value of [[], "bad", 1]) {
    reactor.jobsStatus = async () => JSON.stringify(value);
    await assert.rejects(
      state.status("commit-response-lost"),
      /Invalid persisted job status/,
    );
  }
});

test("delivery evidence failures prevent acknowledgement and application delegation", async () => {
  for (const stage of ["prepare", "insert", "success"]) {
    for (const queue of ["library-jobs", "library-jobs-dlq"]) {
      const failure = new Error(`${stage} unavailable`);
      let acknowledged = false;
      let delegated = false;
      reactor.queue = async () => {
        delegated = true;
      };
      const database = {
        async exec() {
          if (stage === "prepare") {
            throw failure;
          }
        },
        prepare() {
          return {
            bind() {
              return {
                async run() {
                  if (stage === "insert") {
                    throw failure;
                  }
                },
              };
            },
          };
        },
      };
      const consuming = consumeObservedJobs(
        {
          queue,
          messages: [
            { body: { identifier: "queue-contract-one" }, attempts: 1 },
          ],
          ackAll() {
            acknowledged = true;
          },
        },
        { JOBS_DB: database },
        {},
      );
      if (stage === "success") {
        await consuming;
        assert.equal(acknowledged, queue === "library-jobs-dlq");
        assert.equal(delegated, queue !== "library-jobs-dlq");
      } else {
        await assert.rejects(consuming, (error) => error === failure);
        assert.equal(acknowledged, false);
        assert.equal(delegated, false);
      }
    }
  }
});

test("fixture ingress does not turn producer rejection into an accepted response", async () => {
  const failure = new Error("queue unavailable");
  await assert.rejects(
    jobsQueueFixture(
      new Request("https://fixture.test/__fixture/jobs/queue/mixed?run=valid", {
        method: "POST",
      }),
      {
        JOBS_QUEUE: {
          async sendBatch() {
            throw failure;
          },
        },
      },
    ),
    (error) => error === failure,
  );
});

test("runtime fixtures preserve reactor failures and reject malformed encoded results", async () => {
  for (const invoke of [
    () => inspectClientStream("eof"),
    () => inspectQueueContract("send~success", {}),
  ]) {
    const failure = new Error("reactor unavailable");
    reactor.clientStreamLifecycle = reactor.queueContract = async () => {
      throw failure;
    };
    await assert.rejects(invoke(), (error) => error === failure);
    reactor.clientStreamLifecycle = reactor.queueContract = async () =>
      "not JSON";
    await assert.rejects(invoke(), SyntaxError);
  }
});

test("Jobs failure fixture rejects unknown and inherited scenario names", async () => {
  for (const scenario of ["unknown", "constructor", "toString", "__proto__"]) {
    const response = await inspectJobsFailure(scenario);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), "Unknown Jobs failure scenario");
  }
});
test("Jobs fixture guards namespaces and supports unfiltered ascending list contracts", async () => {
  reactor.jobsFailure = async (mode, namespace) => {
    assert.equal(mode, "read");
    assert.throws(
      () => namespace.getByName("wrong"),
      /Unexpected namespace name/,
    );
    return "{}";
  };
  assert.equal((await inspectJobsFailure("read-json")).status, 200);
  reactor.jobsFailure = async (_mode, storage) => {
    const records = await storage.list({});
    assert.ok(records instanceof Map);
    assert.deepEqual([...records.keys()], [...records.keys()].sort());
    return "{}";
  };
  assert.equal((await inspectJobsFailure("save-prune")).status, 200);
});
