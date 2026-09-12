/** Isolated fault injection for the instrumented reactor's upload contract. */
import worker from "../../worker/entry";
import { createFixtureReactor } from "./runtime";
import { createWorkflowReactor } from "../../worker/runtime";

declare const WASM_COVERAGE_ENDPOINT: string;

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/__coverage/upload-failure") {
      return worker.fetch(request, env, context);
    }
    if (typeof WASM_COVERAGE_ENDPOINT !== "string") {
      return Response.json({ error: "WASM coverage instrumentation is required" }, { status: 409 });
    }
    const mode = new URL(request.url).searchParams.get("mode") ?? "production";
    if (mode === "fixture" || mode === "production-reactor") {
      let operations = 0;
      const binding = {
        get: async () => ({
          id: "coverage-upload-contract",
          pause: async () => { operations += 1; },
          status: async () => ({ status: "paused" }),
        }),
      };
      const invoke = mode === "fixture"
        ? await (async () => {
            const reactor = await createFixtureReactor();
            return async () => JSON.parse(await reactor.workflowControlFixture(binding, "pause"));
          })()
        : await (async () => {
            const reactor = await createWorkflowReactor();
            return async () => {
              operations += 1;
              const response = await reactor.fetch(new Request("https://coverage.test/health"), env, context);
              if (response.status !== 200) {
                throw new Error(`Unexpected health status: ${response.status}`);
              }
              return response.json();
            };
          })();
      const originalFetch = globalThis.fetch;
      let attempts = 0;
      let rejection;
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === WASM_COVERAGE_ENDPOINT) {
          attempts += 1;
          return new Response("Intentional coverage upload failure", { status: 503 });
        }
        return originalFetch(input, init);
      };
      try {
        await invoke();
      } catch (error) {
        rejection = error instanceof Error ? error.message : String(error);
      } finally {
        globalThis.fetch = originalFetch;
      }
      const recovered = await invoke();
      const confirmed = await invoke();
      return Response.json({ mode, rejected: rejection !== undefined, message: rejection, attempts, operations, recovered, confirmed });
    }
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === WASM_COVERAGE_ENDPOINT) {
        attempts += 1;
        return new Response("Intentional coverage upload failure", { status: 503 });
      }
      return originalFetch(input, init);
    };
    try {
      await worker.fetch(new Request("https://coverage.test/health"), env, context);
      return Response.json({ rejected: false, attempts });
    } catch (error) {
      return Response.json({
        rejected: true,
        attempts,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
};
