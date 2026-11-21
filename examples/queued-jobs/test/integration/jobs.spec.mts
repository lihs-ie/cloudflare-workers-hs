import { jsonArray, jsonNumber, jsonObject } from '../../../../scripts/testing/Support/json.mts';
import { poll } from '../../../../scripts/testing/Support/polling.mts';
import { registerJobsFailureCases } from './jobs-failures.cases.mts';
import { registerQueueContractCases } from './queue-contracts.cases.mts';
import { registerQueueProducerCases } from './queue-producers.cases.mts';
import { registerQueueCases } from './queue.cases.mts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startRuntime } from '../Support/dev-runtime.mts';

let runtime: Awaited<ReturnType<typeof startRuntime>>;
void before(
  async () => {
    runtime = await startRuntime();
  },
  { timeout: 125000 },
);
void after(async () => {
  await runtime?.close();
});

async function submit(jobs: { identifier: string; payload: string }[]): Promise<Response> {
  return fetch(`${runtime.base}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobs }),
    signal: AbortSignal.timeout(15000),
  });
}
async function state(identifier: string): Promise<Response> {
  return fetch(`${runtime.base}/jobs/${identifier}`, {
    signal: AbortSignal.timeout(10000),
  });
}
async function completed(identifier: string): Promise<unknown> {
  const response = await poll({
    observe: () => state(identifier),
    complete: (response) => response.ok,
    timeout: 30000,
    async wait(milliseconds: number): Promise<void> {
      await delay(milliseconds);
    },
    diagnostic: () => `Job ${identifier} did not complete`,
  });
  return response.json();
}

async function assertRequestLogs(
  identifier: string,
  pathname: string,
  status: number,
): Promise<void> {
  const field = (name: string): RegExp => new RegExp(`["']?${name}["']?:\\s*["']([^"']*)["']`);
  const requestIdentifier = field('request_id');
  const path = field('path');
  const message = field('message');
  const responseStatus = new RegExp(`["']?status["']?:\\s*${status}\\b`);

  await poll({
    observe: () => Promise.resolve(runtime.logs().match(/\{[^{}]*\}/g) ?? []),
    complete: (records) => {
      const request = records.filter(
        (record) =>
          requestIdentifier.exec(record)?.[1] === identifier && path.exec(record)?.[1] === pathname,
      );
      return (
        request.some((record) => message.exec(record)?.[1] === 'request started') &&
        request.some(
          (record) =>
            message.exec(record)?.[1] === 'request completed' && responseStatus.test(record),
        )
      );
    },
    timeout: 5000,
    diagnostic: () => `Missing structured request logs for ${identifier}`,
  });
}

void test('job HTTP responses use the Cloudflare request identifier in the header and logs', async () => {
  const pathname = '/health';
  const identifier = 'queued-jobs-ray-probe';
  const response = await fetch(runtime.base + pathname, {
    headers: { 'cf-ray': identifier, 'x-hs-request-id': 'caller-supplied' },
  });
  await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-identifier'), identifier);
  await assertRequestLogs(identifier, pathname, 200);
});

void test('job HTTP responses generate a request identifier when the Cloudflare header is absent', async () => {
  const pathname = '/missing-observability-probe';
  const response = await fetch(runtime.base + pathname);
  const identifier = response.headers.get('x-request-identifier');
  await response.text();

  assert.equal(response.status, 404);
  assert.ok(identifier);
  assert.match(
    identifier,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  await assertRequestLogs(identifier, pathname, 404);
});

void test(
  'batch RPC validation, D1 decoding, Queue delivery and DO RPC persist jobs',
  { timeout: 45000 },
  async () => {
    const jobs = [
      { identifier: 'batch-first', payload: 'first work item' },
      { identifier: 'batch-second', payload: 'second work item' },
    ];
    const response = await submit(jobs);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), {
      accepted: 2,
      settings: { score: 0.75, description: null, attachmentBytes: 3 },
    });
    for (const job of jobs) {
      assert.deepEqual(await completed(job.identifier), { ...job, updates: 1 });
    }
    // A new Queue delivery with the same application identifier must not reapply.
    const duplicate = await submit(jobs);
    assert.equal(duplicate.status, 200, await duplicate.text());
    await delay(2500);
    for (const job of jobs) {
      const saved = await state(job.identifier);
      assert.deepEqual(await saved.json(), { ...job, updates: 1 });
    }
  },
);

void test('invalid batches fail before Queue writes', async () => {
  for (const jobs of [
    [],
    [{ identifier: 'bad space', payload: 'x' }],
    [
      { identifier: 'repeat', payload: 'x' },
      { identifier: 'repeat', payload: 'y' },
    ],
    [{ identifier: 'empty', payload: '' }],
    Array.from({ length: 26 }, (_, index) => ({
      identifier: `large-${index}`,
      payload: 'x',
    })),
  ]) {
    const response = await submit(jobs);
    assert.equal(response.status, 400, await response.text());
  }
  const missing = await state('repeat');
  assert.equal(missing.status, 404);
});

void test('malformed job schemas fail before producing Queue messages', async () => {
  for (const body of [
    null,
    [],
    {},
    { jobs: null },
    { jobs: [{}] },
    { jobs: [{ identifier: 7, payload: 'work' }] },
    { jobs: [{ identifier: 'missing-payload' }] },
    { jobs: [{ identifier: 'null-payload', payload: null }] },
  ]) {
    const response = await fetch(`${runtime.base}/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal(response.headers.get('X-Fixture-Queue-Producer-Calls'), '0');
    await response.arrayBuffer();
  }
});

void test('settings updates retain only the latest three ordered revisions', async () => {
  const revisions = [];
  for (let revision = 1; revision <= 5; revision += 1) {
    const response = await fetch(`${runtime.base}/jobs/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: `configuration ${revision}` }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const saved = await response.json();
    revisions.push(jsonObject(saved).revision);
    assert.deepEqual(jsonObject(saved).settings, {
      description: `configuration ${revision}`,
    });
  }
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
  const response = await fetch(`${runtime.base}/jobs/settings/history`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    await response.json(),
    [5, 4, 3].map((revision) => ({
      revision,
      settings: { description: `configuration ${revision}` },
    })),
  );
});

void test(
  'a failed DO RPC is retried and acknowledged only after persistence',
  { timeout: 45000 },
  async () => {
    const job = {
      identifier: 'retry-once',
      payload: 'persist after transient failure',
    };
    const response = await submit([job]);
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(await completed(job.identifier), { ...job, updates: 1 });
  },
);

void test('concurrent settings updates preserve every revision and retain the latest three', async () => {
  const beforeResponse = await fetch(`${runtime.base}/jobs/settings/history`);
  assert.equal(beforeResponse.status, 200);
  const before = await beforeResponse.json();
  const previousRevision = jsonObject(jsonArray(before)[0])?.revision ?? 0;
  const saved = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const response = await fetch(`${runtime.base}/jobs/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          description: `concurrent configuration ${index}`,
        }),
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json();
      assert.deepEqual(jsonObject(result).settings, {
        description: `concurrent configuration ${index}`,
      });
      return result;
    }),
  );
  saved.sort(
    (left, right) => jsonNumber(jsonObject(left).revision) - jsonNumber(jsonObject(right).revision),
  );
  assert.deepEqual(
    saved.map((item) => {
      const { revision } = jsonObject(item);
      return revision;
    }),
    Array.from({ length: 8 }, (_, index) => jsonNumber(previousRevision) + index + 1),
  );
  const response = await fetch(`${runtime.base}/jobs/settings/history`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), saved.slice(-3).reverse());
});

void test(
  'Queue retries a lost RPC response after commit without duplicating the SQL effect',
  { timeout: 45000 },
  async () => {
    const job = {
      identifier: 'commit-response-lost',
      payload: 'commit survives lost response',
    };
    const response = await submit([job]);
    assert.equal(response.status, 200, await response.text());
    const deadline = Date.now() + 30000;
    let last;
    while (Date.now() < deadline) {
      const saved = await state(job.identifier);

      if (saved.status === 404) {
        await delay(100);
        continue;
      }

      assert.equal(saved.status, 200, await saved.clone().text());
      last = await saved.json();
      assert.equal(jsonObject(last).updates, 1, 'the committed SQL effect must never repeat');

      if (
        Number.isSafeInteger(jsonObject(last).attempts) &&
        jsonNumber(jsonObject(last).attempts) >= 2
      ) {
        assert.deepEqual(last, { ...job, updates: 1, attempts: jsonObject(last).attempts });
        return;
      }

      await delay(100);
    }
    assert.fail(`No native Queue redelivery observed: ${JSON.stringify(last)}`);
  },
);

async function configureSettings(scenario: string): Promise<void> {
  const response = await fetch(`${runtime.base}/__fixture/jobs/settings/${scenario}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 204, await response.text());
}

void test(
  'invalid native D1 settings never call Queue and restored settings allow the same job',
  { timeout: 120000 },
  async () => {
    const cases = [
      ['enabled-invalid', 500],
      ['limit-invalid', 500],
      ['limit-zero', 500],
      ['score-negative', 500],
      ['missing', 404],
      ['score-invalid', 500],
      ['blob-invalid', 500],
      ['disabled', 409],
    ] as const;
    for (const [scenario, status] of cases) {
      const job = {
        identifier: `settings-${scenario}`,
        payload: 'only after repair',
      };
      try {
        await configureSettings(scenario);
        const rejected = await submit([job]);
        assert.equal(rejected.status, status, await rejected.clone().text());
        assert.equal(rejected.headers.get('X-Fixture-Queue-Producer-Calls'), '0');
        const absent = await state(job.identifier);
        assert.equal(absent.status, 404, await absent.text());
      } finally {
        await configureSettings('restore');
      }
      const accepted = await submit([job]);
      assert.equal(accepted.status, 200, await accepted.clone().text());
      assert.equal(accepted.headers.get('X-Fixture-Queue-Producer-Calls'), '1');
      assert.deepEqual(await completed(job.identifier), { ...job, updates: 1 });
    }
  },
);

registerQueueCases(() => runtime);

registerQueueProducerCases(() => runtime);

registerQueueContractCases(() => runtime);

registerJobsFailureCases(() => runtime);

void test('legacy exported job processor rejects malformed JSON and persists valid jobs', async () => {
  const job = { identifier: 'exported-process-job', payload: 'direct exported processor' };
  for (const body of ['{invalid-json', 'null']) {
    const response = await fetch(`${runtime.base}/__fixture/process-job`, { method: 'POST', body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { processed: false });
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${runtime.base}/__fixture/process-job`, {
      method: 'POST',
      body: JSON.stringify(job),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { processed: true });
    assert.deepEqual(await completed(job.identifier), { ...job, updates: 1 });
  }
});

void test('native settings description is decoded and returned with accepted jobs', async () => {
  const job = { identifier: 'settings-description', payload: 'description consumer' };
  try {
    await configureSettings('description-present');
    const response = await submit([job]);
    assert.equal(response.status, 200);
    assert.deepEqual(jsonObject(await response.json()).settings, {
      score: 0.75,
      description: 'native description 日本語',
      attachmentBytes: 3,
    });
    assert.deepEqual(await completed(job.identifier), { ...job, updates: 1 });
  } finally {
    await configureSettings('restore');
  }
});

void test('validator RPC failure never dispatches Queue and the next submission succeeds', async () => {
  const job = { identifier: 'validator-recovery', payload: 'after RPC recovery' };
  const identifier = 'queued-jobs-validator-failure';
  const failed = await fetch(`${runtime.base}/jobs?fixture=validator-failure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-ray': identifier },
    body: JSON.stringify({ jobs: [job] }),
  });

  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('x-request-identifier'), identifier);
  assert.equal(failed.headers.get('X-Fixture-Queue-Producer-Calls'), '0');
  assert.deepEqual(await failed.json(), { error: 'internal_error' });
  await assertRequestLogs(identifier, '/jobs', 500);

  const accepted = await submit([job]);
  assert.equal(accepted.status, 200, await accepted.text());
  assert.deepEqual(await completed(job.identifier), { ...job, updates: 1 });
});
