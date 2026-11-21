import { createTLSFixture } from './tls-fixture.mts';
import { jsonObject } from '../../../../scripts/testing/Support/json.mts';
import net from 'node:net';
import tls from 'node:tls';

export interface SocketFixtures {
  certificate: string;
  variables: Record<
    | 'TCP_ADDRESS'
    | 'TLS_ADDRESS'
    | 'STARTTLS_ADDRESS'
    | 'UNTRUSTED_TLS_ADDRESS'
    | 'INTERRUPTED_TCP_ADDRESS',
    string
  >;
  close(): Promise<void>;
}

export async function startSocketFixtures(): Promise<SocketFixtures> {
  const credentials = await createTLSFixture();
  const cert = credentials.trusted.certificate;
  const key = credentials.trusted.key;
  const untrustedCert = credentials.untrusted.certificate;
  const untrustedKey = credentials.untrusted.key;
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
  };
  const echo = (socket: net.Socket): void => {
    track(socket);
    let input = Buffer.alloc(0);
    socket.on('data', (chunk: Uint8Array<ArrayBufferLike>) => {
      input = Buffer.concat([input, chunk]);

      if (input.length > 4096) {
        return socket.destroy();
      }

      if (input.includes(10)) {
        socket.end(input);
      }
    });
  };
  const plain = net.createServer(echo);
  const secure = tls.createServer({ cert, key }, echo);
  secure.on('tlsClientError', () => {});
  // This self-signed certificate is deliberately absent from NODE_EXTRA_CA_CERTS.
  const untrusted = tls.createServer({ cert: untrustedCert, key: untrustedKey }, echo);
  untrusted.on('tlsClientError', () => {});
  const interrupted = net.createServer((socket) => {
    track(socket);
    socket.once('data', () => socket.end('partial'));
  });
  const context = tls.createSecureContext({ cert, key });
  const upgrade = net.createServer((socket) => {
    track(socket);
    let input = Buffer.alloc(0);
    const prelude = (chunk: Uint8Array<ArrayBufferLike>): import('net').Socket | undefined => {
      input = Buffer.concat([input, chunk]);

      if (input.length > 4096) {
        return socket.destroy();
      }

      const newline = input.indexOf(10);

      if (newline < 0) {
        return;
      }

      if (input.subarray(0, newline + 1).toString() !== 'STARTTLS\n') {
        return socket.destroy();
      }

      socket.removeListener('data', prelude);
      socket.pause();
      const remaining = input.subarray(newline + 1);

      if (remaining.length) {
        socket.unshift(remaining);
      }

      const wrapped = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
      echo(wrapped);
      wrapped.resume();
    };
    socket.on('data', prelude);
  });
  const servers = [plain, secure, upgrade, untrusted, interrupted];
  try {
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
  } catch (error) {
    for (const server of servers) {
      server.close();
    }
    await credentials.close();
    throw error;
  }
  return {
    certificate: credentials.trusted.authority,
    variables: {
      TCP_ADDRESS: `127.0.0.1:${port(plain)}`,
      TLS_ADDRESS: `localhost:${port(secure)}`,
      STARTTLS_ADDRESS: `localhost:${port(upgrade)}`,
      UNTRUSTED_TLS_ADDRESS: `localhost:${port(untrusted)}`,
      INTERRUPTED_TCP_ADDRESS: `127.0.0.1:${port(interrupted)}`,
    },
    async close(): Promise<void> {
      for (const socket of sockets) {
        socket.destroy();
      }
      try {
        await Promise.all(
          servers.map(
            (server) =>
              new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
              ),
          ),
        );
      } finally {
        await credentials.close();
      }
    },
  };
}

function port(server: net.Server): number {
  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Expected an active TCP listener');
  }

  return address.port;
}
