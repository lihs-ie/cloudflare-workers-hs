import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  fetch(
    event: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    return wasmExports.fetch(event, env, context);
  },
});
