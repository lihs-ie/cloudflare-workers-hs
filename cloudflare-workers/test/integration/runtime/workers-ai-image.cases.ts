import { assert, test } from "vitest";
import {
  jsonObject,
  jsonString,
} from "../../../../scripts/testing/Support/json.mts";

type Setting = {
  model: string;
  input: {
    prompt: string;
    steps?: number;
    width?: number;
    height?: number;
    seed?: number;
    num_steps?: number;
  };
  options: {};
};

const flux: Setting = {
  model: "@cf/black-forest-labs/flux-1-schnell",
  input: { prompt: "A red bicycle", steps: 4 },
  options: {},
};

const lucid: Setting = {
  model: "@cf/leonardo/lucid-origin",
  input: {
    prompt: "A forest at dawn",
    steps: 12,
    width: 768,
    height: 512,
    seed: 3_000_000_000,
  },
  options: {},
};

const phoenix: Setting = {
  model: "@cf/leonardo/phoenix-1.0",
  input: {
    prompt: "A lighthouse at dusk",
    num_steps: 25,
    width: 1024,
    height: 768,
    seed: 7,
  },
  options: {},
};

export function registerWorkersAIImageCases(
  invoke: (command: string, query?: string) => Promise<Response>,
): void {
  test.each([
    ["flux", flux, "/9j/2Q==", [255, 216, 255, 217]],
    ["lucid", lucid, "AQID", [1, 2, 3]],
  ] as const)(
    "Workers AI %s preserves validated Base64 and decoded bytes",
    async (command, call, image, bytes) => {
      const result = jsonObject(await (await invoke(command)).json());

      assert.deepEqual(result.calls, [call]);
      assert.deepEqual(result.outcome, { image, bytes: [...bytes] });
    },
  );

  test.each([
    ["flux", flux],
    ["lucid", lucid],
    ["phoenix", phoenix],
  ] as const)(
    "Workers AI %s omits unset generation options",
    async (command, call) => {
      const response = await invoke(`${command}-defaults`);
      const calls: unknown =
        command === "phoenix"
          ? JSON.parse(response.headers.get("x-fixture-ai-calls") ?? "null")
          : jsonObject(await response.json()).calls;

      if (command === "phoenix") {
        await response.body?.cancel();
      }

      assert.deepEqual(calls, [
        { ...call, input: { prompt: call.input.prompt } },
      ]);
    },
  );

  test.each(["flux", "lucid", "phoenix"])(
    "Workers AI %s preserves provider error classification",
    async (command) => {
      const response = await invoke(command, "?failure=throw");

      assert.match(
        await failureMessage(response),
        /^WorkersAIException "provider rejected"/,
      );
    },
  );

  test.each(["malformed", "wrong-image-type", "bad-base64"])(
    "Workers AI rejects a %s image response",
    async (failure) => {
      const response = await invoke("flux", `?failure=${failure}`);

      assert.match(await failureMessage(response), /^WorkersAIInvalidResponse/);
    },
  );

  test("Workers AI rejects a seed that JavaScript cannot represent safely", async () => {
    const result = jsonObject(await (await invoke("lucid-unsafe-seed")).json());

    assert.deepEqual(result.calls, []);
    assert.match(
      jsonString(jsonObject(result.outcome).failure),
      /^WorkersAIInvalidInput/,
    );
  });

  test("Workers AI rejects a Phoenix response that is not a stream", async () => {
    const response = await invoke("phoenix", "?failure=malformed");

    assert.match(
      await failureMessage(response),
      /^WorkersAIInvalidResponse.*non-ReadableStream/,
    );
  });

  test("Workers AI forwards the Phoenix stream without reading it before the HTTP response", async () => {
    const response = await invoke("phoenix");

    assert.equal(
      response.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.equal(response.headers.get("x-fixture-stream-pulls"), "0");
    assert.deepEqual(
      JSON.parse(response.headers.get("x-fixture-ai-calls") ?? "null"),
      [phoenix],
    );
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      Uint8Array.of(11, 22, 33, 44),
    );
  });
}

async function failureMessage(response: Response): Promise<string> {
  const result = jsonObject(await response.json());

  return jsonString(jsonObject(result.outcome).failure);
}
