import { reactor } from "./runtime";

export default {
  fetch(request: Request, env: { AI: Ai }, context: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    if (
      request.method !== "GET" ||
      (pathname !== "/__fixture/workers-ai/prompt" &&
        pathname !== "/__fixture/workers-ai/messages")
    ) {
      return new Response("Not found", { status: 404 });
    }
    return reactor.workersAIProbe(request, { AI: env.AI }, context);
  },
};
