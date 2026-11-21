import assert from 'node:assert/strict';
import { SELF } from 'cloudflare:test';
import { test } from 'vitest';
import { jsonObject, jsonString, jsonValue } from '../../../../scripts/testing/Support/json.mts';

async function probe(
  command: string,
  scenario: string = '',
  format: string = 'image/png',
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({ case: scenario, format });
  const response = await SELF.fetch(
    `https://fixture.invalid/__fixture/images/${command}?${query}`,
    {
      method: 'POST',
      body: 'original image',
    },
  );

  assert.equal(response.status, 200);

  return jsonObject(await response.json());
}

const formats = [
  ['image/png', 'ImagePNG'],
  ['image/jpeg', 'ImageJPEG'],
  ['image/gif', 'ImageGIF'],
  ['image/webp', 'ImageWebP'],
  ['image/avif', 'ImageAVIF'],
  ['image/heic', 'ImageHEIC'],
  ['image/future', 'ImageOther "image/future"'],
];
for (const [mime, format] of formats) {
  test(`Images info preserves ${mime} metadata and receives the original stream`, async () => {
    const result = await probe('info', '', mime);

    assert.deepEqual(jsonValue(jsonString(result.body)), {
      kind: 'raster',
      format,
      fileSize: 9007199254740991,
      width: 13,
      height: 7,
    });
    assert.deepEqual(result.calls, [{ operation: 'info', input: 'original image' }]);
  });
}

test('Images accepts SVG without raster dimensions', async () => {
  const result = await probe('info', '', 'image/svg+xml');

  assert.deepEqual(jsonValue(jsonString(result.body)), { kind: 'svg' });
});

for (const format of ['png', 'jpeg', 'gif', 'webp', 'avif']) {
  for (const animation of ['preserve', 'first']) {
    test(`Images transforms to ${format} with ${animation} animation and streams the response`, async () => {
      const mime = `image/${format}`;
      const result = await probe(`${format}-${animation}`, '', mime);

      assert.equal(result.status, 200);
      assert.equal(result.contentType, mime);
      assert.deepEqual(result.bytes, [0, 255, 13, 10, 65]);
      assert.deepEqual(result.calls, [
        {
          operation: 'transform',
          input: 'original image',
          transforms: [
            { width: 13 },
            { height: 7 },
            { width: 13, height: 7 },
            { rotate: 0 },
            { rotate: 90 },
            { rotate: 180 },
            { rotate: 270 },
          ],
          options: { format: mime, anim: animation === 'preserve' },
        },
      ]);
    });
  }
}

for (const command of ['info', 'png-preserve']) {
  test(`Images ${command} preserves provider error details`, async () => {
    const result = await probe(command, 'provider');

    assert.deepEqual(jsonValue(jsonString(result.body)), {
      code: 9412,
      name: 'ImagesError',
      message: '画像を読み取れません',
    });
  });

  test(`Images ${command} preserves a thrown primitive without inventing fields`, async () => {
    const result = await probe(command, 'primitive');

    assert.deepEqual(jsonValue(jsonString(result.body)), {
      code: null,
      name: null,
      message: 'rejected',
    });
  });

  for (const scenario of ['invalid-code', 'hostile-error']) {
    test(`Images ${command} reports ${scenario} as a decode error`, async () => {
      const result = await probe(command, scenario);
      const failure = jsonObject(jsonValue(jsonString(result.body)));

      assert.equal(failure.name, 'ImagesBindingDecodeError');
      assert.equal(failure.code, null);
      assert.ok(jsonString(failure.message).startsWith('error'));
    });
  }
}

for (const scenario of [
  'no-format',
  'invalid-size',
  'unsafe-size',
  'invalid-width',
  'fractional-width',
  'invalid-height',
  'overflow-height',
  'missing-info',
  'hostile-info',
]) {
  test(`Images info rejects ${scenario} at the WASM binding boundary`, async () => {
    const result = await probe('info', scenario);
    const failure = jsonObject(jsonValue(jsonString(result.body)));

    assert.equal(failure.name, 'ImagesBindingDecodeError');
    assert.ok(jsonString(failure.message).startsWith('info'));
  });
}

for (const scenario of [
  'empty-content-type',
  'missing-content-type',
  'missing-image',
  'invalid-stream',
  'locked-stream',
  'hostile-output',
]) {
  test(`Images output rejects ${scenario} at the WASM binding boundary`, async () => {
    const result = await probe('png-preserve', scenario);
    const failure = jsonObject(jsonValue(jsonString(result.body)));

    assert.equal(failure.name, 'ImagesBindingDecodeError');
    assert.ok(jsonString(failure.message).startsWith('output'));
  });
}

test('Images preserves provider failures thrown by output methods', async () => {
  const result = await probe('png-preserve', 'image-throws');

  assert.deepEqual(jsonValue(jsonString(result.body)), {
    code: 9412,
    name: 'ImagesError',
    message: '画像を読み取れません',
  });
});
