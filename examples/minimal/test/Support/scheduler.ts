/** Test-only CPU work: trigger RTS yields without exceeding HTTP URL limits. */
import worker from "../../worker/index.js";

export default {
  fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/__scheduler/yield") {
      const internal = new Request(`https://scheduler.test/${"a/".repeat(500_000)}`);
      return worker.fetch(internal, env, context);
    }
    return worker.fetch(request, env, context);
  },
};
