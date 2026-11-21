import assert from 'node:assert/strict';
import { test } from 'node:test';
import { poll } from '../Support/polling.mts';

void test('polling observes progress and returns the completed value', async () => {
  let calls = 0;
  const result = await poll({
    observe: async () => ++calls,
    complete: (count) => count === 3,
    timeout: 10,
    wait: async () => {},
    diagnostic: (last) => `unfinished: ${last}`,
  });

  assert.equal(result, 3);
  assert.equal(calls, 3);
});

void test('timeout includes the last observed state and application identity', async () => {
  let time = 0;
  const result = poll({
    observe: async () => ({ attempts: 2, state: 'pending' }),
    complete: (value) => value.state === 'done',
    timeout: 3,
    now: () => time++,
    wait: async () => {},
    diagnostic: (last) => `Job example-job unfinished: ${JSON.stringify(last)}`,
  });

  await assert.rejects(result, /example-job.*attempts.*pending/);
});

void test('observation failures propagate without being converted into timeout', async () => {
  const failure = new Error('connection failed');
  const result = poll({
    observe: async (): Promise<never> => {
      throw failure;
    },
    complete: () => false,
    timeout: 100,
    diagnostic: () => 'timeout',
  });

  await assert.rejects(result, (error: unknown) => error === failure);
});
