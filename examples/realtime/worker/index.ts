import { DurableObject } from "cloudflare:workers";
import {
  initializeObject,
  runObject,
  defineWorker,
} from "@cloudflare-workers-hs/runtime";
import { reactor } from "./runtime";

export class ChatRoom extends DurableObject<Env> {
  constructor(context: DurableObjectState, env: Env) {
    super(context, env);
    initializeObject(context, () =>
      reactor.initializeRoom(context.storage, context),
    );
  }

  fetch(request: Request): Promise<Response> {
    return runObject(this.ctx, () =>
      reactor.roomFetch(
        this.ctx.storage,
        this.ctx,
        request,
        this.env,
        this.ctx,
      ),
    );
  }

  webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    return runObject(this.ctx, () =>
      reactor.roomMessage(
        this.ctx.storage,
        this.ctx,
        socket,
        message,
        this.env,
      ),
    );
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    clean: boolean,
  ): Promise<void> {
    return runObject(this.ctx, () =>
      reactor.roomClose(
        this.ctx.storage,
        socket,
        code,
        reason,
        clean,
        this.env,
      ),
    );
  }

  webSocketError(socket: WebSocket, _error: unknown): Promise<void> {
    return runObject(this.ctx, () =>
      reactor.roomClose(
        this.ctx.storage,
        socket,
        1011,
        "Socket failed",
        false,
        this.env,
      ),
    );
  }
}

export default defineWorker({
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    reactor.fetch(request, env, ctx),
});
