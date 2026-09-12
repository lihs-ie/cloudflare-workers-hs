import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  scheduled(
    event: ScheduledController,
    env: MaintenanceEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return wasmExports.maintenance(event, env, context);
  },
});
