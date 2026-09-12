import { reactor } from "./runtime.js";

/** Synthetic JS objects exercise the real Haskell boundary, not Queue service capabilities. */
export async function inspectQueueContract(
  scenario: string,
  context: ExecutionContext,
): Promise<Response> {
  const [mode, variant] = scenario.split("~");
  const calls: string[] = [];
  const metrics = {
    backlogCount: 7,
    backlogBytes: 8192,
    oldestMessageTimestamp: new Date(1234),
  };
  const selectedMetrics =
    variant === "invalid"
      ? { backlogCount: -1, backlogBytes: 2 }
      : variant === "getter"
        ? {
            get backlogCount(): number {
              throw new Error("synthetic getter failure");
            },
            backlogBytes: 2,
          }
        : variant === "date"
          ? { ...metrics, oldestMessageTimestamp: new Date(NaN) }
          : metrics;
  const response =
    variant === "absent"
      ? undefined
      : {
          metadata: {
            metrics: selectedMetrics,
          },
        };
  const producer = {
    async send() {
      calls.push("send");
      if (variant === "reject") {
        throw new Error("synthetic send rejection");
      }
      return response;
    },
    async sendBatch() {
      calls.push("sendBatch");
      if (variant === "reject") {
        throw new Error("synthetic batch rejection");
      }
      return response;
    },
    async metrics() {
      calls.push("metrics");
      if (variant === "reject") {
        throw new Error("synthetic metrics rejection");
      }
      return selectedMetrics;
    },
  };
  const batch = {
    queue: "synthetic-contract",
    ...(variant === "absent"
      ? {}
      : {
          metadata: { metrics: variant === "invalid" ? null : selectedMetrics },
        }),
    messages: ['{"valid":true}', "{broken"].map((body, index) => ({
      id: `message-${index}`,
      timestamp: new Date(1000),
      attempts: 1,
      body,
      ack() {
        calls.push(`ack:${index}`);
      },
      retry(options: QueueRetryOptions) {
        calls.push(`retry:${index}:${options.delaySeconds ?? "default"}`);
      },
    })),
    ackAll() {
      calls.push("ackAll");
    },
    retryAll(options: QueueRetryOptions) {
      calls.push(`retryAll:${options.delaySeconds}`);
    },
  };
  const input =
    mode === "send" || mode === "send-batch" || mode === "metrics"
      ? producer
      : batch;
  const result: unknown = JSON.parse(
    await reactor.queueContract(mode, input, {}, context),
  );
  return Response.json({ result, calls });
}
