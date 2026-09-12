import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  queue(
    event: MessageBatch<unknown>,
    env: RecoveryIngestEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return wasmExports.recoveryIngest(event, env, context);
  },
});
