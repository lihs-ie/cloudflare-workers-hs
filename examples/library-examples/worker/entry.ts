export { JobsState } from "./jobs-state.js";
import { consumeJobs } from "./jobs-consumer.js";
import { defineWorker } from "@cloudflare-workers-hs/runtime";
import { connect } from "cloudflare:sockets";
import { reactor } from "./runtime";
export default defineWorker({
  queue: consumeJobs,
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return reactor.fetch(request, { ...env, SOCKET_CONNECT: connect }, ctx);
  },
  tail(events: TraceItem[], env: Env, ctx: ExecutionContext) {
    return reactor.tail(events, env, ctx);
  },
});
