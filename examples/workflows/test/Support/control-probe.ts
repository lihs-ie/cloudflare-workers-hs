import { createFixtureReactor } from "./runtime";
export async function controlProbe(scenario: string): Promise<Response> {
  const scenarios: Record<
    string,
    {
      operation: string;
      state: string;
      failures: number;
      controlError?: string;
      statusError?: string;
      hang?: boolean;
    }
  > = {
    malformed: { operation: "pause", state: "paused", failures: 0 },
    paused: { operation: "pause", state: "paused", failures: 1 },
    delayed: { operation: "pause", state: "paused", failures: 3 },
    resumed: { operation: "resume", state: "running", failures: 1 },
    terminated: { operation: "terminate", state: "terminated", failures: 1 },
    restart: { operation: "restart", state: "queued", failures: 1 },
    success: { operation: "pause", state: "running", failures: 0 },
    persistent: { operation: "pause", state: "paused", failures: 100 },
    forbidden: {
      operation: "pause",
      state: "paused",
      failures: 1,
      controlError: "permission denied",
    },
    statusForbidden: {
      operation: "pause",
      state: "paused",
      failures: 1,
      statusError: "permission denied",
    },
    hanging: { operation: "pause", state: "paused", failures: 1, hang: true },
  };
  const selected = scenarios[scenario];
  if (!Object.hasOwn(scenarios, scenario)) {
    return new Response("Unknown scenario", { status: 400 });
  }
  let calls = 0;
  let reads = 0;
  const handle = {
    id: "control-test",
    async status() {
      reads += 1;
      if (reads <= selected.failures) {
        throw new Error(selected.statusError ?? "internal error");
      }
      if (selected.hang) {
        return new Promise<never>(() => {});
      }
      return { status: scenario === "malformed" ? 42 : selected.state };
    },
    async [selected.operation]() {
      calls += 1;
      if (selected.controlError) {
        throw new Error(selected.controlError);
      }
    },
  };
  const reactor = await createFixtureReactor();
  const result: unknown = JSON.parse(
    await reactor.workflowControlFixture(
      { get: async () => handle },
      selected.operation,
    ),
  );
  return Response.json({ result, calls, reads });
}
