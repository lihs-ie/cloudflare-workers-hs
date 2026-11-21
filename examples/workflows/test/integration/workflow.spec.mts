import {
  jsonArray,
  jsonNumber,
  jsonObject,
  jsonSequence,
  jsonString,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from '../Support/dev-runtime.mts';
let runtime: Awaited<ReturnType<typeof startRuntime>>;
void before(
  async () => {
    runtime = await startRuntime();
  },
  { timeout: 120000 },
);
void after(async () => {
  await runtime?.dispose();
});
async function request(path: string, method: string = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(runtime.base + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} ${path}: ${text}; ${runtime.logPath}`);
  return jsonValue(text);
}
async function waitFor(identifier: string, target: string): Promise<unknown> {
  const deadline = performance.now() + 25000;
  let current;
  while (performance.now() < deadline) {
    current = await request(`/workflows/${identifier}`);

    if (jsonObject(current).state === target) {
      return current;
    }

    if (jsonObject(current).state === 'WorkflowErrored') {
      assert.fail(`unexpected workflow failure ${JSON.stringify(current)}; ${runtime.logPath}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`workflow never reached ${target}: ${JSON.stringify(current)}; ${runtime.logPath}`);
}
async function waitForApproval(identifier: string, minimumCheckpoints: number = 1): Promise<void> {
  const deadline = performance.now() + 10000;
  let audit;
  while (performance.now() < deadline) {
    audit = await request(`/workflows/${identifier}/audit`);

    if (
      jsonArray(jsonObject(audit).attempts).filter(
        (row) => jsonObject(row).step === 'await-approval',
      ).length >= minimumCheckpoints
    ) {
      const status = await request(`/workflows/${identifier}`);
      assert.ok(
        ['WorkflowRunning', 'WorkflowWaiting'].includes(jsonString(jsonObject(status).state)),
      );
      assert.equal(jsonObject(status).output, null);
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = await request(`/workflows/${identifier}`);
  assert.fail(
    `workflow never reached approval checkpoint: ${JSON.stringify({
      identifier,
      minimumCheckpoints,
      status,
      audit,
    })}; ${runtime.evidence}/wrangler.log`,
  );
}
void test(
  'real Workflow waits for approval then retries without duplicating its side effect',
  { timeout: 40000 },
  async () => {
    await request('/workflows', 'POST', {
      identifier: 'retry-approval',
      parameters: { message: 'publish report', behavior: 'retry' },
    });
    await waitForApproval('retry-approval');
    const before = await request('/workflows/retry-approval/audit');
    assert.equal(jsonObject(jsonObject(before).effects).total, 0);
    assert.deepEqual(
      jsonArray(jsonObject(before).attempts).map((item) => {
        const { step, attempt } = jsonObject(item);
        return [step, attempt];
      }),
      [
        ['prepare-request', 1],
        ['await-approval', 1],
      ],
    );
    await request('/workflows/retry-approval/approve', 'POST', {
      approved: true,
    });
    const completed = await waitFor('retry-approval', 'WorkflowComplete');
    assert.deepEqual(jsonObject(completed).output, {
      message: 'publish report',
      approved: true,
    });
    const after = await request('/workflows/retry-approval/audit');
    assert.deepEqual(
      jsonArray(jsonObject(after).attempts)
        .filter((row) => jsonObject(row).step === 'commit-request')
        .map((row) => jsonObject(row).attempt),
      [1, 2, 3],
    );
    assert.equal(jsonObject(jsonObject(after).effects).total, 1);
    assert.equal(
      jsonArray(jsonObject(after).attempts).filter(
        (row) => jsonObject(row).step === 'finish-request',
      ).length,
      1,
    );
  },
);
void test(
  'real NonRetryableError prevents native Workflow retries',
  { timeout: 15000 },
  async () => {
    await request('/workflows', 'POST', {
      identifier: 'permanent-failure',
      parameters: { message: 'invalid report', behavior: 'fail' },
    });
    await waitForApproval('permanent-failure');
    await request('/workflows/permanent-failure/approve', 'POST', {
      approved: true,
    });
    const failed = await waitFor('permanent-failure', 'WorkflowErrored');
    assert.match(jsonString(jsonObject(failed).error), /NonRetryableError/);
    const audit = await request('/workflows/permanent-failure/audit');
    assert.equal(jsonObject(jsonObject(audit).effects).total, 0);
    assert.deepEqual(
      jsonArray(jsonObject(audit).attempts).map((item) => {
        const { step, attempt } = jsonObject(item);
        return [step, attempt];
      }),
      [
        ['prepare-request', 1],
        ['await-approval', 1],
        ['commit-request', 1],
      ],
    );
  },
);
void test(
  'completed steps remain durable across actual wrangler process restart',
  { timeout: 60000 },
  async () => {
    await request('/workflows', 'POST', {
      identifier: 'restart-approval',
      parameters: { message: 'survive restart', behavior: 'normal' },
    });
    await waitForApproval('restart-approval');
    const before = await request('/workflows/restart-approval/audit');
    const { state, port } = runtime;
    await runtime.close();
    runtime = await startRuntime({ state, port });
    await request('/workflows/restart-approval/approve', 'POST', {
      approved: false,
    });
    const completed = await waitFor('restart-approval', 'WorkflowComplete');
    assert.deepEqual(jsonObject(completed).output, {
      message: 'survive restart',
      approved: false,
    });
    const after = await request('/workflows/restart-approval/audit');
    assert.deepEqual(
      jsonArray(jsonObject(after).attempts).filter((row) =>
        ['prepare-request', 'await-approval'].includes(jsonString(jsonObject(row).step)),
      ),
      jsonObject(before).attempts,
    );
    assert.equal(jsonObject(jsonObject(after).effects).total, 1);
  },
);

for (const behavior of ['timeout', 'lazy-output', 'lazy-step', 'unsafe-integer']) {
  void test(`Workflow safely contains ${behavior}`, { timeout: 15000 }, async () => {
    const identifier = `fixture-${behavior}`;
    await request('/__fixture/create', 'POST', {
      identifier,
      parameters: { message: 'fixture', behavior },
    });
    const failed = await waitFor(identifier, 'WorkflowErrored');

    if (behavior === 'timeout') {
      assert.match(jsonString(jsonObject(failed).error), /time|Timeout/i);
      const audit = await request(`/workflows/${identifier}/audit`);
      assert.deepEqual(
        jsonArray(jsonObject(audit).attempts)
          .filter((row) => jsonObject(row).step === 'hung-callback')
          .map((row) => jsonObject(row).attempt),
        [1, 2],
      );
      assert.deepEqual(
        jsonArray(jsonObject(audit).attempts)
          .filter((row) => jsonObject(row).step === 'cancelled-callback')
          .map((row) => jsonObject(row).attempt),
        [1, 2],
      );
    } else if (behavior === 'unsafe-integer') {
      assert.match(jsonString(jsonObject(failed).error), /NonRetryableError|safe integer/);
    } else {
      assert.match(jsonString(jsonObject(failed).error), /lazy .* output failure/);
    }
    assert.deepEqual(
      await request('/health'),
      { status: 'ok' },
      'WASM remains usable after the contained failure',
    );
  });
}

void test(
  'Workflow lifecycle control pauses, resumes, terminates and restarts',
  { timeout: 20000 },
  async () => {
    const identifier = 'controlled-approval';
    await request('/workflows', 'POST', {
      identifier,
      parameters: { message: 'controlled', behavior: 'normal' },
    });
    await waitForApproval(identifier);
    await request(`/workflows/${identifier}/control`, 'POST', 'pause');
    await waitFor(identifier, 'WorkflowPaused');
    await request(`/workflows/${identifier}/control`, 'POST', 'resume');
    await request(`/workflows/${identifier}/control`, 'POST', 'terminate');
    await waitFor(identifier, 'WorkflowTerminated');
    assert.deepEqual(await request(`/workflows/${identifier}/control`, 'POST', 'restart'), {
      accepted: true,
      identifier,
      operation: 'restart',
    });
    await waitForApproval(identifier, 2);
    await request(`/workflows/${identifier}/approve`, 'POST', {
      approved: true,
    });
    await waitFor(identifier, 'WorkflowComplete');
    const response = await fetch(runtime.base + '/workflows/missing-instance/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify('terminate'),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /instance|Workflow|not/i);
  },
);

void test('UTC execution dates reject malformed and non-UTC input', async () => {
  for (const executeAt of [
    'tomorrow',
    '2026-02-30T12:00:00Z',
    '2026-09-08T12:00:00+09:00',
    '2026-09-08',
    123,
  ]) {
    const response = await fetch(runtime.base + '/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'invalid-date',
        parameters: { message: 'scheduled', behavior: 'normal', executeAt },
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

void test(
  'past UTC execution still requires approval and then finishes immediately',
  { timeout: 15000 },
  async () => {
    const identifier = 'past-execution';
    await request('/workflows', 'POST', {
      identifier,
      parameters: {
        message: 'past',
        behavior: 'normal',
        executeAt: '2000-01-01T00:00:00Z',
      },
    });
    await waitForApproval(identifier);
    assert.equal(
      jsonArray(jsonObject(await request(`/workflows/${identifier}/audit`)).attempts).some(
        (row) => jsonObject(row).step === 'finish-request',
      ),
      false,
    );
    await request(`/workflows/${identifier}/approve`, 'POST', {
      approved: true,
    });
    assert.deepEqual(jsonObject(await waitFor(identifier, 'WorkflowComplete')).output, {
      message: 'past',
      approved: true,
    });
    const audit = await request(`/workflows/${identifier}/audit`);
    assert.equal(
      jsonArray(jsonObject(audit).attempts).some(
        (row) => jsonObject(row).step === 'scheduled-execution',
      ),
      false,
    );
    assert.equal(jsonObject(jsonObject(audit).effects).total, 1);
  },
);

void test(
  'approved Workflow finishes no earlier than its UTC execution date',
  { timeout: 20000 },
  async () => {
    const identifier = 'future-execution';
    const target = Date.now() + 6000;
    await request('/workflows', 'POST', {
      identifier,
      parameters: {
        message: 'future',
        behavior: 'normal',
        executeAt: new Date(target).toISOString(),
      },
    });
    await waitForApproval(identifier);
    assert.ok(Date.now() < target, 'approval checkpoint must precede scheduled time');
    await request(`/workflows/${identifier}/approve`, 'POST', {
      approved: true,
    });
    while (Date.now() < target - 200) {
      const audit = await request(`/workflows/${identifier}/audit`);
      assert.equal(
        jsonArray(jsonObject(audit).attempts).some(
          (row) => jsonObject(row).step === 'finish-request',
        ),
        false,
      );
      assert.equal(
        jsonObject(jsonObject(audit).effects).total,
        0,
        'scheduled business write must wait too',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = await waitFor(identifier, 'WorkflowComplete');
    assert.ok(Date.now() >= target);
    assert.deepEqual(jsonObject(completed).output, { message: 'future', approved: true });
  },
);

async function waitForAuditStep(identifier: string, name: string): Promise<unknown> {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const audit = await request(`/workflows/${identifier}/audit`);

    if (jsonArray(jsonObject(audit).attempts).some((row) => jsonObject(row).step === name)) {
      return audit;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`missing checkpoint ${name}; ${runtime.logPath}`);
}

void test(
  'explicit event wake-up after process restart replays the UTC execution gate',
  { timeout: 60000 },
  async () => {
    const identifier = 'scheduled-process-restart';
    const target = Date.now() + 10000;
    await request('/workflows', 'POST', {
      identifier,
      parameters: {
        message: 'durable timer',
        behavior: 'normal',
        executeAt: new Date(target).toISOString(),
      },
    });
    await waitForApproval(identifier);
    await request(`/workflows/${identifier}/approve`, 'POST', {
      approved: true,
    });
    const pending = await waitForAuditStep(identifier, 'scheduled-execution');
    assert.equal(jsonObject(jsonObject(pending).effects).total, 0);
    assert.ok(Date.now() < target, 'restart must begin before the deadline');
    const { state, port } = runtime;
    await runtime.close();
    runtime = await startRuntime({ state, port });
    // Local Miniflare does not restore timer wake-ups after process shutdown.
    // An unrelated event explicitly re-enters native replay; it is not approval.
    await request('/__fixture/event', 'POST', {
      identifier,
      type: 'local-recovery-wake-up',
      payload: {},
    });
    while (Date.now() < target - 200) {
      assert.equal(
        jsonObject(jsonObject(await request(`/workflows/${identifier}/audit`)).effects).total,
        0,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const completed = await waitFor(identifier, 'WorkflowComplete');
    assert.ok(Date.now() >= target);
    assert.deepEqual(jsonObject(completed).output, {
      message: 'durable timer',
      approved: true,
    });
    const audit = await request(`/workflows/${identifier}/audit`);
    assert.equal(jsonObject(jsonObject(audit).effects).total, 1);
    assert.equal(
      jsonArray(jsonObject(audit).attempts).filter(
        (row) => jsonObject(row).step === 'scheduled-execution',
      ).length,
      1,
    );
  },
);

void test(
  'native event timeout fails without running the post-event step',
  { timeout: 15000 },
  async () => {
    const identifier = 'event-timeout';
    await request('/__fixture/create', 'POST', {
      identifier,
      parameters: { message: 'timeout', behavior: 'event-timeout' },
    });
    const failed = await waitFor(identifier, 'WorkflowErrored');
    assert.ok(jsonObject(failed).error, 'native timeout must propagate to Workflow status');
    const audit = await request(`/workflows/${identifier}/audit`);
    assert.deepEqual(
      jsonArray(jsonObject(audit).attempts).map((row) => jsonObject(row).step),
      ['fixture-await-event'],
    );
    assert.deepEqual(await request('/health'), { status: 'ok' });
  },
);

void test(
  'wrong event type does not satisfy the typed approval waiter',
  { timeout: 15000 },
  async () => {
    const identifier = 'wrong-event-type';
    await request('/__fixture/create', 'POST', {
      identifier,
      parameters: { message: 'event', behavior: 'event-payload' },
    });
    await waitForAuditStep(identifier, 'fixture-await-event');
    await request('/__fixture/event', 'POST', {
      identifier,
      type: 'unrelated',
      payload: { approved: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      jsonSequence(jsonObject(await request(`/workflows/${identifier}/audit`)).attempts).length,
      1,
    );
    assert.equal(jsonObject(await request(`/workflows/${identifier}`)).output, null);
    await request('/__fixture/event', 'POST', {
      identifier,
      type: 'approval',
      payload: { approved: true },
    });
    const completed = await waitFor(identifier, 'WorkflowComplete');
    assert.equal(jsonObject(jsonObject(completed).output).approved, true);
    assert.equal(jsonObject(jsonObject(completed).output).type, 'approval');
    assert.ok(
      Number.isFinite(Date.parse(jsonString(jsonObject(jsonObject(completed).output).timestamp))),
    );
  },
);

void test(
  'wrong approval payload fails decoding before the post-event step',
  { timeout: 15000 },
  async () => {
    const identifier = 'wrong-event-payload';
    await request('/__fixture/create', 'POST', {
      identifier,
      parameters: { message: 'event', behavior: 'event-payload' },
    });
    await waitForAuditStep(identifier, 'fixture-await-event');
    await request('/__fixture/event', 'POST', {
      identifier,
      type: 'approval',
      payload: { approved: 'not-a-boolean' },
    });
    const failed = await waitFor(identifier, 'WorkflowErrored');
    assert.ok(jsonObject(failed).error);
    assert.equal(
      jsonSequence(jsonObject(await request(`/workflows/${identifier}/audit`)).attempts).length,
      1,
    );
    assert.deepEqual(await request('/health'), { status: 'ok' });
  },
);

for (const backoff of ['constant', 'linear', 'exponential']) {
  void test(
    `native ${backoff} retry options preserve step context`,
    { timeout: 15000 },
    async () => {
      const identifier = `backoff-${backoff}`;
      await request('/__fixture/create', 'POST', {
        identifier,
        parameters: { message: 'retry', behavior: identifier },
      });
      const completed = await waitFor(identifier, 'WorkflowComplete');
      assert.equal(jsonObject(jsonObject(completed).output).name, 'fixture-backoff');
      assert.equal(jsonObject(jsonObject(completed).output).attempt, 2);
      assert.ok(Number.isInteger(jsonObject(jsonObject(completed).output).count));
      assert.deepEqual(
        jsonArray(jsonObject(await request(`/workflows/${identifier}/audit`)).attempts).map(
          (row) => jsonObject(row).attempt,
        ),
        [1, 2],
      );
    },
  );
}

void test(
  'platform-generated identifiers create independent one-off approval requests',
  { timeout: 20000 },
  async () => {
    const input = { message: 'one-off report', behavior: 'normal' };
    const first = await request('/workflows/generated', 'POST', input);
    const second = await request('/workflows/generated', 'POST', input);
    assert.equal(typeof jsonObject(first).identifier, 'string');
    assert.ok(jsonSequence(jsonObject(first).identifier).length > 0);
    assert.equal(typeof jsonObject(second).identifier, 'string');
    assert.ok(jsonSequence(jsonObject(second).identifier).length > 0);
    assert.notEqual(
      jsonObject(first).identifier,
      jsonObject(second).identifier,
      'repeated submissions must create separate jobs',
    );
    for (const item of [first, second]) {
      const identifier = jsonString(jsonObject(item).identifier);
      await waitForApproval(identifier);
      assert.equal(
        jsonObject(jsonObject(await request(`/workflows/${identifier}/audit`)).effects).total,
        0,
      );
      await request(`/workflows/${identifier}/approve`, 'POST', {
        approved: true,
      });
      const completed = await waitFor(identifier, 'WorkflowComplete');
      assert.equal(jsonObject(completed).identifier, identifier);
      assert.deepEqual(jsonObject(completed).output, {
        message: input.message,
        approved: true,
      });
      assert.equal(
        jsonObject(jsonObject(await request(`/workflows/${identifier}/audit`)).effects).total,
        1,
      );
    }
  },
);

void test('generated-identifier requests validate the same business input', async () => {
  for (const input of [
    { message: '', behavior: 'normal' },
    { message: 'report', behavior: 'unknown' },
    { message: 'report', behavior: 'normal', executeAt: 'tomorrow' },
  ]) {
    const response = await fetch(runtime.base + '/workflows/generated', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 400, await response.text());
  }
});

for (const [scenario, state, reads] of [
  ['paused', 'WorkflowPaused', 2],
  ['delayed', 'WorkflowPaused', 4],
  ['resumed', 'WorkflowRunning', 2],
  ['terminated', 'WorkflowTerminated', 2],
  ['restart', 'WorkflowQueued', 2],
  ['success', 'WorkflowRunning', 1],
] as const) {
  void test(`control status recovers without replaying the operation: ${scenario}`, async () => {
    const value = await request(`/__fixture/control?scenario=${scenario}`);
    assert.deepEqual(jsonObject(value).result, { ok: true, state });
    assert.equal(jsonObject(value).calls, 1);
    assert.equal(jsonObject(value).reads, reads);
  });
}
for (const scenario of ['persistent', 'forbidden', 'statusForbidden', 'hanging']) {
  void test(`control status retains failures: ${scenario}`, { timeout: 10000 }, async () => {
    const value = await request(`/__fixture/control?scenario=${scenario}`);
    assert.equal(jsonObject(jsonObject(value).result).ok, false);
    assert.equal(
      jsonObject(jsonObject(value).result).message,
      ['forbidden', 'statusForbidden'].includes(scenario)
        ? 'Error: permission denied'
        : 'Error: internal error',
    );
    assert.equal(
      jsonObject(jsonObject(value).result).operation,
      scenario === 'forbidden' ? 'pause' : 'status',
    );
    assert.equal(jsonObject(value).calls, 1);

    if (scenario === 'persistent') {
      assert.ok(
        jsonNumber(jsonObject(value).reads) >= 2 && jsonNumber(jsonObject(value).reads) <= 9,
      );
    } else {
      assert.equal(
        jsonObject(value).reads,
        (() => {
          if (scenario === 'forbidden') {
            return 0;
          }

          if (scenario === 'hanging') {
            return 2;
          }

          return 1;
        })(),
      );
    }
  });
}

void test('malformed Workflow status is a parse failure without retries', async () => {
  const value = await request('/__fixture/control?scenario=malformed');
  assert.equal(jsonObject(jsonObject(value).result).ok, false);
  assert.equal(jsonObject(jsonObject(value).result).operation, 'status');
  assert.match(jsonString(jsonObject(jsonObject(value).result).message), /String|Text|string/);
  assert.equal(jsonObject(value).calls, 1);
  assert.equal(jsonObject(value).reads, 1);
});

void test(
  'concurrent Workflow invocations keep request I/O isolated',
  { timeout: 40000 },
  async () => {
    const identifiers = ['isolated-a', 'isolated-b', 'isolated-c'];
    await Promise.all(
      identifiers.map(async (identifier) => {
        await request('/workflows', 'POST', {
          identifier,
          parameters: { message: identifier, behavior: 'normal' },
        });
        await waitForApproval(identifier);
        await request(`/workflows/${identifier}/approve`, 'POST', { approved: true });
        const completed = await waitFor(identifier, 'WorkflowComplete');
        assert.deepEqual(jsonObject(completed).output, { message: identifier, approved: true });
        const audit = await request(`/workflows/${identifier}/audit`);
        assert.equal(jsonObject(jsonObject(audit).effects).total, 1);
      }),
    );
  },
);

for (const [operation, path, method, body] of [
  ['get', '/workflows/unavailable', 'GET', undefined],
  [
    'create',
    '/workflows',
    'POST',
    { identifier: 'unavailable', parameters: { message: 'probe', behavior: 'normal' } },
  ],
  ['create', '/workflows/generated', 'POST', { message: 'probe', behavior: 'normal' }],
  ['get', '/workflows/unavailable/approve', 'POST', { approved: true }],
  ['get', '/workflows/unavailable/control', 'POST', 'pause'],
] as const) {
  void test(`application returns binding error details for ${method} ${path}`, async () => {
    const query = new URLSearchParams({ scenario: 'binding-error', operation, path });
    const result = await request(`/__fixture/application?${query}`, method, body);
    assert.equal(jsonObject(result).status, 500);
    assert.match(
      jsonString(jsonObject(result).body),
      new RegExp(`${operation}: .*fixture ${operation} unavailable`),
    );
    assert.equal(jsonObject(result).calls, 1);
    assert.deepEqual(await request('/health'), { status: 'ok' });
  });
}

void test('unknown control is rejected before looking up a Workflow instance', async () => {
  const query = new URLSearchParams({
    scenario: 'binding-error',
    operation: 'get',
    path: '/workflows/unavailable/control',
  });
  const result = await request(`/__fixture/application?${query}`, 'POST', 'unknown-operation');
  assert.equal(jsonObject(result).status, 400);
  assert.match(jsonString(jsonObject(result).body), /unknown Workflow control operation/);
  assert.equal(jsonObject(result).calls, 0);
});

void test('audit preserves a missing count row as null', async () => {
  const result = await request('/__fixture/application?scenario=empty-audit');
  assert.equal(jsonObject(result).status, 200);
  assert.deepEqual(jsonValue(jsonObject(result).body), { attempts: [], effects: null });
  assert.deepEqual(jsonObject(await request('/workflows/missing/audit')).effects, {
    step: null,
    attempt: null,
    total: 0,
  });
});

void test('explicit-identifier creation rejects invalid business input before invoking the binding', async () => {
  const query = new URLSearchParams({
    scenario: 'binding-error',
    operation: 'create',
    path: '/workflows',
  });
  for (const input of [
    { identifier: '', parameters: { message: 'report', behavior: 'normal' } },
    { identifier: 'invalid-business', parameters: { message: '', behavior: 'normal' } },
    { identifier: 'invalid-business', parameters: { message: 'report', behavior: 'unknown' } },
  ]) {
    const result = await request(`/__fixture/application?${query}`, 'POST', input);
    assert.equal(jsonObject(result).status, 400);
    assert.match(
      jsonString(jsonObject(result).body),
      /identifier\/message required; behavior must be normal, retry or fail/,
    );
    assert.equal(jsonObject(result).calls, 0);
  }
  assert.deepEqual(await request('/health'), { status: 'ok' });
});
