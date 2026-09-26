import { reactor } from "./runtime";

export async function inspectWorkersAI(
  request: Request,
  context: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const calls: { model: string; input: unknown; options: unknown }[] = [];

  const binding = {
    async run(model: string, input: unknown, options: unknown) {
      calls.push({ model, input, options });
      if (url.searchParams.get("failure") === "throw")
        throw new Error("provider rejected");

      if (url.searchParams.get("failure") === "malformed")
        return { invalid: true };

      return {
        id: "completion-1",
        object: "chat.completion",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "answer", refusal: null },
            finish_reason: "stop",
            logprobs: null,
          },
          {
            index: 1,
            message: { role: "assistant", content: null, refusal: null },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
      };
    },
  };

  const result = await reactor.workersAIProbe(
    request,
    { AI: binding },
    context,
  );

  return Response.json({ outcome: await result.json(), calls });
}
