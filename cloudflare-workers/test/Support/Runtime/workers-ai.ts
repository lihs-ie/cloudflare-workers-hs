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
  const failure = url.searchParams.get("failure");
  const command = url.pathname.split("/").at(-1);
  let pulls = 0;

  const calls: { model: string; input: unknown; options: unknown }[] = [];

  const binding = {
    async run(
      model: string,
      input: unknown,
      options: unknown,
    ): Promise<unknown> {
      calls.push({ model, input, options });

      if (failure === "throw") {
        throw new Error("provider rejected");
      }

      if (failure === "schema") {
        throw new Error("JSON Mode couldn't be met");
      }

      if (failure === "malformed") {
        return { invalid: true };
      }

      if (url.pathname.endsWith("/structured-object")) {
        return { response: { city: "Kyoto" } };
      }

      if (url.pathname.endsWith("/structured-array")) {
        return { response: [3, 1, 2] };
      }

      if (command === "flux" || command === "flux-defaults") {
        return imageResponse("/9j/2Q==", failure);
      }

      if (command === "lucid" || command === "lucid-defaults") {
        return imageResponse("AQID", failure);
      }

      if (command === "phoenix" || command === "phoenix-defaults") {
        return phoenixResponse(() => {
          pulls += 1;
        });
      }

      return gemmaResponse(model, input);
    },
  };

  const result = await invoke(request, { AI: binding }, context);

  if (result.headers.get("content-type") === "application/octet-stream") {
    const headers = new Headers(result.headers);
    headers.set("x-fixture-ai-calls", JSON.stringify(calls));
    headers.set("x-fixture-stream-pulls", String(pulls));

    return new Response(result.body, { status: result.status, headers });
  }

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

function imageResponse(
  image: string,
  failure: string | null,
): { image: string | number } {
  if (failure === "bad-base64") {
    return { image: "not valid base64!" };
  }

  if (failure === "wrong-image-type") {
    return { image: 42 };
  }

  return { image };
}

function phoenixResponse(onPull: () => void): ReadableStream<Uint8Array> {
  const chunks = [Uint8Array.of(11, 22), Uint8Array.of(33, 44)];

  return new ReadableStream<Uint8Array>(
    {
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        onPull();

        const chunk = chunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }

        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
}
