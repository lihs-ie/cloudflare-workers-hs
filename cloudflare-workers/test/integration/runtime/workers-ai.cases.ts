import { jsonArray, jsonObject, jsonString } from '../../../../scripts/testing/Support/json.mts';
import assert from 'node:assert/strict';
import { test } from 'vitest';

export function registerWorkersAICases({
  request,
}: {
  request: (path: string, method?: string) => Promise<unknown>;
}): void {
  const run = (command: string, query: string = ''): Promise<unknown> =>
    request(`/__fixture/workers-ai/${command}${query}`);

  test('Workers AI returns Gemma prompt text as a text completion', async () => {
    const result = await run('prompt');
    assert.deepEqual(jsonObject(result).calls, [
      {
        model: '@cf/google/gemma-4-26b-a4b-it',
        input: { prompt: 'hello', stream: false },
        options: {},
      },
    ]);
    assert.deepEqual(jsonObject(result).outcome, {
      ok: true,
      identifier: 'completion-1',
      object: 'text_completion',
      choices: [{ index: 0, text: 'answer' }],
    });
  });

  test('Workers AI passes a text conversation', async () => {
    const result = await run('messages');
    assert.deepEqual(jsonObject(jsonArray(jsonObject(result).calls)[0]).input, {
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
      stream: false,
    });
    assert.deepEqual(jsonObject(result).outcome, {
      ok: true,
      identifier: 'completion-1',
      object: 'chat.completion',
      choices: [
        { index: 0, content: 'answer' },
        { index: 1, content: null },
      ],
    });
  });

  test('Workers AI raises provider and malformed result failures', async () => {
    const provider = await run('prompt', '?failure=throw');
    assert.match(jsonString(jsonObject(jsonObject(provider).outcome).failure), /provider rejected/);

    const malformed = await run('prompt', '?failure=malformed');
    assert.match(
      jsonString(jsonObject(jsonObject(malformed).outcome).failure),
      /WorkersAIInvalidResponse/,
    );
  });
}
