export async function inspectWorkersAI(
  request: Request,
  context: ExecutionContext,
  invoke: (
    request: Request,
    bindings: { AI: unknown },
    context: ExecutionContext,
  ) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const calls: { model: string; input: unknown; options: unknown }[] = [];

  const binding = {
    async run(
      model: string,
      input: unknown,
      options: unknown,
    ): Promise<unknown> {
      calls.push({ model, input, options });

      if (url.searchParams.get("failure") === "throw") {
        throw new Error("provider rejected");
      }

      if (url.searchParams.get("failure") === "schema") {
        throw new Error("JSON Mode couldn't be met");
      }

      if (url.searchParams.get("failure") === "malformed") {
        return { invalid: true };
      }

      if (url.pathname.endsWith("/structured-object")) {
        return { response: { city: "Kyoto" } };
      }

      if (url.pathname.endsWith("/structured-array")) {
        return { response: [3, 1, 2] };
      }

      return gemmaResponse(model, input);
    },
  };

  const result = await invoke(request, { AI: binding }, context);

  return Response.json({ outcome: await result.json(), calls });
}

function gemmaResponse(model: string, input: unknown): unknown {
  if (typeof input === "object" && input !== null && "prompt" in input) {
    return {
      id: "completion-1",
      object: "text_completion",
      choices: [{ index: 0, text: "answer" }],
    };
  }

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
}
