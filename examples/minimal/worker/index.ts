import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { reactor } from "./runtime.js";
export default defineWorker({
  fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    return reactor.fetch(request, env, context);
  },
});
