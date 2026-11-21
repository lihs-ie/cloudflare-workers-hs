import { jsonValue } from '../../../../scripts/testing/Support/json.mts';
import coverageUpload from './coverage-upload';
import { roomProbe } from './room-probe';
import worker, { ChatRoom as ProductionRoom } from '../../worker/index';
import { reactor } from '../../worker/runtime';
export class ChatRoom extends ProductionRoom {
  /** Required by the native Alarm API used in storage transaction fixtures. */
  async alarm(): Promise<void> {
    throw new Error('Fixture alarms must be deleted before they fire');
  }
  probe(scenario: string): Promise<unknown> {
    return roomProbe(scenario, this.ctx, this.env);
  }
  corruptAttachment(mode: string): void {
    for (const socket of this.ctx.getWebSockets('chat')) {
      socket.serializeAttachment(mode === 'missing' ? null : 42);
    }
  }
}
export default {
  async fetch(
    request: Request,
    env: { ROOMS: DurableObjectNamespace<ChatRoom> },
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/__coverage/upload-failure') {
      return coverageUpload.fetch(request, env, ctx);
    }

    if (url.pathname === '/__room-probe') {
      return Response.json(
        await env.ROOMS.getByName(url.searchParams.get('room') ?? 'probe').probe(
          url.searchParams.get('scenario') ?? '',
        ),
      );
    }

    if (url.pathname === '/__attachment') {
      const room = url.searchParams.get('room');
      const mode = url.searchParams.get('mode');

      if (room === null || (mode !== 'missing' && mode !== 'wrong-type')) {
        return new Response('Invalid fixture input', { status: 400 });
      }

      await env.ROOMS.getByName(room).corruptAttachment(mode);
      return Response.json({ changed: true });
    }

    return worker.fetch(request, env, ctx);
  },
};
