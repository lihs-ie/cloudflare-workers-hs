interface ImageTransformer {
  transform(options: unknown): ImageTransformer;
  output(options: unknown): Promise<unknown>;
}

function providerFailure(scenario: string): void {
  if (scenario === 'provider') {
    throw Object.assign(new Error('画像を読み取れません'), { code: 9412, name: 'ImagesError' });
  }

  if (scenario === 'primitive') {
    throw 'rejected';
  }

  if (scenario === 'invalid-code') {
    throw { code: 1.5 };
  }

  if (scenario === 'hostile-error') {
    throw Object.defineProperty({}, 'code', {
      get(): never {
        throw new Error('unreadable');
      },
    });
  }
}

function infoResult(scenario: string, format: string): unknown {
  const raster = { format, fileSize: 9007199254740991, width: 13, height: 7 };
  const invalid: Record<string, unknown> = {
    'no-format': { ...raster, format: '' },
    'invalid-size': { ...raster, fileSize: -1 },
    'unsafe-size': { ...raster, fileSize: 9007199254740992 },
    'invalid-width': { ...raster, width: 0 },
    'fractional-width': { ...raster, width: 1.5 },
    'invalid-height': { ...raster, height: 0 },
    'overflow-height': { ...raster, height: 2147483648 },
    'missing-info': null,
  };

  if (scenario === 'hostile-info') {
    return Object.defineProperty({}, 'format', {
      get(): never {
        throw new Error('unreadable');
      },
    });
  }

  return scenario in invalid ? invalid[scenario] : raster;
}

function outputResult(scenario: string, contentType: string): unknown {
  const stream = new Response(new Uint8Array([0, 255, 13, 10, 65])).body;
  const result = {
    contentType(): unknown {
      if (this !== result) {
        throw new Error('lost output receiver');
      }

      return scenario === 'empty-content-type' ? '' : contentType;
    },
    image(): unknown {
      if (this !== result) {
        throw new Error('lost output receiver');
      }

      if (scenario === 'image-throws') {
        providerFailure('provider');
      }

      return scenario === 'invalid-stream' ? {} : stream;
    },
  };

  if (scenario === 'missing-content-type') {
    return { image: result.image };
  }

  if (scenario === 'missing-image') {
    return { contentType: result.contentType };
  }

  if (scenario === 'hostile-output') {
    return Object.defineProperty({}, 'contentType', {
      get(): never {
        throw new Error('unreadable');
      },
    });
  }

  if (scenario === 'locked-stream' && stream !== null) {
    stream.getReader();
  }

  return result;
}

export async function inspectImages(
  request: Request,
  context: ExecutionContext,
  invoke: (
    request: Request,
    bindings: { IMAGES: unknown },
    context: ExecutionContext,
  ) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  const scenario = url.searchParams.get('case') ?? '';
  const format = url.searchParams.get('format') ?? 'image/png';
  const calls: unknown[] = [];
  const binding = {
    async info(stream: ReadableStream): Promise<unknown> {
      calls.push({ operation: 'info', input: await new Response(stream).text() });
      providerFailure(scenario);

      return infoResult(scenario, format);
    },
    input(stream: ReadableStream): ImageTransformer {
      const transforms: unknown[] = [];
      const transformer = (): ImageTransformer => ({
        transform(options: unknown): ImageTransformer {
          transforms.push(options);

          return transformer();
        },
        async output(options: unknown): Promise<unknown> {
          calls.push({
            operation: 'transform',
            input: await new Response(stream).text(),
            transforms,
            options,
          });
          providerFailure(scenario);

          return outputResult(scenario, format);
        },
      });

      return transformer();
    },
  };
  const result = await invoke(request, { IMAGES: binding }, context);

  const bytes = new Uint8Array(await result.arrayBuffer());

  return Response.json({
    status: result.status,
    contentType: result.headers.get('content-type'),
    body: new TextDecoder().decode(bytes),
    bytes: Array.from(bytes),
    calls,
  });
}
