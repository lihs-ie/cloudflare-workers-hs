import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  fetch(
    event: Request,
    env: ExportEnv,
    context: ExecutionContext,
  ): Promise<Response> {
    return wasmExports.exportApi(event, env, context);
  },
});
