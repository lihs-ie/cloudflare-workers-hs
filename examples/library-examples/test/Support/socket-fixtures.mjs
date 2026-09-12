import net from "node:net";
import tls from "node:tls";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Public test-only key, never used for a deployed service. Certificate checking
// remains enabled; only this explicit CA is trusted by the local dev process.
export const certificate = fileURLToPath(new URL("./Fixtures/tls-cert.pem", import.meta.url));
export async function startSocketFixtures() {
  const cert = await readFile(certificate);
  const key = await readFile(new URL("./Fixtures/tls-key.pem", import.meta.url));
  const untrustedCert = await readFile(new URL("./Fixtures/untrusted-tls-cert.pem", import.meta.url));
  const untrustedKey = await readFile(new URL("./Fixtures/untrusted-tls-key.pem", import.meta.url));
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(5000, () => socket.destroy());
  };
  const echo = (socket) => {
    track(socket);
    let input = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 4096) return socket.destroy();
      if (input.includes(10)) socket.end(input);
    });
  };
  const plain = net.createServer(echo);
  const secure = tls.createServer({ cert, key }, echo);
  secure.on("tlsClientError", () => {});
  // This self-signed certificate is deliberately absent from NODE_EXTRA_CA_CERTS.
  const untrusted = tls.createServer({ cert: untrustedCert, key: untrustedKey }, echo);
  untrusted.on("tlsClientError", () => {});
  const interrupted = net.createServer((socket) => {
    track(socket);
    socket.once("data", () => socket.end("partial"));
  });
  const context = tls.createSecureContext({ cert, key });
  const upgrade = net.createServer((socket) => {
    track(socket);
    let input = Buffer.alloc(0);
    const prelude = (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (input.length > 4096) return socket.destroy();
      const newline = input.indexOf(10);
      if (newline < 0) return;
      if (input.subarray(0, newline + 1).toString() !== "STARTTLS\n") return socket.destroy();
      socket.removeListener("data", prelude);
      socket.pause();
      const remaining = input.subarray(newline + 1);
      if (remaining.length) socket.unshift(remaining);
      const wrapped = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
      echo(wrapped);
      wrapped.resume();
    };
    socket.on("data", prelude);
  });
  const servers = [plain, secure, upgrade, untrusted, interrupted];
  try {
    for (const server of servers) await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  } catch (error) { for (const server of servers) server.close(); throw error; }
  return {
    variables: { TCP_ADDRESS: `127.0.0.1:${plain.address().port}`, TLS_ADDRESS: `localhost:${secure.address().port}`, STARTTLS_ADDRESS: `localhost:${upgrade.address().port}`, UNTRUSTED_TLS_ADDRESS: `localhost:${untrusted.address().port}`, INTERRUPTED_TCP_ADDRESS: `127.0.0.1:${interrupted.address().port}` },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    },
  };
}
