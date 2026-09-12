import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  fetch(
    event: Request,
    env: ManagementEnv,
    context: ExecutionContext,
  ): Promise<Response> {
    return wasmExports.management(event, env, context);
  },
});
