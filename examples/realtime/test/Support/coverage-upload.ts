/** Isolated fault injection for the instrumented reactor's upload contract. */
import worker from "../../worker/index";

declare const WASM_COVERAGE_ENDPOINT: string;

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname !== "/__coverage/upload-failure") {
      return worker.fetch(request, env, context);
    }
    if (typeof WASM_COVERAGE_ENDPOINT !== "string") {
      return Response.json({ error: "WASM coverage instrumentation is required" }, { status: 409 });
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
