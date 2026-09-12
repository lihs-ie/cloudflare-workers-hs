import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { wasmExports } from "./runtime.js";
export default defineWorker({
  queue(
    event: MessageBatch<unknown>,
    env: AggregationEnv,
    context: ExecutionContext,
  ): Promise<void> {
    return wasmExports.aggregation(event, env, context);
  },
});
