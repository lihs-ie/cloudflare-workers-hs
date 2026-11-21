import { jsonObject } from '../../../../scripts/testing/Support/json.mts';
import { jsonValue } from '../../../../scripts/testing/Support/json.mts';
type Invoke = (request: Request, bindings: Record<string, unknown>) => Promise<Response>;

/** Inject failures at native capability boundaries while running the real application. */
export async function miscExampleFixture(
  request: Request,
  env: Record<string, unknown>,
  invoke: Invoke,
  supportSocket?: (connector: () => object, scenario: string) => Promise<string>,
  supportStorage?: (namespace: object, mode: string) => Promise<string>,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const prefix = '/__fixture/misc/';

  if (!url.pathname.startsWith(prefix)) {
    return undefined;
  }

  const scenario = url.pathname.slice(prefix.length);
  const configured = { ...env };
  let path: string;

  if (scenario === 'configuration') {
    configured.EXAMPLE_MODE = url.searchParams.get('mode') ?? '';
    configured.EXAMPLE_SECRET = url.searchParams.get('secret') ?? '';
    path = '/configuration';
  } else if (scenario === 'storage') {
    const mode = url.searchParams.get('mode');
    configured.SETTINGS = {
      async put(): Promise<void> {},
      async delete(): Promise<void> {},
      async get(key: string): Promise<ReadableStream<Uint8Array<ArrayBufferLike>> | null> {
        if (key === 'formats:json') {
          return null;
        }

        if (key === 'formats:binary') {
          return null;
        }

        if (mode === 'missing-stream') {
          return null;
        }

        return new ReadableStream<Uint8Array>({
          start(controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>): void {
            if (mode === 'stream-error') {
              controller.error(new Error('misc-secret-stream-failure'));
            } else {
              controller.enqueue(
                mode === 'oversized'
                  ? new Uint8Array(1025)
                  : new TextEncoder().encode('stream value'),
              );
              controller.close();
            }
          },
        });
      },
    };
    path = '/storage/formats';
  } else if (scenario === 'service') {
    configured.GUIDE = {
      async fetch(target: Request): Promise<Response> {
        const route = new URL(target.url).pathname;

        if (route === '/health') {
          return Response.json({ status: 'ok' });
        }

        if (route === '/echo') {
          return Response.json(await target.json());
        }

        // An upstream deployment changed its conflict endpoint contract.
        return Response.json({ unexpectedSuccess: true });
      },
    };
    path = '/service';
  } else if (scenario === 'database') {
    const database = env.CATALOG_DB;

    if (typeof database !== 'object' || database === null) {
      return new Response('Missing database', { status: 500 });
    }

    const wrapStatement = (statement: object): object =>
      new Proxy(statement, {
        get(target: object, property: string | symbol): unknown {
          const original: unknown = Reflect.get(target, property);

          if (typeof original !== 'function') {
            return original;
          }

          if (property === 'bind') {
            return (...values: unknown[]) =>
              wrapStatement(jsonObject(Reflect.apply(original, target, values)));
          }

          if (property === 'first') {
            return async (...values: unknown[]): Promise<unknown> => {
              const exec: unknown = Reflect.get(database, 'exec');

              if (typeof exec !== 'function') {
                throw new Error('Missing database exec');
              }

              // Model a concurrent actor deleting the seeded record between write and read.
              await Reflect.apply(exec, database, [
                "DELETE FROM example_catalog WHERE identifier='guide'",
              ]);
              return Reflect.apply(original, target, values);
            };
          }

          return (...values: unknown[]): unknown => Reflect.apply(original, target, values);
        },
      });
    configured.CATALOG_DB = new Proxy(database, {
      get(target: object, property: string | symbol): unknown {
        const original: unknown = Reflect.get(target, property);

        if (typeof original !== 'function') {
          return original;
        }

        if (property === 'prepare') {
          return (...values: unknown[]) =>
            wrapStatement(jsonObject(Reflect.apply(original, target, values)));
        }

        return (...values: unknown[]): unknown => Reflect.apply(original, target, values);
      },
    });
    path = '/database/catalog';
  } else if (scenario === 'storage-refusal' && supportStorage) {
    const namespace = env.SETTINGS;

    if (typeof namespace !== 'object' || namespace === null) {
      return new Response('Missing KV', { status: 500 });
    }

    const controlled = new Proxy(namespace, {
      get(target: object, property: string | symbol): unknown {
        const original: unknown = Reflect.get(target, property);

        if (typeof original !== 'function') {
          return original;
        }

        return (...args: unknown[]): unknown => {
          if (property === 'list') {
            const options = args[0];

            if (typeof options === 'object' && options !== null) {
              const limit: unknown = Reflect.get(options, 'limit');
              const cursor: unknown = Reflect.get(options, 'cursor');

              if (limit === 0 || limit === -1 || cursor === '!not-base64!') {
                return Promise.reject(new Error('native list validation refusal'));
              }
            }
          }

          return Reflect.apply(original, target, args);
        };
      },
    });
    return Response.json(jsonValue(await supportStorage(controlled, 'validation')));
  } else if (scenario === 'socket' || scenario === 'support-socket') {
    const mode = url.searchParams.get('mode') ?? 'success';
    path = url.searchParams.get('path') ?? '/tcp-structured';

    if (!['/tcp', '/tcp-structured', '/tls', '/starttls'].includes(path)) {
      return new Response('Invalid socket path', { status: 400 });
    }

    configured.TCP_ADDRESS = url.searchParams.get('address') ?? 'fixture.invalid:1234';
    const calls: string[] = [];
    const makeSocket = (
      upgraded: boolean,
    ): {
      opened: Promise<{ remoteAddress: string }>;
      closed: Promise<void>;
      readable: ReadableStream<Uint8Array<ArrayBufferLike>>;
      writable: WritableStream<Uint8Array<ArrayBufferLike>>;
      close(): Promise<void>;
      startTls(): object;
    } => {
      calls.push('connect');
      const failure = (): Error => new Error('misc-secret-socket-failure');
      let settle!: () => void;
      let rejectClosed!: (reason: Error) => void;
      const closed = new Promise<void>((resolve, reject) => {
        settle = resolve;
        rejectClosed = reject;
      });
      const socket = {
        opened:
          mode === 'opened' || (upgraded && mode === 'upgraded-opened')
            ? Promise.reject(failure())
            : Promise.resolve({ remoteAddress: 'fixture.invalid:1234' }),
        closed,
        readable: new ReadableStream<Uint8Array>({
          start(controller: ReadableStreamDefaultController<Uint8Array<ArrayBufferLike>>): void {
            if (mode === 'read') {
              controller.error(failure());
            } else {
              controller.enqueue(
                (() => {
                  if (mode === 'utf8') {
                    return new Uint8Array([255]);
                  }

                  if (mode === 'oversized') {
                    return new Uint8Array(4097);
                  }

                  return new TextEncoder().encode('fixture greeting\n');
                })(),
              );
              controller.close();
            }
          },
        }),
        writable: new WritableStream<Uint8Array>({
          write(): void {
            calls.push('write');

            if (mode === 'write') {
              throw failure();
            }
          },
          close(): void {
            calls.push('finish');

            if (mode === 'finish') {
              throw failure();
            }
          },
        }),
        async close(): Promise<void> {
          calls.push('close');

          if (mode === 'closed') {
            rejectClosed(failure());
          } else {
            settle();
          }

          if (mode === 'close') {
            throw failure();
          }
        },
        startTls(): object {
          calls.push('startTls');

          if (mode === 'upgraded-opened') {
            return makeSocket(true);
          }

          throw failure();
        },
      };
      void socket.opened.catch(() => {});
      void closed.catch(() => {});
      return socket;
    };
    const connector = (): {
      opened: Promise<{ remoteAddress: string }>;
      closed: Promise<void>;
      readable: ReadableStream<Uint8Array<ArrayBufferLike>>;
      writable: WritableStream<Uint8Array<ArrayBufferLike>>;
      close(): Promise<void>;
      startTls(): object;
    } => makeSocket(false);
    configured.SOCKET_CONNECT = connector;

    if (scenario === 'support-socket' && supportSocket) {
      return Response.json({
        outcome: jsonValue(
          await supportSocket(connector, url.searchParams.get('case') ?? 'unknown'),
        ),
        calls,
      });
    }

    const result = await invoke(new Request(new URL(path, url)), configured);
    return Response.json({ status: result.status, body: await result.text(), calls });
  } else {
    return new Response('Unknown misc fixture', { status: 400 });
  }
  return invoke(new Request(new URL(path, url), request), configured);
}
