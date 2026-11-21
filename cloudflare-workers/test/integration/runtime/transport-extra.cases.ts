import { jsonString } from '../../../../scripts/testing/Support/json.mts';
import { jsonArray, jsonObject, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { describe, expect, it } from 'vitest';
import { socketProbe, transportExtraProbe } from '../../../../tests/runtime/harness.js';

function source(): ReadableStream<ArrayBufferView> {
  return new ReadableStream({
    start(controller: ReadableStreamDefaultController<ArrayBufferView<ArrayBufferLike>>): void {
      controller.enqueue(new TextEncoder().encode('stream bytes'));
      controller.close();
    },
  });
}

export function registerTransportExtraCases(): void {
  describe('Public transport contracts', () => {
    it('observes socket metadata and typed failures through the public Socket API', async () => {
      const writes: string[] = [];
      function connect(): {
        readable: ReadableStream<ArrayBufferView<ArrayBufferLike>>;
        writable: WritableStream<ArrayBufferView<ArrayBufferLike>>;
        opened: Promise<{ remoteAddress: string; localAddress: string }>;
        closed: Promise<void>;
        close(): Promise<void>;
      } {
        return {
          readable: source(),
          writable: new WritableStream<ArrayBufferView>({
            write(value: ArrayBufferView<ArrayBufferLike>): void {
              writes.push(new TextDecoder().decode(value));
            },
          }),
          opened: Promise.resolve({ remoteAddress: 'remote:443', localAddress: 'local:123' }),
          closed: Promise.resolve(),
          close(): Promise<void> {
            return Promise.resolve();
          },
        };
      }
      expect(await transportExtraProbe(connect, 'socket-typed-error')).toEqual(['write succeeded']);
      expect(writes).toEqual(['payload']);
      expect(await transportExtraProbe(connect, 'socket-metadata')).toEqual([
        'Just "remote:443"',
        'Just "local:123"',
      ]);
      expect(
        (
          await transportExtraProbe(() => {
            throw new Error('connect refused');
          }, 'socket-connect-error')
        )[0],
      ).toContain('SocketConnectError');
    });

    it('propagates rejected TLS upgrades through public socket operations', async () => {
      function connect(): {
        readable: ReadableStream<ArrayBufferView<ArrayBufferLike>>;
        writable: WritableStream<ArrayBufferView<ArrayBufferLike>>;
        opened: Promise<{}>;
        closed: Promise<void>;
        close(): Promise<void>;
        startTls(): never;
      } {
        return {
          readable: source(),
          writable: new WritableStream<ArrayBufferView>(),
          opened: Promise.resolve({}),
          closed: Promise.resolve(),
          close(): Promise<void> {
            return Promise.resolve();
          },
          startTls(): never {
            throw new Error('tls upgrade rejected');
          },
        };
      }
      for (const mode of ['tls-use', 'tls-failure']) {
        expect(await socketProbe(connect, mode)).toEqual([
          'SocketError {socketErrorKind = SocketOtherError, socketErrorInformation = "Error: tls upgrade rejected"}',
        ]);
      }
    });

    it('roundtrips public HTTP methods, validates socket ports, and preserves Unicode', async () => {
      expect(await transportExtraProbe(null, 'methods')).toEqual([
        'GET',
        'POST',
        'PUT',
        'DELETE',
        'PATCH',
        'HEAD',
        'OPTIONS',
        'PROPFIND',
        'patch',
      ]);
      expect(await transportExtraProbe(null, 'ports')).toEqual([
        'Nothing',
        'Nothing',
        'Just 1',
        'Just 65535',
        'Nothing',
      ]);
      expect(await transportExtraProbe('日本語🌐\u0000', 'unicode')).toEqual(['日本語🌐\u0000']);
    });

    it('keeps public diagnostic collections and equality coherent', async () => {
      const observed = await transportExtraProbe(null, 'diagnostic-contracts');
      const names = observed.map((value) => jsonObject(jsonValue(value)).name);
      expect(names).toEqual([
        'http-method',
        'http-status',
        'http-body-placeholder',
        'socket-connect-exception',
        'socket-port',
        'socket-address',
        'socket-security',
        'socket-options',
        'socket-identifier',
        'socket-state',
        'socket-info',
        'socket-error-kind',
        'socket-error',
        'read-error',
        'emit-outcome',
        'producer-outcome',
      ]);
      for (const encoded of observed) {
        const value = jsonValue(encoded);
        expect(jsonObject(value).showListConsistent, jsonString(jsonObject(value).name)).toBe(true);
        expect(jsonObject(value).showsPrecConsistent, jsonString(jsonObject(value).name)).toBe(
          true,
        );
        expect(jsonObject(value).inequality, jsonString(jsonObject(value).name)).toEqual(
          jsonArray(jsonObject(value).equality).map((row) => jsonArray(row).map((equal) => !equal)),
        );
      }
    });

    it('rejects unsupported public fixture commands without poisoning the reactor', async () => {
      expect(await transportExtraProbe(null, 'unsupported')).toEqual([
        'user error (Unknown transport probe)',
      ]);
      expect(await transportExtraProbe('recovered', 'unicode')).toEqual(['recovered']);
    });
  });
}
