/** Node-only fixture contracts; injected bindings do not prove Cloudflare service behavior. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { archiveFixture } from "./archive-fixture.ts";
import { exerciseCachePurge } from "./cache-purge.ts";
import { exerciseClientPolicy } from "./client-policy.ts";
import { changeJobSettings, observeJobSubmission } from "./jobs-settings.ts";

const request = (path, options) =>
  new Request(`https://fixture.test${path}`, options);

test("archive routing isolates key overrides and preserves request contents", async () => {
  const env = { ATTACHMENT_SSEC_KEY: "original", other: 42 };
  assert.equal(
    await archiveFixture(request("/archives/encrypted/a"), env),
    undefined,
  );
  for (const [variant, key] of [
    ["valid-key", "0123456789abcdef0123456789abcdef"],
    ["wrong-key", "fedcba9876543210fedcba9876543210"],
    ["missing-key", undefined],
  ]) {
    const result = await archiveFixture(
      request(`/__fixture/archives/${variant}/infrequent/a?x=1`, {
        method: "PUT",
        body: "content",
      }),
      env,
      async (forwarded, bindings) => {
        assert.equal(new URL(forwarded.url).pathname, "/archives/infrequent/a");
        assert.equal(new URL(forwarded.url).search, "?x=1");
        assert.equal(await forwarded.text(), "content");
        assert.equal(forwarded.method, "PUT");
        assert.equal(bindings.ATTACHMENT_SSEC_KEY, key);
        assert.equal(
          Object.hasOwn(bindings, "ATTACHMENT_SSEC_KEY"),
          variant !== "missing-key",
        );
        assert.equal(bindings.other, 42);
        return new Response("forwarded");
      },
    );
    assert.equal(await result.text(), "forwarded");
    assert.equal(env.ATTACHMENT_SSEC_KEY, "original");
  }
});

test("archive cleanup enforces DELETE and reports independently observed deletion", async () => {
  const calls = [];
  let present = true;
  const env = {
    EXAMPLE_BUCKET: {
      async delete(key) {
        calls.push(key);
      },
      async head() {
        return present ? {} : null;
      },
    },
  };
  const path = "/__fixture/archives/cleanup/encrypted/a";
  assert.equal((await archiveFixture(request(path), env)).status, 405);
  assert.deepEqual(calls, []);
  assert.deepEqual(
    await (
      await archiveFixture(request(path, { method: "DELETE" }), env)
    ).json(),
    { deleted: false },
  );
  present = false;
  assert.deepEqual(
    await (
      await archiveFixture(request(path, { method: "DELETE" }), env)
    ).json(),
    { deleted: true },
  );
  assert.deepEqual(calls, ["archives/encrypted/a", "archives/encrypted/a"]);
});

test("archive inspection handles missing objects, read failures and metadata", async () => {
  for (const outcome of ["missing", "throw", "body-throw", "readable"]) {
    const options = [];
    const env = {
      EXAMPLE_BUCKET: {
        async head() {
          return outcome === "missing"
            ? null
            : { storageClass: "InfrequentAccess", ssecKeyMd5: "digest" };
        },
        async get(key, option) {
          assert.equal(key, "archives/encrypted/a");
          options.push(option);
          if (outcome === "missing") {
            return null;
          }
          if (outcome === "throw") {
            throw new Error("denied");
          }
          return {
            async arrayBuffer() {
              if (outcome === "body-throw") {
                throw new Error("stream failed");
              }
              return new ArrayBuffer(0);
            },
          };
        },
      },
    };
    const body = await (
      await archiveFixture(
        request("/__fixture/archives/inspect/encrypted/a"),
        env,
      )
    ).json();
    assert.deepEqual(body, {
      storageClass: outcome === "missing" ? null : "InfrequentAccess",
      keyMetadataPresent: outcome !== "missing",
      wrongKeyReadable: outcome === "readable",
      noKeyReadable: outcome === "readable",
    });
    assert.equal(
      new TextDecoder().decode(options[0].ssecKey),
      "fedcba9876543210fedcba9876543210",
    );
    assert.equal(options[1], undefined);
  }
});

test("custom cache fixture injects each response and records exact options", async () => {
  for (const scenario of [
    "success",
    "missing",
    "throw",
    "malformed-success",
    "null",
    "rejected",
  ]) {
    const options = { tags: ["a"] };
    const result = await exerciseCachePurge(
      async (context, operation) => {
        assert.equal(operation, "tags");
        if (scenario === "missing") {
          assert.deepEqual(context, {});
          return '"missing"';
        }
        if (scenario === "throw") {
          await assert.rejects(
            context.cache.purge(options),
            /injected custom purge/,
          );
          return '"throw"';
        }
        const value = await context.cache.purge(options);
        const expected = {
          success: { success: true, errors: [] },
          "malformed-success": { success: "true", errors: [] },
          null: null,
          rejected: {
            success: false,
            errors: [{ code: 1001, message: "fixture policy refusal" }],
          },
        };
        assert.deepEqual(value, expected[scenario]);
        return JSON.stringify(value);
      },
      request(
        scenario === "success" ? "/" : `/?scenario=${scenario}&operation=tags`,
      ),
    );
    assert.deepEqual(
      (await result.json()).calls,
      scenario === "missing" ? [] : [options],
    );
  }
  await assert.rejects(
    exerciseCachePurge(async () => "invalid-json", request("/")),
    SyntaxError,
  );
});

test("client policy injects transport faults per path without changing original binding", async () => {
  const forwarded = [];
  const guide = {
    marker: 12,
    async fetch(input) {
      forwarded.push(new URL(input.url).pathname);
      return Response.json({ ok: true });
    },
  };
  const originalFetch = globalThis.fetch;
  const response = await exerciseClientPolicy(
    {
      async fetch(_request, env, ctx) {
        assert.equal(ctx.marker, 1);
        assert.equal(env.GUIDE.marker, 12);
        for (const path of ["retry", "no-retry", "exhausted"]) {
          await assert.rejects(
            env.GUIDE.fetch(request(`/client-target/${path}`)),
            /network interruption/,
          );
        }
        await assert.rejects(
          env.GUIDE.fetch(request("/client-target/retry")),
          /network interruption/,
        );
        assert.equal(
          (
            await env.GUIDE.fetch(
              request("/client-target/retry", {
                method: "POST",
                body: "payload",
                headers: { "Idempotency-Key": "key" },
              }),
            )
          ).status,
          200,
        );
        assert.equal(
          await (
            await env.GUIDE.fetch(request("/client-target/malformed"))
          ).text(),
          "{invalid-json",
        );
        return Response.json({ ok: true });
      },
    },
    request("/"),
    { GUIDE: guide },
    { marker: 1 },
  );
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.transportAttempts.length, 6);
  assert.deepEqual(body.transportAttempts[4], {
    path: "/client-target/retry",
    method: "POST",
    key: "key",
    body: "payload",
  });
  assert.deepEqual(forwarded, [
    "/client-target/retry",
    "/client-target/malformed",
  ]);
  assert.equal(globalThis.fetch, originalFetch);
});

test("client policy preserves errors and rejects malformed successful envelopes", async () => {
  const failed = new Response("failure", { status: 503 });
  assert.equal(
    await exerciseClientPolicy(
      { fetch: async () => failed },
      request("/"),
      { GUIDE: {} },
      {},
    ),
    failed,
  );
  for (const value of [null, [], "text", 1]) {
    await assert.rejects(
      exerciseClientPolicy(
        { fetch: async () => Response.json(value) },
        request("/"),
        { GUIDE: {} },
        {},
      ),
      /Expected client policy response object/,
    );
  }
  await assert.rejects(
    exerciseClientPolicy(
      {
        async fetch(_request, env) {
          return env.GUIDE.fetch(request("/client-target/malformed"));
        },
      },
      request("/"),
      { GUIDE: { fetch: async () => new Response(null, { status: 503 }) } },
      {},
    ),
    /destination returned 503/,
  );
});

test("settings fixture rejects unknown cases and propagates database failures", async () => {
  const statements = [];
  const database = {
    prepare(sql) {
      statements.push(sql);
      return { async run() {} };
    },
  };
  assert.equal((await changeJobSettings(database, "unknown")).status, 400);
  assert.deepEqual(statements, []);
  const expected = [
    "enabled=2",
    "enabled=0",
    "batch_limit=101",
    "score=1.25",
    "attachment='not a blob'",
    "enabled=1,batch_limit=25",
  ];
  for (const [index, scenario] of [
    "enabled-invalid",
    "disabled",
    "limit-invalid",
    "score-invalid",
    "blob-invalid",
    "restore",
  ].entries()) {
    assert.equal((await changeJobSettings(database, scenario)).status, 204);
    assert.ok(statements[index].includes(expected[index]));
  }
  const failure = new Error("database unavailable");
  await assert.rejects(
    changeJobSettings(
      {
        prepare() {
          return {
            async run() {
              throw failure;
            },
          };
        },
      },
      "restore",
    ),
    (error) => error === failure,
  );
});

test("submission observation forwards arguments and counts producers but not metrics", async () => {
  const calls = [];
  const queue = {
    async metrics() {
      calls.push(["metrics"]);
      return 7;
    },
    async send(...args) {
      calls.push(["send", ...args]);
      return "sent";
    },
    async sendBatch(...args) {
      calls.push(["batch", ...args]);
      return "batched";
    },
  };
  const input = request("/", { method: "POST", body: "input" });
  const context = {};
  const result = await observeJobSubmission(
    input,
    { JOBS_QUEUE: queue },
    context,
    async (received, env, ctx) => {
      assert.equal(received, input);
      assert.equal(ctx, context);
      assert.equal(await env.JOBS_QUEUE.metrics(), 7);
      assert.equal(await env.JOBS_QUEUE.send("a", { delaySeconds: 1 }), "sent");
      assert.equal(
        await env.JOBS_QUEUE.sendBatch(["b"], { delaySeconds: 2 }),
        "batched",
      );
      return new Response("result", {
        status: 202,
        statusText: "Queued",
        headers: { "X-Original": "yes" },
      });
    },
  );
  assert.deepEqual(calls, [
    ["metrics"],
    ["send", "a", { delaySeconds: 1 }],
    ["batch", ["b"], { delaySeconds: 2 }],
  ]);
  assert.equal(result.headers.get("X-Fixture-Queue-Producer-Calls"), "2");
  assert.equal(result.headers.get("X-Original"), "yes");
  assert.equal(result.status, 202);
  assert.equal(result.statusText, "Queued");
  assert.equal(await result.text(), "result");
  const empty = await observeJobSubmission(
    request("/"),
    { JOBS_QUEUE: queue },
    {},
    async () => new Response(null, { status: 204 }),
  );
  assert.equal(empty.headers.get("X-Fixture-Queue-Producer-Calls"), "0");
});

test("misc fixture rejects malformed configuration and preserves proxied database contracts", async () => {
  const { miscExampleFixture } = await import("./misc-example-fixture.ts");
  let forwarded = 0;
  const observeForward = async () => {
    forwarded++;
    return new Response("observed");
  };
  for (const [path, env, status] of [
    ["database", {}, 500],
    ["database", { JOBS_DB: null }, 500],
    ["socket?path=/unexpected", {}, 400],
    ["unknown", {}, 400],
  ]) {
    const response = await miscExampleFixture(
      request(`/__fixture/misc/${path}`),
      env,
      observeForward,
    );
    assert.equal(response.status, status);
  }
  assert.equal(forwarded, 0);
  await miscExampleFixture(
    request("/__fixture/misc/configuration"),
    {},
    observeForward,
  );
  assert.equal(forwarded, 1);
  await miscExampleFixture(
    request("/__fixture/misc/configuration"),
    {},
    async (_request, env) => {
      assert.equal(env.EXAMPLE_MODE, "");
      assert.equal(env.EXAMPLE_SECRET, "");
      return new Response("configured");
    },
  );
  const statement = {
    label: "statement",
    first() {
      return this.label;
    },
    bind() {
      return this;
    },
  };
  const database = {
    label: "database",
    prepare() {
      assert.equal(this, database);
      return statement;
    },
  };
  await miscExampleFixture(
    request("/__fixture/misc/database"),
    { JOBS_DB: database },
    async (_request, env) => {
      assert.equal(env.JOBS_DB.label, "database");
      const prepared = env.JOBS_DB.prepare("SELECT 1").bind();
      assert.equal(prepared.label, "statement");
      await assert.rejects(prepared.first(), /Missing database exec/);
      database.exec = async () => {};
      assert.equal(await prepared.first(), "statement");
      return new Response("checked");
    },
  );
});

test("R2 extra fixture rejects absent metadata and preserves native data properties", async () => {
  const { r2ExampleExtraFixture } = await import("./r2-example-extra.ts");
  const input = request("/__fixture/r2-extra/archive-error");
  let forwards = 0;
  const forward = async (_request, env) => {
    forwards++;
    assert.equal(env.EXAMPLE_BUCKET.label, "native bucket");
    return new Response("forwarded");
  };
  await assert.rejects(
    r2ExampleExtraFixture(
      input,
      { EXAMPLE_BUCKET: { put: async () => {}, head: async () => null } },
      forward,
    ),
    /R2 fixture metadata missing/,
  );
  assert.equal(forwards, 0);
  const deletions = [];
  const bucket = {
    label: "native bucket",
    put: async () => {},
    head: async () => ({}),
    delete: async (keys) => {
      deletions.push(keys);
    },
  };
  const response = await r2ExampleExtraFixture(
    input,
    { EXAMPLE_BUCKET: bucket },
    forward,
  );
  assert.equal((await response.json()).body, "forwarded");
  assert.equal(deletions.length, 1);
  assert.equal(forwards, 1);
});

test("new storage and R2 proxies preserve native properties and valid list requests", async () => {
  const { miscExampleFixture } = await import("./misc-example-fixture.ts");
  const { r2FailureExtraFixture } = await import("./r2-example-extra.ts");
  const invoke = async () => new Response("forwarded");
  assert.equal(
    await (
      await miscExampleFixture(
        request("/__fixture/misc/configuration"),
        {},
        invoke,
      )
    ).text(),
    "forwarded",
  );
  const support = async (namespace) => {
    assert.equal(namespace.label, "KV");
    assert.deepEqual(await namespace.list(), { options: undefined });
    assert.deepEqual(await namespace.list(null), { options: null });
    assert.deepEqual(await namespace.list({ limit: 1, cursor: "valid" }), {
      options: { limit: 1, cursor: "valid" },
    });
    return "{}";
  };
  for (const value of [null, undefined]) {
    assert.equal(
      (
        await miscExampleFixture(
          request("/__fixture/misc/storage-refusal"),
          { SETTINGS: value },
          invoke,
          undefined,
          support,
        )
      ).status,
      500,
    );
  }
  const namespace = {
    label: "KV",
    async list(options) {
      assert.equal(this, namespace);
      return { options };
    },
  };
  assert.equal(
    (
      await miscExampleFixture(
        request("/__fixture/misc/storage-refusal"),
        { SETTINGS: namespace },
        invoke,
        undefined,
        support,
      )
    ).status,
    200,
  );
  const response = await miscExampleFixture(
    request("/__fixture/misc/support-socket"),
    {},
    invoke,
    async (_connector, scenario) => {
      assert.equal(scenario, "unknown");
      return "{}";
    },
  );
  assert.equal(response.status, 200);
  const bucket = { label: "bucket" };
  assert.equal(
    (
      await r2FailureExtraFixture(
        request("/__fixture/r2-failure-extra/unknown"),
        { EXAMPLE_BUCKET: bucket },
        async (controlled) => {
          assert.equal(controlled.label, "bucket");
          return "{}";
        },
      )
    ).status,
    200,
  );
});

test("validator failure proxy preserves non-validation properties", async () => {
  const result = await observeJobSubmission(
    request("/?fixture=validator-failure"),
    {
      JOBS_QUEUE: {},
      JOBS_VALIDATOR: { label: "validator" },
    },
    {},
    async (_request, env) => {
      assert.equal(env.JOBS_VALIDATOR.label, "validator");
      await assert.rejects(
        env.JOBS_VALIDATOR.validate(),
        /private-validator-marker/,
      );
      return new Response("checked");
    },
  );
  assert.equal(await result.text(), "checked");
});
