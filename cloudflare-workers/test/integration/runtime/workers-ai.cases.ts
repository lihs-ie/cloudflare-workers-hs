import {
  jsonArray,
  jsonObject,
  jsonString,
} from "../../../../scripts/testing/Support/json.mts";
import assert from "node:assert/strict";
import { test } from "vitest";

export function registerWorkersAICases({
  request,
}: {
  request: (path: string, method?: string) => Promise<unknown>;
}): void {
  const run = (command: string, query: string = ""): Promise<unknown> =>
    request(`/__fixture/workers-ai/${command}${query}`);

  test("Workers AI returns Gemma prompt text as a text completion", async () => {
    const result = await run("prompt");
    assert.deepEqual(jsonObject(result).calls, [
      {
        model: "@cf/google/gemma-4-26b-a4b-it",
        input: { prompt: "hello", stream: false },
        options: {},
      },
    ]);
    assert.deepEqual(jsonObject(result).outcome, {
      ok: true,
      identifier: "completion-1",
      object: "text_completion",
      choices: [{ index: 0, text: "answer" }],
    });
  });

  test("Workers AI passes a text conversation", async () => {
    const result = await run("messages");
    assert.deepEqual(jsonObject(jsonArray(jsonObject(result).calls)[0]).input, {
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      stream: false,
    });
    assert.deepEqual(jsonObject(result).outcome, {
      ok: true,
      identifier: "completion-1",
      object: "chat.completion",
      choices: [
        { index: 0, content: "answer" },
        { index: 1, content: null },
      ],
    });
  });

  test("Workers AI requests a JSON object and returns the response value", async () => {
    const result = jsonObject(await run("structured-object"));

    assert.deepEqual(result.calls, [
      {
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        input: {
          messages: [
            { role: "system", content: "Use the supplied schema" },
            { role: "user", content: "Describe Kyoto" },
          ],
          stream: false,
          response_format: {
            type: "json_schema",
            json_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        },
        options: {},
      },
    ]);
    assert.deepEqual(result.outcome, { ok: true, response: { city: "Kyoto" } });
  });

  test("Workers AI preserves a JSON array response", async () => {
    const result = jsonObject(await run("structured-array"));

    assert.deepEqual(jsonObject(jsonArray(result.calls)[0]).input, {
      messages: [{ role: "user", content: "Return the rankings" }],
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { type: "array", items: { type: "integer" } },
      },
    });
    assert.deepEqual(result.outcome, { ok: true, response: [3, 1, 2] });
  });

  test("Workers AI distinguishes schema rejection from a missing structured response", async () => {
    const rejected = jsonObject(
      await run("structured-object", "?failure=schema"),
    );
    const malformed = jsonObject(
      await run("structured-object", "?failure=malformed"),
    );

    assert.match(
      jsonString(jsonObject(rejected.outcome).failure),
      /^WorkersAIException "JSON Mode couldn't be met"/,
    );
    assert.match(
      jsonString(jsonObject(malformed.outcome).failure),
      /^WorkersAIInvalidResponse/,
    );
  });

  test("Workers AI raises provider and malformed result failures", async () => {
    const provider = await run("prompt", "?failure=throw");
    assert.match(
      jsonString(jsonObject(jsonObject(provider).outcome).failure),
      /provider rejected/,
    );

    const malformed = await run("prompt", "?failure=malformed");
    assert.match(
      jsonString(jsonObject(jsonObject(malformed).outcome).failure),
      /WorkersAIInvalidResponse/,
    );
  });
}
