import type * as Module from 'node:module';
import {
  jsonArray,
  jsonObject,
  jsonString,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import {
  callTestBoundary,
  callTestMethod,
  constructTestBoundary,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
/** Node boundary tests of fixture orchestration, not Haskell or native service proofs. */
import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  resolve(
    specifier: string,
    context: Module.ResolveHookContext,
    next: (
      specifier: string,
      context?: Partial<Module.ResolveHookContext>,
    ) => Module.ResolveFnOutput,
  ): import('module').ResolveFnOutput {
    if (specifier === 'cloudflare:workers') {
      return {
        url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
        shortCircuit: true,
      };
    }

    if (specifier.startsWith('.') && (specifier.endsWith('.js') || specifier === './runtime')) {
      const path = specifier === './runtime' ? './runtime.ts' : specifier.slice(0, -3) + '.ts';
      return next(path, context);
    }

    return next(specifier, context);
  },
});
const reactor: Record<string, unknown> = {};
const runtimeMocks = ['./runtime.ts', '../../worker/runtime.ts'].map((path) =>
  mock.module(new URL(path, import.meta.url).href, {
    namedExports: { reactor },
  }),
);
const { inspectJobsFailure } = await loadTestModule(
  new URL('./jobs-failures.ts', import.meta.url).href,
);
const { inspectQueueContract } = await loadTestModule(
  new URL('./queue-contracts.ts', import.meta.url).href,
);
const { consumeObservedJobs, jobsQueueFixture } = await loadTestModule(
  new URL('./jobs-queue.ts', import.meta.url).href,
);
const { JobsState } = await loadTestModule(new URL('./jobs-state.ts', import.meta.url).href);
void after(() => {
  runtimeMocks.forEach((item) => item.restore());
  hooks.deregister();
});
function databaseFixture(): {
  queries: unknown[][];
  exec(sql: unknown): Promise<void>;
  prepare(sql: unknown): {
    bind(...args: unknown[]): {
      run(): Promise<void>;
      all(): Promise<{ results: { attempts: number }[] }>;
    };
  };
} {
  const queries: unknown[][] = [];
  return {
    queries,
    async exec(sql: unknown): Promise<void> {
      queries.push(['exec', sql]);
    },
    prepare(sql: unknown): {
      bind(...args: unknown[]): {
        run(): Promise<void>;
        all(): Promise<{ results: { attempts: number }[] }>;
      };
    } {
      return {
        bind(...args: unknown[]): {
          run(): Promise<void>;
          all(): Promise<{ results: { attempts: number }[] }>;
        } {
          queries.push([sql, ...args]);
          return {
            async run(): Promise<void> {},
            async all(): Promise<{ results: { attempts: number }[] }> {
              return { results: [{ attempts: 2 }] };
            },
          };
        },
      };
    },
  };
}

