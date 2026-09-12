import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startRuntime } from "../Support/dev-runtime.mjs";
let runtime;
before(
  async () => {
    runtime = await startRuntime();
  },
  { timeout: 120000 },
);
after(async () => {
  await runtime?.dispose();
});
async function request(path, method = "GET", body) {
  const response = await fetch(runtime.base + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    `${method} ${path}: ${text}; ${runtime.logPath}`,
  );
  return JSON.parse(text);
}
async function waitFor(identifier, target) {
  const deadline = performance.now() + 25000;
  let current;
  while (performance.now() < deadline) {
    current = await request(`/workflows/${identifier}`);
    if (current.state === target) {
      return current;
    }
    if (current.state === "WorkflowErrored") {
      assert.fail(
        `unexpected workflow failure ${JSON.stringify(current)}; ${runtime.logPath}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(
    `workflow never reached ${target}: ${JSON.stringify(current)}; ${runtime.logPath}`,
  );
}
async function waitForApproval(identifier, minimumCheckpoints = 1) {
  const deadline = performance.now() + 10000;
  let audit;
  while (performance.now() < deadline) {
    audit = await request(`/workflows/${identifier}/audit`);
    if (audit.attempts.filter((row) => row.step === "await-approval").length >= minimumCheckpoints) {
      const status = await request(`/workflows/${identifier}`);
      assert.ok(["WorkflowRunning", "WorkflowWaiting"].includes(status.state));
      assert.equal(status.output, null);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = await request(`/workflows/${identifier}`);
  assert.fail(
    `workflow never reached approval checkpoint: ${JSON.stringify({
      identifier, minimumCheckpoints, status, audit,
    })}; ${runtime.evidence}/wrangler.log`,
  );
}
test(
  "real Workflow waits for approval then retries without duplicating its side effect",
  { timeout: 40000 },
  async () => {
    await request("/workflows", "POST", {
      identifier: "retry-approval",
      parameters: { message: "publish report", behavior: "retry" },
    });
    await waitForApproval("retry-approval");
    const before = await request("/workflows/retry-approval/audit");
    assert.equal(before.effects.total, 0);
    assert.deepEqual(
      before.attempts.map(({ step, attempt }) => [step, attempt]),
      [
        ["prepare-request", 1],
        ["await-approval", 1],
      ],
    );
    await request("/workflows/retry-approval/approve", "POST", {
      approved: true,
    });
    const completed = await waitFor("retry-approval", "WorkflowComplete");
    assert.deepEqual(completed.output, {
      message: "publish report",
      approved: true,
    });
    const after = await request("/workflows/retry-approval/audit");
    assert.deepEqual(
      after.attempts
        .filter((row) => row.step === "commit-request")
        .map((row) => row.attempt),
      [1, 2, 3],
    );
    assert.equal(after.effects.total, 1);
    assert.equal(
      after.attempts.filter((row) => row.step === "finish-request").length,
      1,
    );
  },
);
test(
  "real NonRetryableError prevents native Workflow retries",
  { timeout: 15000 },
  async () => {
    await request("/workflows", "POST", {
      identifier: "permanent-failure",
      parameters: { message: "invalid report", behavior: "fail" },
    });
    await waitForApproval("permanent-failure");
    await request("/workflows/permanent-failure/approve", "POST", {
      approved: true,
    });
    const failed = await waitFor("permanent-failure", "WorkflowErrored");
    assert.match(failed.error, /NonRetryableError/);
    const audit = await request("/workflows/permanent-failure/audit");
    assert.equal(audit.effects.total, 0);
    assert.deepEqual(
      audit.attempts.map(({ step, attempt }) => [step, attempt]),
      [
        ["prepare-request", 1],
        ["await-approval", 1],
        ["commit-request", 1],
      ],
    );
  },
);
test(
  "completed steps remain durable across actual wrangler process restart",
  { timeout: 60000 },
  async () => {
    await request("/workflows", "POST", {
      identifier: "restart-approval",
      parameters: { message: "survive restart", behavior: "normal" },
    });
    await waitForApproval("restart-approval");
    const before = await request("/workflows/restart-approval/audit");
    const { state, port } = runtime;
    await runtime.close();
    runtime = await startRuntime({ state, port });
    await request("/workflows/restart-approval/approve", "POST", {
      approved: false,
    });
    const completed = await waitFor("restart-approval", "WorkflowComplete");
    assert.deepEqual(completed.output, {
      message: "survive restart",
      approved: false,
    });
    const after = await request("/workflows/restart-approval/audit");
    assert.deepEqual(
      after.attempts.filter((row) =>
        ["prepare-request", "await-approval"].includes(row.step),
      ),
      before.attempts,
    );
    assert.equal(after.effects.total, 1);
  },
);

for (const behavior of [
  "timeout",
  "lazy-output",
  "lazy-step",
  "unsafe-integer",
]) {
  test(`Workflow safely contains ${behavior}`, { timeout: 15000 }, async () => {
    const identifier = `fixture-${behavior}`;
    await request("/__fixture/create", "POST", {
      identifier,
      parameters: { message: "fixture", behavior },
    });
    const failed = await waitFor(identifier, "WorkflowErrored");
    if (behavior === "timeout") {
      assert.match(failed.error, /time|Timeout/i);
      const audit = await request(`/workflows/${identifier}/audit`);
      assert.deepEqual(
        audit.attempts
          .filter((row) => row.step === "hung-callback")
          .map((row) => row.attempt),
        [1, 2],
      );
      assert.deepEqual(
        audit.attempts
          .filter((row) => row.step === "cancelled-callback")
          .map((row) => row.attempt),
        [1, 2],
      );
    } else if (behavior === "unsafe-integer") {
      assert.match(failed.error, /NonRetryableError|safe integer/);
    } else {
      assert.match(failed.error, /lazy .* output failure/);
    }
    assert.deepEqual(
      await request("/health"),
      { status: "ok" },
      "WASM remains usable after the contained failure",
    );
  });
}

test(
  "Workflow lifecycle control pauses, resumes, terminates and restarts",
  { timeout: 20000 },
  async () => {
    const identifier = "controlled-approval";
    await request("/workflows", "POST", {
      identifier,
      parameters: { message: "controlled", behavior: "normal" },
    });
    await waitForApproval(identifier);
    await request(`/workflows/${identifier}/control`, "POST", "pause");
    await waitFor(identifier, "WorkflowPaused");
    await request(`/workflows/${identifier}/control`, "POST", "resume");
    await request(`/workflows/${identifier}/control`, "POST", "terminate");
    await waitFor(identifier, "WorkflowTerminated");
    assert.deepEqual(
      await request(`/workflows/${identifier}/control`, "POST", "restart"),
      { accepted: true, identifier, operation: "restart" },
    );
    await waitForApproval(identifier, 2);
    await request(`/workflows/${identifier}/approve`, "POST", {
      approved: true,
    });
    await waitFor(identifier, "WorkflowComplete");
    const response = await fetch(
      runtime.base + "/workflows/missing-instance/control",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify("terminate"),
        signal: AbortSignal.timeout(5000),
      },
    );
    assert.equal(response.status, 500);
    assert.match(await response.text(), /instance|Workflow|not/i);
  },
);

test(
  "typed D1 queries preserve bindings, nullable rows and native batch rollback",
  { timeout: 10000 },
  async () => {
    const result = await request("/__fixture/d1-query");
    assert.equal(result.batchCount, 2);
    assert.deepEqual(result.rows, [
      ["quoted-' ; DROP TABLE typed_query_items; --", null, 7, [0, 255]],
      ["second", "present", 8, [97]],
    ]);
    assert.equal(result.first, 7);
    assert.equal(result.absent, null);
    assert.equal(result.rolledBack, null);
    assert.equal(
      result.missing,
      'D1RowDecodeFailed 1 (D1MissingColumn "count")',
    );
    assert.equal(result.null, 'D1RowDecodeFailed 1 (D1UnexpectedNull "count")');
    assert.equal(
      result.wrongType,
      'D1RowDecodeFailed 1 (D1ColumnTypeMismatch "count" D1IntegerType D1TextType)',
    );
    assert.match(
      result.unsafeInteger,
      /D1InvalidColumnValue.*exact JavaScript numeric range/,
    );
    assert.equal(result.exactLargeInteger, "9007199254740993");
    assert.equal(result.unsafeParameterRejected, true);
  },
);

test("UTC execution dates reject malformed and non-UTC input", async () => {
  for (const executeAt of [
    "tomorrow",
    "2026-02-30T12:00:00Z",
    "2026-09-08T12:00:00+09:00",
    "2026-09-08",
    123,
  ]) {
    const response = await fetch(runtime.base + "/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "invalid-date",
        parameters: { message: "scheduled", behavior: "normal", executeAt },
      }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      response.status,
      400,
      `unexpected status for ${executeAt}: ${await response.text()}`,
    );
  }
});

test(
  "past UTC execution still requires approval and then finishes immediately",
  { timeout: 15000 },
  async () => {
    const identifier = "past-execution";
    await request("/workflows", "POST", {
      identifier,
      parameters: {
        message: "past",
        behavior: "normal",
        executeAt: "2000-01-01T00:00:00Z",
      },
    });
    await waitForApproval(identifier);
    assert.equal(
      (await request(`/workflows/${identifier}/audit`)).attempts.some(
        (row) => row.step === "finish-request",
      ),
      false,
    );
    await request(`/workflows/${identifier}/approve`, "POST", {
      approved: true,
    });
    assert.deepEqual((await waitFor(identifier, "WorkflowComplete")).output, {
      message: "past",
      approved: true,
    });
    const audit = await request(`/workflows/${identifier}/audit`);
    assert.equal(audit.attempts.some((row) => row.step === "scheduled-execution"), false);
    assert.equal(audit.effects.total, 1);
  },
);

test(
  "approved Workflow finishes no earlier than its UTC execution date",
  { timeout: 20000 },
  async () => {
    const identifier = "future-execution";
    const target = Date.now() + 6000;
    await request("/workflows", "POST", {
      identifier,
      parameters: {
        message: "future",
        behavior: "normal",
        executeAt: new Date(target).toISOString(),
      },
    });
    await waitForApproval(identifier);
    assert.ok(
      Date.now() < target,
      "approval checkpoint must precede scheduled time",
    );
    await request(`/workflows/${identifier}/approve`, "POST", {
      approved: true,
    });
    while (Date.now() < target - 200) {
      const audit = await request(`/workflows/${identifier}/audit`);
      assert.equal(
        audit.attempts.some((row) => row.step === "finish-request"),
        false,
      );
      assert.equal(
        audit.effects.total,
        0,
        "scheduled business write must wait too",
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = await waitFor(identifier, "WorkflowComplete");
    assert.ok(Date.now() >= target);
    assert.deepEqual(completed.output, { message: "future", approved: true });
  },
);

async function waitForAuditStep(identifier, name) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const audit = await request(`/workflows/${identifier}/audit`);
    if (audit.attempts.some((row) => row.step === name)) {
      return audit;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`missing checkpoint ${name}; ${runtime.logPath}`);
}

test(
  "explicit event wake-up after process restart replays the UTC execution gate",
  { timeout: 60000 },
  async () => {
    const identifier = "scheduled-process-restart";
    const target = Date.now() + 10000;
    await request("/workflows", "POST", {
      identifier,
      parameters: {
        message: "durable timer",
        behavior: "normal",
        executeAt: new Date(target).toISOString(),
      },
    });
    await waitForApproval(identifier);
    await request(`/workflows/${identifier}/approve`, "POST", {
      approved: true,
    });
    const pending = await waitForAuditStep(identifier, "scheduled-execution");
    assert.equal(pending.effects.total, 0);
    assert.ok(Date.now() < target, "restart must begin before the deadline");
    const { state, port } = runtime;
    await runtime.close();
    runtime = await startRuntime({ state, port });
    // Local Miniflare does not restore timer wake-ups after process shutdown.
    // An unrelated event explicitly re-enters native replay; it is not approval.
    await request("/__fixture/event", "POST", {
      identifier,
      type: "local-recovery-wake-up",
      payload: {},
    });
    while (Date.now() < target - 200) {
      assert.equal(
        (await request(`/workflows/${identifier}/audit`)).effects.total,
        0,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = await waitFor(identifier, "WorkflowComplete");
    assert.ok(Date.now() >= target);
    assert.deepEqual(completed.output, {
      message: "durable timer",
      approved: true,
    });
    const audit = await request(`/workflows/${identifier}/audit`);
    assert.equal(audit.effects.total, 1);
    assert.equal(
      audit.attempts.filter((row) => row.step === "scheduled-execution").length,
      1,
    );
  },
);

test(
  "native event timeout fails without running the post-event step",
  { timeout: 15000 },
  async () => {
    const identifier = "event-timeout";
    await request("/__fixture/create", "POST", {
      identifier,
      parameters: { message: "timeout", behavior: "event-timeout" },
    });
    const failed = await waitFor(identifier, "WorkflowErrored");
    assert.ok(failed.error, "native timeout must propagate to Workflow status");
    const audit = await request(`/workflows/${identifier}/audit`);
    assert.deepEqual(
      audit.attempts.map((row) => row.step),
      ["fixture-await-event"],
    );
    assert.deepEqual(await request("/health"), { status: "ok" });
  },
);

test(
  "wrong event type does not satisfy the typed approval waiter",
  { timeout: 15000 },
  async () => {
    const identifier = "wrong-event-type";
    await request("/__fixture/create", "POST", {
      identifier,
      parameters: { message: "event", behavior: "event-payload" },
    });
    await waitForAuditStep(identifier, "fixture-await-event");
    await request("/__fixture/event", "POST", {
      identifier,
      type: "unrelated",
      payload: { approved: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      (await request(`/workflows/${identifier}/audit`)).attempts.length,
      1,
    );
    assert.equal((await request(`/workflows/${identifier}`)).output, null);
    await request("/__fixture/event", "POST", {
      identifier,
      type: "approval",
      payload: { approved: true },
    });
    const completed = await waitFor(identifier, "WorkflowComplete");
    assert.equal(completed.output.approved, true);
    assert.equal(completed.output.type, "approval");
    assert.ok(Number.isFinite(Date.parse(completed.output.timestamp)));
  },
);

test(
  "wrong approval payload fails decoding before the post-event step",
  { timeout: 15000 },
  async () => {
    const identifier = "wrong-event-payload";
    await request("/__fixture/create", "POST", {
      identifier,
      parameters: { message: "event", behavior: "event-payload" },
    });
    await waitForAuditStep(identifier, "fixture-await-event");
    await request("/__fixture/event", "POST", {
      identifier,
      type: "approval",
      payload: { approved: "not-a-boolean" },
    });
    const failed = await waitFor(identifier, "WorkflowErrored");
    assert.ok(failed.error);
    assert.equal(
      (await request(`/workflows/${identifier}/audit`)).attempts.length,
      1,
    );
    assert.deepEqual(await request("/health"), { status: "ok" });
  },
);

for (const backoff of ["constant", "linear", "exponential"]) {
  test(
    `native ${backoff} retry options preserve step context`,
    { timeout: 15000 },
    async () => {
      const identifier = `backoff-${backoff}`;
      await request("/__fixture/create", "POST", {
        identifier,
        parameters: { message: "retry", behavior: identifier },
      });
      const completed = await waitFor(identifier, "WorkflowComplete");
      assert.equal(completed.output.name, "fixture-backoff");
      assert.equal(completed.output.attempt, 2);
      assert.ok(Number.isInteger(completed.output.count));
      assert.deepEqual(
        (await request(`/workflows/${identifier}/audit`)).attempts.map(
          (row) => row.attempt,
        ),
        [1, 2],
      );
    },
  );
}

test(
  "platform-generated identifiers create independent one-off approval requests",
  { timeout: 20000 },
  async () => {
    const input = { message: "one-off report", behavior: "normal" };
    const first = await request("/workflows/generated", "POST", input);
    const second = await request("/workflows/generated", "POST", input);
    assert.equal(typeof first.identifier, "string");
    assert.ok(first.identifier.length > 0);
    assert.equal(typeof second.identifier, "string");
    assert.ok(second.identifier.length > 0);
    assert.notEqual(
      first.identifier,
      second.identifier,
      "repeated submissions must create separate jobs",
    );
    for (const { identifier } of [first, second]) {
      await waitForApproval(identifier);
      assert.equal(
        (await request(`/workflows/${identifier}/audit`)).effects.total,
        0,
      );
      await request(`/workflows/${identifier}/approve`, "POST", {
        approved: true,
      });
      const completed = await waitFor(identifier, "WorkflowComplete");
      assert.equal(completed.identifier, identifier);
      assert.deepEqual(completed.output, {
        message: input.message,
        approved: true,
      });
      assert.equal(
        (await request(`/workflows/${identifier}/audit`)).effects.total,
        1,
      );
    }
  },
);

test("generated-identifier requests validate the same business input", async () => {
  for (const input of [
    { message: "", behavior: "normal" },
    { message: "report", behavior: "unknown" },
    { message: "report", behavior: "normal", executeAt: "tomorrow" },
  ]) {
    const response = await fetch(runtime.base + "/workflows/generated", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 400, await response.text());
  }
});

for (const [scenario, state, reads] of [["paused", "WorkflowPaused", 2], ["delayed", "WorkflowPaused", 4], ["resumed", "WorkflowRunning", 2], ["terminated", "WorkflowTerminated", 2], ["restart", "WorkflowQueued", 2], ["success", "WorkflowRunning", 1]]) {
  test(`control status recovers without replaying the operation: ${scenario}`, async () => {
    const value = await request(`/__fixture/control?scenario=${scenario}`);
    assert.deepEqual(value.result, { ok: true, state });
    assert.equal(value.calls, 1);
    assert.equal(value.reads, reads);
  });
}
for (const scenario of ["persistent", "forbidden", "statusForbidden", "hanging"]) {
  test(`control status retains failures: ${scenario}`, { timeout: 10000 }, async () => {
    const value = await request(`/__fixture/control?scenario=${scenario}`);
    assert.equal(value.result.ok, false);
    assert.equal(value.result.message, ["forbidden", "statusForbidden"].includes(scenario) ? "Error: permission denied" : "Error: internal error");
    assert.equal(value.result.operation, scenario === "forbidden" ? "pause" : "status");
    assert.equal(value.calls, 1);
    if (scenario === "persistent") { assert.ok(value.reads >= 2 && value.reads <= 9); }
    else { assert.equal(value.reads, scenario === "forbidden" ? 0 : scenario === "hanging" ? 2 : 1); }
  });
}

test("malformed Workflow status is a parse failure without retries", async () => {
  const value = await request("/__fixture/control?scenario=malformed");
  assert.equal(value.result.ok, false);
  assert.equal(value.result.operation, "status");
  assert.match(value.result.message, /String|Text|string/);
  assert.equal(value.calls, 1);
  assert.equal(value.reads, 1);
});


test("concurrent Workflow invocations keep request I/O isolated", { timeout: 40000 }, async () => {
  const identifiers = ["isolated-a", "isolated-b", "isolated-c"];
  await Promise.all(identifiers.map(async (identifier) => {
    await request("/workflows", "POST", {
      identifier,
      parameters: { message: identifier, behavior: "normal" },
    });
    await waitForApproval(identifier);
    await request(`/workflows/${identifier}/approve`, "POST", { approved: true });
    const completed = await waitFor(identifier, "WorkflowComplete");
    assert.deepEqual(completed.output, { message: identifier, approved: true });
    const audit = await request(`/workflows/${identifier}/audit`);
    assert.equal(audit.effects.total, 1);
  }));
});

for (const [operation, path, method, body] of [
  ["get", "/workflows/unavailable", "GET", undefined],
  ["create", "/workflows", "POST", { identifier: "unavailable", parameters: { message: "probe", behavior: "normal" } }],
  ["create", "/workflows/generated", "POST", { message: "probe", behavior: "normal" }],
  ["get", "/workflows/unavailable/approve", "POST", { approved: true }],
  ["get", "/workflows/unavailable/control", "POST", "pause"],
]) {
  test(`application returns binding error details for ${method} ${path}`, async () => {
    const query = new URLSearchParams({ scenario: "binding-error", operation, path });
    const result = await request(`/__fixture/application?${query}`, method, body);
    assert.equal(result.status, 500);
    assert.match(result.body, new RegExp(`${operation}: .*fixture ${operation} unavailable`));
    assert.equal(result.calls, 1);
    assert.deepEqual(await request("/health"), { status: "ok" });
  });
}

test("unknown control is rejected before looking up a Workflow instance", async () => {
  const query = new URLSearchParams({ scenario: "binding-error", operation: "get", path: "/workflows/unavailable/control" });
  const result = await request(`/__fixture/application?${query}`, "POST", "unknown-operation");
  assert.equal(result.status, 400);
  assert.match(result.body, /unknown Workflow control operation/);
  assert.equal(result.calls, 0);
});

test("audit preserves a missing count row as null", async () => {
  const result = await request("/__fixture/application?scenario=empty-audit");
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { attempts: [], effects: null });
  assert.deepEqual((await request("/workflows/missing/audit")).effects, { step: null, attempt: null, total: 0 });
});

test("explicit-identifier creation rejects invalid business input before invoking the binding", async () => {
  const query = new URLSearchParams({ scenario: "binding-error", operation: "create", path: "/workflows" });
  for (const input of [
    { identifier: "", parameters: { message: "report", behavior: "normal" } },
    { identifier: "invalid-business", parameters: { message: "", behavior: "normal" } },
    { identifier: "invalid-business", parameters: { message: "report", behavior: "unknown" } },
  ]) {
    const result = await request(`/__fixture/application?${query}`, "POST", input);
    assert.equal(result.status, 400);
    assert.match(result.body, /identifier\/message required; behavior must be normal, retry or fail/);
    assert.equal(result.calls, 0);
  }
  assert.deepEqual(await request("/health"), { status: "ok" });
});
