import { expect, it } from "vitest";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";

type Probe = (batch: unknown, environment: unknown, context: ExecutionContext, control: { isReady: () => boolean; unblock: () => void }) => Promise<string>;

export function registerGenerationAsyncCases(probe: Probe): void {
  it("preserves genuine asynchronous cancellation at exhausted generation attempts", async () => {
    let reachedDatabase = false;
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const calls: string[] = [];
    const environment = {
      DB: {
        prepare(sql: string) {
          calls.push(sql);
          return { bind() { return this; } };
        },
        async batch() {
          reachedDatabase = true;
          await blocked;
          return [{ success: true, results: [], meta: {} }, { success: true, results: [], meta: {} }];
        },
      },
      COORDINATOR: {
        idFromName() { return "coordinator"; },
        getByName() {
          return { async fetch(input: Request) {
            const path = new URL(input.url).pathname;
            calls.push(path);
            if (path === "/release") {
              return new Response(null, { status: 204 });
            }
            return Response.json({ export: "cancelled-export", token: "lease-token", expiresAt: 9999999999999 });
          } };
        },
      },
      CLICKS: {}, EXPORT_QUEUE: {}, EXPORTS: {},
      ACCESS_TEAM: "team", ACCESS_AUDIENCE: "audience", ACCESS_JWKS_URL: "https://example.test/jwks",
    };
    const batch = createMessageBatch("exports", [{ id: "cancelled-message", timestamp: new Date(), attempts: 4, body: { identifier: "cancelled-export" } }]);
    const context = createExecutionContext();
    const control = { isReady: () => reachedDatabase, unblock: () => { unblock?.(); } };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        probe(batch, environment, context, control),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => { reject(new Error("Haskell cancellation did not complete")); }, 5000);
        }),
      ]);
      expect(outcome).toBe("asynchronous");
      expect(calls).toContain("/release");
      expect(calls.some((sql) => sql.includes("last_error"))).toBe(false);
      const settlement = await getQueueResult(batch, context);
      expect(settlement.explicitAcks).toHaveLength(0);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      unblock?.();
    }
  });
}