void test('queue fixture exposes rejection, absent and malformed metrics faithfully', async () => {
  const context = {};
  for (const mode of ['send', 'send-batch', 'metrics', 'batch']) {
    for (const variant of ['success', 'reject', 'absent', 'invalid', 'getter', 'date']) {
      reactor.queueContract = async (
        receivedMode: unknown,
        input: Record<string, unknown>,
        env: unknown,
        ctx: unknown,
      ) => {
        assert.equal(receivedMode, mode);
        assert.equal(ctx, context);
        assert.deepEqual(env, {});
        let metrics;

        if (mode !== 'batch') {
          const method = mode === 'send-batch' ? 'sendBatch' : mode;

          if (variant === 'reject') {
            await assert.rejects(
              Promise.resolve(callTestMethod(input, method)),
              /synthetic .* rejection/,
            );
            return '"rejected"';
          }

          const result = await callTestMethod(input, method);
          metrics = (() => {
            if (mode === 'metrics') {
              return result;
            }

            if (result == null) {
              return undefined;
            }

            return jsonObject(jsonObject(result).metadata).metrics;
          })();
        } else {
          assert.equal(input.queue, 'synthetic-contract');
          assert.equal(jsonObject(jsonArray(input.messages)[0]).body, '{"valid":true}');
          assert.equal(jsonObject(jsonArray(input.messages)[1]).body, '{broken');
          callTestMethod(jsonArray(input.messages)[0], 'ack');
          callTestMethod(jsonArray(input.messages)[1], 'retry', {});
          callTestMethod(jsonArray(input.messages)[1], 'retry', { delaySeconds: 5 });
          callTestMethod(input, 'ackAll');
          callTestMethod(input, 'retryAll', { delaySeconds: 7 });
          metrics = input.metadata == null ? undefined : jsonObject(input.metadata).metrics;
        }

        if (variant === 'absent' && mode !== 'metrics') {
          assert.equal(metrics, undefined);
        } else if (variant === 'invalid') {
          assert.equal(
            mode === 'batch' ? metrics : jsonObject(metrics).backlogCount,
            mode === 'batch' ? null : -1,
          );
        } else if (variant === 'getter') {
          assert.throws(() => jsonObject(metrics).backlogCount, /synthetic getter failure/);
        } else if (variant === 'date') {
          assert.ok(
            Number.isNaN(
              callTestMethod(jsonObject(jsonObject(metrics).oldestMessageTimestamp), 'getTime'),
            ),
          );
        } else {
          assert.equal(jsonObject(metrics).backlogCount, 7);
        }
        return '"observed"';
      };
      const body = await callTestMethod(
        jsonObject(await callTestBoundary(inspectQueueContract, `${mode}~${variant}`, context)),
        'json',
      );
      assert.deepEqual(
        jsonObject(body).calls,
        (() => {
          if (mode === 'batch') {
            return ['ack:0', 'retry:1:default', 'retry:1:5', 'ackAll', 'retryAll:7'];
          }

          return [mode === 'send-batch' ? 'sendBatch' : mode];
        })(),
      );
    }
  }
});

void test('queue ingress validates identifiers, forwards mixed payloads and filters delivery query', async () => {
  const batches: unknown[] = [];
  const database = databaseFixture();
  const env = {
    JOBS_DB: database,
    JOBS_QUEUE: {
      async sendBatch(batch: unknown): Promise<void> {
        batches.push(batch);
      },
    },
  };
  const request = (
    suffix: string,
    method: string = 'GET',
  ): Request<unknown, CfProperties<unknown>> =>
    new Request(`https://fixture.test/__fixture/jobs/queue/${suffix}`, {
      method,
    });
  for (const run of ['', 'bad_underscore', 'a'.repeat(51)]) {
    assert.equal(
      jsonObject(await callTestBoundary(jobsQueueFixture, request(`mixed?run=${run}`, 'POST'), env))
        .status,
      400,
    );
  }
  assert.equal(
    jsonObject(await callTestBoundary(jobsQueueFixture, request('mixed?run=abc', 'POST'), env))
      .status,
    202,
  );
  assert.deepEqual(
    jsonArray(batches[0]).map((item) => [
      jsonObject(jsonObject(item).body).identifier,
      jsonObject(jsonObject(item).body).payload,
      jsonObject(item).contentType,
    ]),
    [
      ['queue-contract-abc-good-a', 'first valid job', 'json'],
      ['queue-contract-abc-poison', 123, 'json'],
      ['queue-contract-abc-good-b', 'second valid job', 'json'],
    ],
  );
  assert.deepEqual(
    await callTestMethod(
      jsonObject(await callTestBoundary(jobsQueueFixture, request('deliveries?run=abc'), env)),
      'json',
    ),
    [{ attempts: 2 }],
  );
  assert.deepEqual(database.queries[1].slice(1), [
    'queue-contract-abc-good-a',
    'queue-contract-abc-poison',
    'queue-contract-abc-good-b',
  ]);
  assert.equal(
    jsonObject(await callTestBoundary(jobsQueueFixture, request('mixed?run=abc'), env)).status,
    404,
  );
});

