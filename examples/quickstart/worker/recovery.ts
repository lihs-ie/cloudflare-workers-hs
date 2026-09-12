import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  fetch(
    event: Request,
    env: RecoveryEnv,
    context: ExecutionContext,
  ): Promise<Response> {
    return wasmExports.recovery(event, env, context);
  },
});
