import coverageUpload from "./coverage-upload";
import { roomProbe } from "./room-probe";
import worker, { ChatRoom as ProductionRoom } from "../../worker/index";
import { reactor } from "../../worker/runtime";
export class ChatRoom extends ProductionRoom {
  probe(scenario: string): Promise<unknown> {
    return roomProbe(scenario, this.ctx, this.env);
  }
  corruptAttachment(mode: string): void {
    for (const socket of this.ctx.getWebSockets("chat")) {
      socket.serializeAttachment(mode === "missing" ? null : 42);
    }
  }
  sqlChecks(): Promise<string> {
    return reactor.sqlChecks(this.ctx.storage);
  }
}
export default {
  async fetch(
    request: Request,
    env: { ROOMS: DurableObjectNamespace<ChatRoom> },
    ctx: ExecutionContext,
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/__coverage/upload-failure") {
      return coverageUpload.fetch(request, env, ctx);
    }
    if (url.pathname === "/__room-probe") {
      return Response.json(await env.ROOMS.getByName(url.searchParams.get("room") ?? "probe").probe(url.searchParams.get("scenario") ?? ""));
    }
    if (url.pathname === "/__attachment") {
      const room = url.searchParams.get("room");
      const mode = url.searchParams.get("mode");
      if (room === null || (mode !== "missing" && mode !== "wrong-type")) {
        return new Response("Invalid fixture input", { status: 400 });
      }
      await env.ROOMS.getByName(room).corruptAttachment(mode);
      return Response.json({ changed: true });
    }
    if (new URL(request.url).pathname === "/__upgrade") {
      return Response.json(JSON.parse(await reactor.upgradeChecks()));
    }
    if (new URL(request.url).pathname === "/__sql") {
      return Response.json(
        JSON.parse(await env.ROOMS.getByName("sql-fixture").sqlChecks()),
      );
    }
    return worker.fetch(request, env, ctx);
  },
};