void test('observed jobs persist fixture deliveries before DLQ acknowledgement or delegation', async () => {
  for (const queue of ['library-jobs-dlq', 'library-jobs']) {
    const database = databaseFixture();
    let acked = false,
      delegated = false;
    const batch = {
      queue,
      messages: [
        null,
        'text',
        {},
        { identifier: 5 },
        { identifier: 'ordinary' },
        { identifier: 'queue-contract-a' },
      ].map((body) => ({ body, attempts: 2 })),
      ackAll(): void {
        assert.equal(database.queries.length, 2);
        acked = true;
      },
    };
    const env = { JOBS_DB: database },
      context = {};
    reactor.queue = async (received: unknown, bindings: unknown, ctx: unknown) => {
      assert.equal(received, batch);
      assert.equal(bindings, env);
      assert.equal(ctx, context);
      delegated = true;
    };
    await callTestBoundary(consumeObservedJobs, batch, env, context);
    assert.equal(acked, queue === 'library-jobs-dlq');
    assert.equal(delegated, queue !== 'library-jobs-dlq');
    assert.deepEqual(database.queries[1].slice(1, 4), [queue, 'queue-contract-a', 2]);
    assert.deepEqual(jsonValue(jsonString(database.queries[1][4])), [
      'unidentified',
      'unidentified',
      'unidentified',
      'unidentified',
      'ordinary',
      'queue-contract-a',
    ]);
  }
});

