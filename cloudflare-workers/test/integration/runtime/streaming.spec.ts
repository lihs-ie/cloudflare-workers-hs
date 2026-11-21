import assert from 'node:assert/strict';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { test } from 'vitest';
import { streamingProbe } from '../../../../tests/runtime/harness.js';
import { jsonObject, jsonString } from '../../../../scripts/testing/Support/json.mts';

async function probe(
  command: string,
  body?: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>> {
  const context = createExecutionContext();
  const request = new Request(
    `https://fixture.invalid/__fixture/stream/${command}`,
    body === undefined ? {} : { method: 'POST', body },
  );
  const response = await streamingProbe(request, context);
  await waitOnExecutionContext(context);

  assert.equal(request.body?.locked ?? false, false);

  return jsonObject(await response.json());
}

for (const command of ['negative-limit', 'byte-limit']) {
  test(`Stream ${command} awaits upstream cancellation and releases the reader`, async () => {
    const events: string[] = [];
    const body = new ReadableStream<Uint8Array>({
      pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      async cancel(): Promise<void> {
        await Promise.resolve();
        events.push('cancelled');
      },
    });

    const result = await probe(command, body);

    assert.equal(result.rejected, 'ReadableStreamExceededByteLimit');
    assert.deepEqual(events, ['cancelled']);
    assert.equal(body.locked, false);
  });
}

for (const command of ['fixed-negative', 'fixed-unsafe']) {
  test(`Stream ${command} rejects before acquiring a reader`, async () => {
    const body = new ReadableStream<Uint8Array>();

    const result = await probe(command, body);

    assert.match(jsonString(result.failure), /Invalid fixed stream byte length/);
    assert.equal(body.locked, false);
    await body.cancel();
  });
}

test('Stream source read errors release the reader and do not poison subsequent calls', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.error(new Error('upstream read failed'));
    },
  });

  const failed = await probe('read-failure', body);
  const recovered = await probe('producer-complete');

  assert.match(jsonString(failed.failure), /upstream read failed/);
  assert.equal(body.locked, false);
  assert.deepEqual(recovered.bytes, Array.from(new TextEncoder().encode('recovered')));
});

test('Stream producer exceptions reach the consumer and the reactor remains usable', async () => {
  const failed = await probe('producer-throw');
  const recovered = await probe('producer-complete');

  assert.match(jsonString(failed.failure), /producer exploded/);
  assert.deepEqual(recovered.bytes, Array.from(new TextEncoder().encode('recovered')));
});

test('Stream fixed length preserves binary bytes and releases the upstream reader', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller: ReadableStreamDefaultController<Uint8Array>): void {
      controller.enqueue(new Uint8Array([0, 255]));
      controller.close();
    },
  });

  const result = await probe('fixed-valid', body);

  assert.deepEqual(result.bytes, [0, 255]);
  assert.equal(body.locked, false);
});

test('Stream explicit cancellation reports an upstream rejection without retaining a lock', async () => {
  const body = new ReadableStream<Uint8Array>({
    cancel(): never {
      throw new Error('upstream cancellation failed');
    },
  });

  const result = await probe('cancel', body);

  assert.match(jsonString(result.failure), /upstream cancellation failed/);
  assert.equal(body.locked, false);
});
