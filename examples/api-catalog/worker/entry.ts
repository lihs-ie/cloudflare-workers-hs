import { defineWorker } from '@cloudflare-workers-hs/runtime';
import { connect } from 'cloudflare:sockets';
import { reactor } from './runtime';
export default defineWorker({
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return reactor.fetch(request, { ...env, SOCKET_CONNECT: connect }, ctx);
  },
  tail(events: TraceItem[], env: Env, ctx: ExecutionContext): Promise<void> {
    return reactor.tail(events, env, ctx);
  },
});
