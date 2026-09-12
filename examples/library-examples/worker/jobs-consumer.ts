import { reactor } from "./runtime.js";

/** Haskell owns JSON decoding and per-message settlement after durable commit. */
export async function consumeJobs(
  batch: MessageBatch<unknown>,
  env: Env,
  context: ExecutionContext,
): Promise<void> {
  await reactor.queue(batch, env, context);
}