void test('job state injects one transient error and tracks lost committed responses', async () => {
  const values = new Map();
  const storage = {
    async get(key: unknown): Promise<unknown> {
      return values.get(key);
    },
    async put(key: unknown, value: unknown): Promise<void> {
      values.set(key, value);
    },
  };
  reactor.jobsInitialize = async (received: unknown) => {
    assert.equal(received, storage);
  };
  let commits = 0;
  reactor.jobsCommit = async () => {
    commits += 1;
    return '"committed"';
  };
  reactor.jobsStatus = async () => '{"status":"done"}';
  const state = constructTestBoundary(
    JobsState,
    { storage, blockConcurrencyWhile: (action: () => unknown) => action() },
    {},
  );
  await assert.rejects(
    Promise.resolve(callTestMethod(state, 'commit', '{"identifier":"retry-once"}')),
    /transient storage failure/,
  );
  assert.equal(commits, 0);
  assert.equal(await callTestMethod(state, 'commit', '{"identifier":"retry-once"}'), '"committed"');
  await assert.rejects(
    Promise.resolve(callTestMethod(state, 'commit', '{"identifier":"commit-response-lost"}')),
    /RPC response loss after commit/,
  );
  assert.equal(commits, 2);
  assert.equal(
    await callTestMethod(state, 'commit', '{"identifier":"commit-response-lost"}'),
    '"committed"',
  );
  assert.deepEqual(jsonValue(await callTestMethod(state, 'status', 'commit-response-lost')), {
    status: 'done',
    attempts: 2,
  });
  assert.equal(await callTestMethod(state, 'status', 'ordinary'), '{"status":"done"}');
  for (const value of [null, [], 1, {}, { identifier: 'ordinary' }]) {
    assert.equal(await callTestMethod(state, 'commit', JSON.stringify(value)), '"committed"');
  }
  for (const value of ['bad', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    values.set('fixture:response-loss-attempts', value);
    await assert.rejects(
      Promise.resolve(callTestMethod(state, 'commit', '{"identifier":"commit-response-lost"}')),
      /Invalid response-loss attempt counter/,
    );
  }
  for (const value of [undefined, 'bad', 0, -1, 0.5]) {
    values.set('fixture:response-loss-attempts', value);
    await assert.rejects(
      Promise.resolve(callTestMethod(state, 'status', 'commit-response-lost')),
      /Invalid response-loss attempt counter/,
    );
  }
  reactor.jobsStatus = async () => 'null';
  assert.equal(await callTestMethod(state, 'status', 'commit-response-lost'), 'null');
  for (const value of [[], 'bad', 1]) {
    reactor.jobsStatus = async () => JSON.stringify(value);
    await assert.rejects(
      Promise.resolve(callTestMethod(state, 'status', 'commit-response-lost')),
      /Invalid persisted job status/,
    );
  }
});

void test('delivery evidence failures prevent acknowledgement and application delegation', async () => {
  for (const stage of ['prepare', 'insert', 'success']) {
    for (const queue of ['library-jobs', 'library-jobs-dlq']) {
      const failure = new Error(`${stage} unavailable`);
      let acknowledged = false;
      let delegated = false;
      reactor.queue = async () => {
        delegated = true;
      };
      const database = {
        async exec(): Promise<void> {
          if (stage === 'prepare') {
            throw failure;
          }
        },
        prepare(): { bind(): { run(): Promise<void> } } {
          return {
            bind(): { run(): Promise<void> } {
              return {
                async run(): Promise<void> {
                  if (stage === 'insert') {
                    throw failure;
                  }
                },
              };
            },
          };
        },
      };
      const consuming = callTestBoundary(
        consumeObservedJobs,
        {
          queue,
          messages: [{ body: { identifier: 'queue-contract-one' }, attempts: 1 }],
          ackAll(): void {
            acknowledged = true;
          },
        },
        { JOBS_DB: database },
        {},
      );

      if (stage === 'success') {
        await consuming;
        assert.equal(acknowledged, queue === 'library-jobs-dlq');
        assert.equal(delegated, queue !== 'library-jobs-dlq');
      } else {
        await assert.rejects(Promise.resolve(consuming), (error) => error === failure);
        assert.equal(acknowledged, false);
        assert.equal(delegated, false);
      }
    }
  }
});

void test('fixture ingress does not turn producer rejection into an accepted response', async () => {
  const failure = new Error('queue unavailable');
  await assert.rejects(
    Promise.resolve(
      callTestBoundary(
        jobsQueueFixture,
        new Request('https://fixture.test/__fixture/jobs/queue/mixed?run=valid', {
          method: 'POST',
        }),
        {
          JOBS_QUEUE: {
            async sendBatch(): Promise<never> {
              throw failure;
            },
          },
        },
      ),
    ),
    (error) => error === failure,
  );
});

void test('runtime fixtures preserve reactor failures and reject malformed encoded results', async () => {
  for (const invoke of [() => callTestBoundary(inspectQueueContract, 'send~success', {})]) {
    const failure = new Error('reactor unavailable');
    reactor.queueContract = async () => {
      throw failure;
    };
    await assert.rejects(Promise.resolve(invoke()), (error) => error === failure);
    reactor.queueContract = async () => 'not JSON';
    await assert.rejects(Promise.resolve(invoke()), SyntaxError);
  }
});

void test('Jobs failure fixture rejects unknown and inherited scenario names', async () => {
  for (const scenario of ['unknown', 'constructor', 'toString', '__proto__']) {
    const response = await callTestBoundary(inspectJobsFailure, scenario);
    assert.equal(jsonObject(response).status, 400);
    assert.equal(
      await callTestMethod(jsonObject(response), 'text'),
      'Unknown Jobs failure scenario',
    );
  }
});

void test('Jobs fixture guards namespaces and supports unfiltered ascending list contracts', async () => {
  reactor.jobsFailure = async (
    mode: unknown,
    namespace: { getByName: (arg0: string) => unknown },
  ) => {
    assert.equal(mode, 'read');
    assert.throws(() => namespace.getByName('wrong'), /Unexpected namespace name/);
    return '{}';
  };
  assert.equal(jsonObject(await callTestBoundary(inspectJobsFailure, 'read-json')).status, 200);
  reactor.jobsFailure = async (_mode: unknown, storage: { list: (arg0: {}) => unknown }) => {
    const records = await storage.list({});
    assert.ok(records instanceof Map);
    assert.deepEqual([...records.keys()], [...records.keys()].sort());
    return '{}';
  };
  assert.equal(jsonObject(await callTestBoundary(inspectJobsFailure, 'save-prune')).status, 200);
});
