import { jsonArray, jsonObject, jsonSequence } from '../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  callTestMethod,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const request = (path: string, options?: RequestInit): Request<unknown, CfProperties<unknown>> =>
  new Request('https://fixture.test' + path, options);
import { changeJobSettings, observeJobSubmission } from './jobs-settings.ts';
void test('settings fixture rejects unknown cases and propagates database failures', async () => {
  const statements: string[] = [];
  const database = {
    prepare(sql: string): { run(): Promise<void> } {
      statements.push(sql);
      return { async run(): Promise<void> {} };
    },
  };
  assert.equal(
    jsonObject(await callTestBoundary(changeJobSettings, database, 'unknown')).status,
    400,
  );
  assert.equal(statements.length, 0);
  const expected = [
    'enabled=2',
    'enabled=0',
    'batch_limit=101',
    'score=1.25',
    "attachment='not a blob'",
    'enabled=1,batch_limit=25',
  ];
  for (const [index, scenario] of [
    'enabled-invalid',
    'disabled',
    'limit-invalid',
    'score-invalid',
    'blob-invalid',
    'restore',
  ].entries()) {
    assert.equal(
      jsonObject(await callTestBoundary(changeJobSettings, database, scenario)).status,
      204,
    );
    assert.ok(statements[index].includes(expected[index]));
  }
  const failure = new Error('database unavailable');
  await assert.rejects(
    Promise.resolve(
      callTestBoundary(
        changeJobSettings,
        {
          prepare(): { run(): Promise<never> } {
            return {
              async run(): Promise<never> {
                throw failure;
              },
            };
          },
        },
        'restore',
      ),
    ),
    (error) => error === failure,
  );
});

void test('submission observation forwards arguments and counts producers but not metrics', async () => {
  const calls: unknown[][] = [];
  const queue = {
    async metrics(): Promise<number> {
      jsonArray(calls).push(['metrics']);
      return 7;
    },
    async send(...args: unknown[]): Promise<string> {
      jsonArray(calls).push(['send', ...args]);
      return 'sent';
    },
    async sendBatch(...args: unknown[]): Promise<string> {
      jsonArray(calls).push(['batch', ...args]);
      return 'batched';
    },
  };
  const input = request('/', { method: 'POST', body: 'input' });
  const context = {};
  const result = await callTestBoundary(
    observeJobSubmission,
    input,
    { JOBS_QUEUE: queue },
    context,
    async (
      received: unknown,
      env: {
        JOBS_QUEUE: {
          metrics: () => unknown;
          send: (arg0: string, arg1: { delaySeconds: number }) => unknown;
          sendBatch: (arg0: string[], arg1: { delaySeconds: number }) => unknown;
        };
      },
      ctx: unknown,
    ) => {
      assert.equal(received, input);
      assert.equal(ctx, context);
      assert.equal(await env.JOBS_QUEUE.metrics(), 7);
      assert.equal(await env.JOBS_QUEUE.send('a', { delaySeconds: 1 }), 'sent');
      assert.equal(await env.JOBS_QUEUE.sendBatch(['b'], { delaySeconds: 2 }), 'batched');
      return new Response('result', {
        status: 202,
        statusText: 'Queued',
        headers: { 'X-Original': 'yes' },
      });
    },
  );
  assert.deepEqual(calls, [
    ['metrics'],
    ['send', 'a', { delaySeconds: 1 }],
    ['batch', ['b'], { delaySeconds: 2 }],
  ]);
  assert.equal(
    callTestMethod(jsonObject(result).headers, 'get', 'X-Fixture-Queue-Producer-Calls'),
    '2',
  );
  assert.equal(callTestMethod(jsonObject(result).headers, 'get', 'X-Original'), 'yes');
  assert.equal(jsonObject(result).status, 202);
  assert.equal(jsonObject(result).statusText, 'Queued');
  assert.equal(await callTestMethod(result, 'text'), 'result');
  const empty = await callTestBoundary(
    observeJobSubmission,
    request('/'),
    { JOBS_QUEUE: queue },
    {},
    async () => new Response(null, { status: 204 }),
  );
  assert.equal(
    callTestMethod(jsonObject(jsonObject(empty).headers), 'get', 'X-Fixture-Queue-Producer-Calls'),
    '0',
  );
});

void test('validator failure proxy preserves non-validation properties', async () => {
  const result = await callTestBoundary(
    observeJobSubmission,
    request('/?fixture=validator-failure'),
    {
      JOBS_QUEUE: {},
      JOBS_VALIDATOR: { label: 'validator' },
    },
    {},
    async (
      _request: unknown,
      env: {
        JOBS_VALIDATOR: {
          label: unknown;
          validate: () => Promise<unknown> | (() => Promise<unknown>);
        };
      },
    ) => {
      assert.equal(env.JOBS_VALIDATOR.label, 'validator');
      await assert.rejects(env.JOBS_VALIDATOR.validate(), /private-validator-marker/);
      return new Response('checked');
    },
  );
  assert.equal(await callTestMethod(jsonObject(result), 'text'), 'checked');
});
