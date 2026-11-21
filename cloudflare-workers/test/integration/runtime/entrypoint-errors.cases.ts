import {
  jsonArray,
  jsonObject,
  jsonSequence,
  jsonString,
  jsonValue,
} from '../../../../scripts/testing/Support/json.mts';
import { expect, it } from 'vitest';
import { entrypointErrorsProbe } from '../../../../tests/runtime/harness.js';

const probe = async (mode: string, event: unknown): Promise<unknown> =>
  jsonValue(await entrypointErrorsProbe(mode, event, {}, {}));

export function registerEntrypointErrorsCases(): void {
  it('observes present metrics in the native batch receipt', async () => {
    const result = await probe('queue-entry-delay', {
      sendBatch: async () => ({
        metadata: { metrics: { backlogCount: 3, backlogBytes: 12 } },
      }),
    });
    expect(jsonObject(result).ok).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).hasMetrics).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).matchesBatchReceipt).toBe(false);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).differsFromSendReceipt).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).receipt).toContain(
      'queueMetricsBacklogCount = 3',
    );
  });
  it('compares a metrics-bearing send receipt with its absent-metrics counterpart', async () => {
    const result = await probe('queue-send-receipt', {
      send: async () => ({
        metadata: { metrics: { backlogCount: 3, backlogBytes: 12 } },
      }),
    });
    expect(jsonObject(result).ok).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).differsFromSendReceipt).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).hasMetrics).toBe(true);
  });
  it('registers and completes deferred work before inspecting its observable result', async () => {
    const pending: Promise<unknown>[] = [];
    const result = jsonValue(
      await entrypointErrorsProbe(
        'context-wait',
        {},
        {},
        {
          waitUntil(promise: Promise<unknown>): void {
            pending.push(promise);
          },
        },
      ),
    );
    await Promise.all(pending);
    expect(pending).toHaveLength(1);
    expect(result).toEqual({
      ok: true,
      message: '',
      observed: [{ deferred: true }],
    });
  });
  it('keeps public configuration, error and event comparison coherent with diagnostic lists', async () => {
    const result = await probe('public-instance-contracts', {});
    expect(jsonObject(result).ok).toBe(true);
    expect(jsonArray(jsonObject(result).observed).map((item) => jsonObject(item).name)).toEqual([
      'content-types',
      'send-options',
      'batch-options',
      'metric-sources',
      'metrics',
      'send-results',
      'validation-failures',
      'rejection-kinds',
      'rejections',
      'queue-errors',
      'retry-options',
      'failure-dispositions',
      'socket-payloads',
      'socket-errors',
      'tail-events',
      'workflow-events',
      'message-failures',
      'workflow-required-field',
    ]);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[17]).missingRejected).toBe(true);
    for (const contract of jsonArray(jsonObject(result).observed).slice(0, 17)) {
      expect(jsonObject(contract).showCoherent, jsonString(jsonObject(contract).name)).toBe(true);
      expect(jsonObject(contract).listCoherent, jsonString(jsonObject(contract).name)).toBe(true);
      expect(jsonString(jsonObject(contract).diagnostics).startsWith('[')).toBe(true);
      expect(jsonString(jsonObject(contract).diagnostics).endsWith(']')).toBe(true);

      if (jsonObject(contract).name !== 'message-failures') {
        expect(jsonObject(contract).reflexive, jsonString(jsonObject(contract).name)).toBe(true);
        expect(jsonObject(contract).distinct, jsonString(jsonObject(contract).name)).toBe(true);
        expect(
          jsonObject(contract).diagnosticsDistinct,
          jsonString(jsonObject(contract).name),
        ).toBe(true);
      }
    }
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).diagnostics).toBe(
      '[QueueContentTypeJSON,QueueContentTypeText,QueueContentTypeBytes,QueueContentTypeV8]',
    );
    expect(jsonObject(jsonArray(jsonObject(result).observed)[16]).diagnostics).toContain(
      'QueueDecodeFailure',
    );
    expect(jsonObject(jsonArray(jsonObject(result).observed)[16]).diagnostics).toContain(
      'bad JSON',
    );
    expect(jsonObject(jsonArray(jsonObject(result).observed)[16]).diagnostics).toContain(
      'QueueDecodeException',
    );
    expect(jsonObject(jsonArray(jsonObject(result).observed)[16]).diagnostics).toContain(
      'decode failed',
    );
    expect(jsonObject(jsonArray(jsonObject(result).observed)[16]).diagnostics).toContain(
      'QueueProcessingFailure',
    );
    expect(jsonObject(jsonArray(jsonObject(result).observed)[16]).diagnostics).toContain(
      'handler failed',
    );
  });
  it('classifies native batch-bytes rejection and retains the original diagnostic', async () => {
    const failed = await probe('queue-batch-rejection', {
      sendBatch: async () => {
        throw new Error('BATCH BYTES exceeded');
      },
    });
    expect(jsonObject(failed).ok).toBe(false);
    expect(jsonObject(failed).observed).toEqual([
      {
        kind: 'QueueBatchBytesTooLargeRejction',
        information: 'Error: BATCH BYTES exceeded',
      },
    ]);
    expect(jsonObject(await probe('queue-batch-rejection', { sendBatch: async () => {} })).ok).toBe(
      true,
    );
  });
  it('validates at public send wrappers before calling native methods', async () => {
    let calls = 0;
    const producer = {
      send: async () => {
        calls += 1;
      },
      sendBatch: async () => {
        calls += 1;
      },
    };
    for (const [mode, expected] of [
      ['queue-message-invalid', 'QueueDelayOutOfRange (-1)'],
      ['queue-batch-invalid', 'QueueBatchEmpty'],
    ] as const) {
      const failed = await probe(mode, producer);
      expect(jsonObject(failed).ok).toBe(false);
      expect(jsonObject(failed).observed).toEqual([{ validation: expected }]);
    }
    expect(calls).toBe(0);
    expect(jsonObject(await probe('queue-batch-rejection', producer)).ok).toBe(true);
    expect(calls).toBe(1);
  });
  it('serializes per-message delays only for entries that specify them', async () => {
    const entries: unknown[] = [];
    const result = await probe('queue-entry-delay', {
      sendBatch: async (batch: unknown[]) => {
        entries.push(...batch);
      },
    });
    expect(jsonObject(result).ok).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).matchesBatchReceipt).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).differsFromSendReceipt).toBe(true);
    expect(jsonObject(jsonArray(jsonObject(result).observed)[0]).receipt).toContain(
      'QueueSendBatchMetricsSource',
    );
    expect(entries).toEqual([
      { body: 'first', contentType: 'text', delaySeconds: 7 },
      { body: 'second', contentType: 'text' },
    ]);
  });
  it('delivers actual configuration and execution context to scheduled and tail handlers', async () => {
    let contextCalls = 0;
    const context = {
      passThroughOnException(): void {
        contextCalls += 1;
      },
    };
    const configuration = { CONFIG: 'handler-configuration' };
    const scheduled = jsonValue(
      await entrypointErrorsProbe(
        'configured-scheduled',
        { cron: '* * * * *', scheduledTime: 0 },
        configuration,
        context,
      ),
    );
    expect(jsonObject(scheduled).observed).toEqual([
      { config: 'handler-configuration', cron: '* * * * *' },
    ]);
    const tail = jsonValue(
      await entrypointErrorsProbe('configured-tail', [{ outcome: 'ok' }], configuration, context),
    );
    expect(jsonObject(tail).observed).toEqual([
      { config: 'handler-configuration', outcomes: ['ok'] },
    ]);
    expect(contextCalls).toBe(2);
  });
  it('delivers parse diagnostics and configuration to typed failure policies', async () => {
    let acknowledgements = 0;
    let contextCalls = 0;
    const messages = ['1', 'invalid'].map((body, index) => ({
      id: String(index),
      timestamp: new Date(0),
      attempts: 1,
      body,
      ack(): void {
        acknowledgements += 1;
      },
    }));
    const result = jsonValue(
      await entrypointErrorsProbe(
        'configured-typed',
        { queue: 'q', messages },
        { CONFIG: 'policy-configuration' },
        {
          passThroughOnException(): void {
            contextCalls += 1;
          },
        },
      ),
    );
    expect(jsonObject(result).ok).toBe(true);
    expect(jsonArray(jsonObject(result).observed)[0]).toEqual({
      config: 'policy-configuration',
      identifier: '0',
      decoded: 1,
    });
    expect(jsonObject(jsonArray(jsonObject(result).observed)[1]).config).toBe(
      'policy-configuration',
    );
    expect(jsonObject(jsonArray(jsonObject(result).observed)[1]).identifier).toBe('1');
    expect(jsonObject(jsonArray(jsonObject(result).observed)[1]).failure).toContain(
      'QueueDecodeFailure',
    );
    expect(
      jsonSequence(jsonObject(jsonArray(jsonObject(result).observed)[1]).failure).length,
    ).toBeGreaterThan('QueueDecodeFailure'.length + 3);
    expect(contextCalls).toBe(2);
    expect(acknowledgements).toBe(2);
  });
  it('contains native logging exceptions and recovers without inspecting thrown values', async () => {
    const original = console.log;
    for (const mode of ['tail-log', 'structured-log']) {
      for (const failure of [
        new Error('private logging error'),
        {
          toString(): never {
            throw new Error('do not stringify');
          },
        },
      ]) {
        let result;
        try {
          console.log = () => {
            throw failure;
          };
          result = await probe(mode, {});
        } finally {
          console.log = original;
        }
        expect(jsonObject(result).ok).toBe(false);
        expect(jsonObject(result).message).toContain('Worker console.log failed');
        expect(jsonObject(result).message).not.toContain('private logging error');
        expect(jsonObject(await probe(mode, {})).ok).toBe(true);
      }
    }
  });
  it('returns the fetch error response for an invalid URL before invoking the handler', async () => {
    const result = await probe('fetch', {
      method: 'GET',
      url: '',
      headers: new Headers(),
      body: null,
    });
    expect(result).toEqual({
      ok: true,
      message: '',
      observed: [{ status: 500 }],
    });
    expect(await probe('fetch', new Request('https://example.com/'))).toEqual({
      ok: true,
      message: '',
      observed: [{ handled: true }, { status: 204 }],
    });
  });
  it('passes the actual execution context into both typed action and failure policy', async () => {
    let contextCalls = 0;
    let acknowledgements = 0;
    const messages = ['1', 'invalid'].map((body, index) => ({
      id: String(index),
      timestamp: new Date(0),
      attempts: 1,
      body,
      ack(): void {
        acknowledgements += 1;
      },
    }));
    const result = jsonValue(
      await entrypointErrorsProbe(
        'queue-typed',
        { queue: 'typed', messages },
        {},
        {
          passThroughOnException(): void {
            contextCalls += 1;
          },
        },
      ),
    );
    expect(result).toEqual({
      ok: true,
      message: '',
      observed: [{ identifier: '0', decoded: 1 }, { rejected: '1' }],
    });
    expect(contextCalls).toBe(2);
    expect(acknowledgements).toBe(2);
  });
  it('observes the compatibility initializer returning normally', async () => {
    expect(await probe('initialize', {})).toEqual({
      ok: true,
      message: '',
      observed: [{ initialized: true }],
    });
  });
  it('reports missing and rejected producer metrics and recovers', async () => {
    for (const producer of [
      {},
      { metrics: async () => undefined },
      {
        metrics: async () => {
          throw new Error('metrics failed');
        },
      },
    ]) {
      const result = await probe('producer-metrics', producer);
      expect(jsonObject(result).ok).toBe(false);
      expect(jsonObject(result).message).toContain('QueueMetricsFailed');
    }
    expect(
      await probe('producer-metrics', {
        metrics: async () => ({ backlogCount: 1, backlogBytes: 2 }),
      }),
    ).toEqual({
      ok: true,
      message: '',
      observed: [{ count: 1, bytes: 2, timestamp: null }],
    });
  });
  it('catches context registration failures and permits subsequent context use', async () => {
    for (const mode of ['context-pass', 'context-wait']) {
      const context = {
        passThroughOnException(): never {
          throw new Error('context failed');
        },
        waitUntil(): never {
          throw new Error('context failed');
        },
      };
      const result = jsonValue(await entrypointErrorsProbe(mode, {}, {}, context));
      expect(jsonObject(result).ok).toBe(false);
      expect(jsonObject(result).message).toContain('context failed');
    }
    let calls = 0;
    const result = jsonValue(
      await entrypointErrorsProbe(
        'context-pass',
        {},
        {},
        {
          passThroughOnException(): void {
            calls += 1;
          },
        },
      ),
    );
    expect(jsonObject(result).ok).toBe(true);
    expect(calls).toBe(1);
  });
  it('observes queue message and custom metrics metadata before settling', async () => {
    let acknowledgements = 0;
    const result = await probe('queue', {
      queue: 'metadata-queue',
      messages: [
        {
          id: 'message-7',
          timestamp: new Date(1700000000123),
          attempts: 3,
          body: new Uint8Array([0, 128, 255]),
          ack(): void {
            acknowledgements += 1;
          },
        },
      ],
      metadata: {
        metrics: {
          backlogCount: 7,
          backlogBytes: 513,
          oldestMessageTimestamp: new Date(1700000000000),
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      message: '',
      observed: [
        { queue: 'metadata-queue', metrics: [7, 513, 1700000000000] },
        {
          identifier: 'message-7',
          timestamp: 1700000000123,
          attempts: 3,
          bytes: [0, 128, 255],
        },
      ],
    });
    expect(acknowledgements).toBe(1);
  });
  it('rejects invalid consumer metrics before invoking the handler and recovers', async () => {
    for (const metrics of [
      null,
      {},
      { backlogCount: -1, backlogBytes: 0 },
      { backlogCount: 0, backlogBytes: NaN },
    ]) {
      const result = await probe('queue', {
        queue: 'q',
        messages: [],
        metadata: { metrics },
      });
      expect(jsonObject(result).ok).toBe(false);
      expect(jsonObject(result).observed).toEqual([]);
      expect(jsonObject(result).message).toContain('QueueMetricsFailed');
    }
    expect(await probe('queue', { queue: 'q', messages: [] })).toEqual({
      ok: true,
      message: '',
      observed: [{ queue: 'q', metrics: null }],
    });
  });
  it('rejects both out-of-range retry directions without settling', async () => {
    let retries = 0;
    for (const mode of ['queue-negative', 'queue-excess']) {
      const result = await probe(mode, {
        queue: 'q',
        messages: [
          {
            id: 'retry',
            timestamp: new Date(0),
            attempts: 1,
            body: 'payload',
            retry(): void {
              retries += 1;
            },
          },
        ],
      });
      expect(jsonObject(result).ok).toBe(false);
      expect(jsonObject(result).message).toContain('QueueBatchDelayOutOfRange');
    }
    expect(retries).toBe(0);
  });
  it('propagates consumer failures after metadata observation', async () => {
    const result = await probe('queue-throw', { queue: 'q', messages: [] });
    expect(jsonObject(result).ok).toBe(false);
    expect(jsonObject(result).message).toContain('consumer failed');
    expect(jsonObject(result).observed).toEqual([{ queue: 'q', metrics: null }]);
  });
  it('passes scheduled metadata and noRetry to the handler, including handler failure', async () => {
    let calls = 0;
    const controller = {
      cron: '*/5 * * * *',
      scheduledTime: 1700000000123,
      noRetry(): void {
        calls += 1;
      },
    };
    expect(await probe('scheduled', controller)).toEqual({
      ok: true,
      message: '',
      observed: [{ cron: controller.cron, time: controller.scheduledTime }],
    });
    const failed = await probe('scheduled-throw', controller);
    expect(jsonObject(failed).ok).toBe(false);
    expect(jsonObject(failed).message).toContain('scheduled handler failed');
    expect(calls).toBe(2);
  });
  it('consumes both optional Tail fields and propagates handler errors', async () => {
    const events = [
      { scriptName: 'worker', outcome: 'ok', eventTimestamp: 1700000000123 },
      { outcome: 'exception' },
    ];
    expect(await probe('tail', events)).toEqual({
      ok: true,
      message: '',
      observed: [
        {
          events: [
            ['worker', 'ok', 1700000000123],
            [null, 'exception', null],
          ],
        },
      ],
    });
    expect(jsonObject(await probe('tail-throw', events)).message).toContain('tail handler failed');
    expect(await probe('tail', [])).toEqual({
      ok: true,
      message: '',
      observed: [{ events: [] }],
    });
  });
}
