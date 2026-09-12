import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  queue(
    event: MessageBatch<unknown>,
    env: GenerationEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return wasmExports.quickstartGeneration(event, env, context);
  },
});
