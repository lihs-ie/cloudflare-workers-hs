import { expect, it } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { workflowBoundaryExtraProbe } from "../../../Support/Runtime/harness.js";

const probe = async (raw: unknown, config: Record<string, unknown>) =>
  JSON.parse(
    await workflowBoundaryExtraProbe(
      raw,
      NonRetryableError,
      JSON.stringify(config),
    ),
  );

export function registerWorkflowBoundaryExtraCases(): void {
  it("reports typed sendEvent failures and recovers with the same instance", async () => {
    const events: unknown[] = [];
    const instance = { id: "boundary", sendEvent(event: unknown) {
      events.push(event);
      if (events.length === 1) {
        throw new Error("event unavailable");
      }
    } };
    const binding = { get: () => instance };
    const rejected = await probe(binding, { operation: "send-event" });
    expect(rejected.ok).toBe(true);
    expect(rejected.value.operation).toBe("sendEvent");
    expect(rejected.value.message).toContain("event unavailable");
    expect(await probe(binding, { operation: "send-event" })).toEqual({ ok: true, value: true });
    expect(events).toEqual([{ type: "ready", payload: 7 }, { type: "ready", payload: 7 }]);
  });
  it("renders and compares decoded workflow failure diagnostics", async () => {
    const result = await probe({}, { operation: "failure-diagnostics" });
    expect(result.ok).toBe(true);
    expect(result.value.diagnostic).toContain("WorkflowFailure");
    expect(result.value).toMatchObject({ name: "ValidationError", message: "invalid input", matches: true, different: true });
    expect(result.value.rendered).toContain('workflowFailureName = "ValidationError"');
  });
  it("orders workflow identifiers for deterministic batch diagnostics", async () => {
    const result = await probe({}, { operation: "identifier-order" });
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ ordered: ["job-a", "job-b", "job-c"], first: "job-a", last: "job-c" });
    expect(result.value.diagnostic).toContain('unWorkflowIdentifier = "job-a"');
  });
  it("uses complete default options and observes lifecycle completion", async () => {
    let options: unknown;
    expect(
      await probe(
        {
          do: async (_name: string, config: unknown) => {
            options = config;
            return 1;
          },
        },
        { operation: "defaults" },
      ),
    ).toEqual({ ok: true, value: 1 });
    expect(options).toEqual({
      retries: { limit: 5, delay: 1000, backoff: "exponential" },
      timeout: 60000,
    });
    const calls: unknown[] = [];
    const instance = {
      id: "boundary",
      sendEvent: async (event: unknown) => {
        calls.push(event);
      },
      pause: async () => {
        calls.push("pause");
      },
      resume: async () => {
        calls.push("resume");
      },
      restart: async () => {
        calls.push("restart");
      },
      terminate: async () => {
        calls.push("terminate");
      },
    };
    expect(
      await probe(
        {
          create: async (config: unknown) => {
            calls.push(config);
            return instance;
          },
        },
        { operation: "lifecycle" },
      ),
    ).toEqual({ ok: true, value: "boundary" });
    expect(calls).toEqual([
      { params: { input: 7 }, id: "boundary" },
      { type: "ready", payload: 7 },
      "pause",
      "resume",
      "restart",
      "terminate",
    ]);
    const failure = await probe(
      {
        create: async () => {
          throw new Error("create failed");
        },
      },
      { operation: "lifecycle" },
    );
    expect(failure.ok).toBe(false);
    expect(failure.message).toContain("create failed");
  });
  it("rejects invalid names, retry limits and unsafe durations before native calls", async () => {
    let calls = 0;
    const raw = {
      do() {
        calls++;
        throw new Error("unexpected native call");
      },
    };
    for (const config of [
      { name: "" },
      { name: "x".repeat(257) },
      { retry: -1 },
      { duration: -1 },
      { duration: 9007199254740992 },
    ]) {
      const result = await probe(raw, { operation: "do", ...config });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/step name|negative retry|safe integer/);
    }
    expect(calls).toBe(0);
    expect(
      await probe(
        { do: async () => 17 },
        { operation: "do", name: "x".repeat(256) },
      ),
    ).toEqual({ ok: true, value: 17 });
  });

  it("decodes cached outputs and rejects incompatible output or callback context", async () => {
    expect(await probe({ do: async () => 23 }, { operation: "do" })).toEqual({
      ok: true,
      value: 23,
    });
    const badOutput = await probe(
      { do: async () => "not an integer" },
      { operation: "do" },
    );
    expect(badOutput.ok).toBe(false);
    expect(badOutput.message).toContain("step.do");
    for (const context of [
      null,
      {},
      { step: {} },
      { step: { name: "n", count: "bad" }, attempt: 1 },
      { step: { name: "n", count: 2 } },
    ]) {
      const result = await probe(
        {
          do: async (
            _name: string,
            _options: unknown,
            callback: (context: unknown) => Promise<unknown>,
          ) => callback(context),
        },
        { operation: "do" },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("step.context");
    }
    const recovered = await probe(
      {
        do: async (
          _name: string,
          _options: unknown,
          callback: (context: unknown) => Promise<unknown>,
        ) => callback({ step: { name: "n", count: 2 }, attempt: 3 }),
      },
      { operation: "do" },
    );
    expect(recovered).toEqual({ ok: true, value: 8 });
  });

  it("preserves native failure and accepts safe-integer sleep endpoints", async () => {
    for (const operation of ["sleep", "sleepUntil", "event", "do"]) {
      const raw = {
        sleep: async () => {
          throw new Error("native boundary failure");
        },
        sleepUntil: async () => {
          throw new Error("native boundary failure");
        },
        waitForEvent: async () => {
          throw new Error("native boundary failure");
        },
        do: async () => {
          throw new Error("native boundary failure");
        },
      };
      const result = await probe(raw, { operation });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("native boundary failure");
    }
    for (const operation of ["sleep", "sleepUntil"]) {
      const calls: unknown[][] = [];
      const raw = {
        [operation]: async (...args: unknown[]) => {
          calls.push(args);
        },
      };
      for (const duration of [0, 9007199254740991]) {
        expect(await probe(raw, { operation, duration })).toEqual({
          ok: true,
          value: true,
        });
      }
      expect(calls).toEqual([
        ["boundary", 0],
        ["boundary", 9007199254740991],
      ]);
    }
  });

  it("validates received event fields and retains typed event data", async () => {
    for (const event of [
      null,
      {},
      { payload: "bad", type: "ready", timestamp: "now" },
      { payload: 1, timestamp: "now" },
      { payload: 1, type: "ready", timestamp: 1 },
    ]) {
      const result = await probe(
        { waitForEvent: async () => event },
        { operation: "event" },
      );
      expect(result.ok).toBe(false);
      expect(result.message).toContain("waitForEvent");
    }
    const event = {
      payload: 7,
      type: "ready",
      timestamp: "2026-09-12T00:00:00Z",
    };
    expect(
      await probe({ waitForEvent: async () => event }, { operation: "event" }),
    ).toEqual({ ok: true, value: event });
  });

  it("parses all status states and rejects malformed status and failure fields", async () => {
    for (const [status, state] of Object.entries({
      queued: "WorkflowQueued",
      running: "WorkflowRunning",
      paused: "WorkflowPaused",
      errored: "WorkflowErrored",
      terminated: "WorkflowTerminated",
      complete: "WorkflowComplete",
      waiting: "WorkflowWaiting",
      waitingForPause: "WorkflowWaitingForPause",
      future: 'WorkflowUnknown "future"',
    })) {
      const raw = {
        get: async () => ({
          id: "boundary",
          status: async () => ({ status, output: 4 }),
        }),
      };
      expect(await probe(raw, { operation: "status" })).toEqual({
        ok: true,
        value: { state, output: 4, failure: null },
      });
    }
    for (const status of [
      null,
      {},
      { status: 1 },
      { status: "complete", output: "bad" },
      { status: "errored", error: {} },
      { status: "errored", error: { name: "Error", message: 1 } },
    ]) {
      const raw = {
        get: async () => ({ id: "boundary", status: async () => status }),
      };
      const result = await probe(raw, { operation: "status" });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("status");
    }
    const raw = {
      get: async () => ({
        id: "boundary",
        status: async () => ({
          status: "errored",
          error: { name: "Error", message: "failure" },
        }),
      }),
    };
    const result = await probe(raw, { operation: "status" });
    expect(result.ok).toBe(true);
    expect(result.value.failure).toContain("failure");
  });
}
