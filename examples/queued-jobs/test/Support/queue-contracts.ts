import { jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { reactor } from './runtime.js';

/** Synthetic JS objects exercise the real Haskell boundary, not Queue service capabilities. */
export async function inspectQueueContract(
  scenario: string,
  context: ExecutionContext,
): Promise<Response> {
  const [mode, variant] = scenario.split('~');
  const calls: string[] = [];
  const metrics = {
    backlogCount: 7,
    backlogBytes: 8192,
    oldestMessageTimestamp: new Date(1234),
  };
  const selectedMetrics = (() => {
    if (variant === 'invalid') {
      return { backlogCount: -1, backlogBytes: 2 };
    }

    if (variant === 'getter') {
      return {
        get backlogCount(): number {
          throw new Error('synthetic getter failure');
        },
        backlogBytes: 2,
      };
    }

    if (variant === 'date') {
      return { ...metrics, oldestMessageTimestamp: new Date(NaN) };
    }

    return metrics;
  })();
  const response =
    variant === 'absent'
      ? undefined
      : {
          metadata: {
            metrics: selectedMetrics,
          },
        };
  const producer = {
    async send(): Promise<
      | {
          metadata: {
            metrics:
              | { backlogCount: number; backlogBytes: number; oldestMessageTimestamp: Date }
              | { readonly backlogCount: number; backlogBytes: number };
          };
        }
      | undefined
    > {
      calls.push('send');

      if (variant === 'reject') {
        throw new Error('synthetic send rejection');
      }

      return response;
    },
    async sendBatch(): Promise<
      | {
          metadata: {
            metrics:
              | { backlogCount: number; backlogBytes: number; oldestMessageTimestamp: Date }
              | { readonly backlogCount: number; backlogBytes: number };
          };
        }
      | undefined
    > {
      calls.push('sendBatch');

      if (variant === 'reject') {
        throw new Error('synthetic batch rejection');
      }

      return response;
    },
    async metrics(): Promise<
      | { backlogCount: number; backlogBytes: number; oldestMessageTimestamp: Date }
      | { readonly backlogCount: number; backlogBytes: number }
    > {
      calls.push('metrics');

      if (variant === 'reject') {
        throw new Error('synthetic metrics rejection');
      }

      return selectedMetrics;
    },
  };
  const batch = {
    queue: 'synthetic-contract',
    ...(() => {
      if (variant === 'absent') {
        return {};
      }

      return {
        metadata: { metrics: variant === 'invalid' ? null : selectedMetrics },
      };
    })(),
    messages: ['{"valid":true}', '{broken'].map((body, index) => ({
      id: `message-${index}`,
      timestamp: new Date(1000),
      attempts: 1,
      body,
      ack(): void {
        calls.push(`ack:${index}`);
      },
      retry(options: QueueRetryOptions): void {
        calls.push(`retry:${index}:${options.delaySeconds ?? 'default'}`);
      },
    })),
    ackAll(): void {
      calls.push('ackAll');
    },
    retryAll(options: QueueRetryOptions): void {
      calls.push(`retryAll:${options.delaySeconds}`);
    },
  };
  const input = mode === 'send' || mode === 'send-batch' || mode === 'metrics' ? producer : batch;
  const result: unknown = jsonValue(await reactor.queueContract(mode, input, {}, context));
  return Response.json({ result, calls });
}
