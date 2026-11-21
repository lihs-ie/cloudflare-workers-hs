import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';

const maximumSnapshot = 16 * 1024 * 1024;

async function requestBody(
  request: IncomingMessage,
  endpoint: string,
  maximumBytes: number,
): Promise<string> {
  const length = Number(request.headers['content-length']);
  if (
    request.method !== 'POST' ||
    request.url !== endpoint ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > maximumBytes
  ) {
    throw new Error('Invalid coverage upload');
  }

  let bytes = 0;
  const parts: Uint8Array[] = [];
  for await (const part of request) {
    if (!(part instanceof Uint8Array)) {
      throw new Error('Unexpected coverage upload bytes');
    }

    parts.push(part);
    bytes += part.length;

    if (bytes > length) {
      throw new Error('Invalid coverage upload length');
    }
  }

  if (bytes !== length) {
    throw new Error('Incomplete coverage upload');
  }

  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, bytes));
}

export async function withSnapshotServer<T>(
  receive: (body: string) => void,
  errors: string[],
  collect: (url: string) => Promise<T>,
  maximumBytes: number = maximumSnapshot,
): Promise<T> {
  const endpoint = '/' + randomUUID();
  const server = createServer({ requestTimeout: 10_000 }, (request, response) => {
    response.setHeader('Connection', 'close');
    void requestBody(request, endpoint, maximumBytes)
      .then((body) => {
        receive(body);
        response.writeHead(204).end();
      })
      .catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(400).end();
      });
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen({ host: '127.0.0.1', port: 0, backlog: 64 }, done);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Coverage collector has no bound port');
    }

    return await collect(`http://127.0.0.1:${address.port}${endpoint}`);
  } finally {
    await new Promise<void>((done, fail) =>
      server.close((error) => {
        if (error) {
          fail(error);
        } else {
          done();
        }
      }),
    );
  }
}
