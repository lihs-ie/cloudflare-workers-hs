import http from "node:http";

/** A local HTTP destination: observe real timeout and retry transport behavior. */
export async function startClientHttpFixture() {
  const attempts = new Map();
  const timers = new Set();
  let remainingBodyInterruptions = 0;
  let disconnectStream = false;
  let malformedStream = false;
  let closedStreamResponses = 0;
  let uploadFailure = null;
  let responseMode = null;
  const uploads = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.local");
    const key = url.pathname;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    if (key === "/stream-upload") {
      const mode = uploadFailure;
      uploadFailure = null;
      const observation = {
        method: request.method,
        bytes: 0,
        ended: false,
        mode,
        responseAtBytes: null,
      };
      uploads.push(observation);
      request.on("data", (chunk) => {
        observation.bytes += chunk.length;
        if (mode === "early-success" && !response.headersSent) {
          observation.responseAtBytes = observation.bytes;
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end('{"ok":true}');
        }
        if (mode === "during") {
          request.socket.destroy();
        }
      });
      request.on("end", () => {
        observation.ended = true;
        if (mode === "after") {
          request.socket.destroy();
          return;
        }
        if (!response.headersSent) {
          response.writeHead(mode === "http-error" ? 409 : 200, { "Content-Type": "application/json" });
          response.end('{"ok":true}');
        }
      });
      return;
    }
    if (key === "/stream-response") {
      const mode = responseMode;
      responseMode = null;
      if (mode === "empty") {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end();
        return;
      }
      if (mode === "read-failure") {
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "10" });
        response.flushHeaders();
        const timer = setTimeout(() => {
          timers.delete(timer);
          response.destroy();
        }, 100);
        timers.add(timer);
        return;
      }
      response.once("close", () => {
        if (!response.writableFinished) {
          closedStreamResponses++;
        }
      });
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.from([0, 128, 255]));
      return;
    }
    if (key === "/stream-echo") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        if (disconnectStream) {
          disconnectStream = false;
          request.socket.destroy();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        if (malformedStream) {
          malformedStream = false;
          response.end("{invalid-json");
          return;
        }
        response.end(
          JSON.stringify({
            method: request.method,
            bytes: [...Buffer.concat(chunks)],
            contentType: request.headers["content-type"] ?? null,
            trace: request.headers["x-stream-trace"] ?? null,
            attempts: count,
          }),
        );
      });
      return;
    }
    if (key === "/disconnect" && count <= 2) {
      request.socket.destroy();
      return;
    }
    if (key === "/" && remainingBodyInterruptions > 0) {
      remainingBodyInterruptions--;
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": "1024",
      });
      response.flushHeaders();
      response.write('{"partial":');
      // Flush headers and part of the body before breaking the actual socket.
      const timer = setTimeout(() => {
        timers.delete(timer);
        request.socket.destroy();
      }, 40);
      timers.add(timer);
      return;
    }
    const send = () => {
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ received: true, attempts: count }));
      }
    };
    if (key === "/slow") {
      const timer = setTimeout(() => {
        timers.delete(timer);
        send();
      }, 100);
      timers.add(timer);
      return;
    }
    send();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    stats: () => Object.fromEntries(attempts),
    closedStreamResponses: () => closedStreamResponses,
    failNextUpload(mode) {
      if (mode !== "during" && mode !== "after" && mode !== "early-success" && mode !== "http-error") {
        throw new Error("Unknown upload failure mode");
      }
      uploadFailure = mode;
    },
    nextStreamResponse(mode) {
      if (mode !== "empty" && mode !== "read-failure") {
        throw new Error("Unknown stream response mode");
      }
      responseMode = mode;
    },
    uploads: () => uploads.map((observation) => ({ ...observation })),
    interruptResponseBodies(count) {
      remainingBodyInterruptions = count;
    },
    malformNextStreamResponse() {
      malformedStream = true;
    },
    disconnectNextStream() {
      disconnectStream = true;
    },
    async close() {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      const closed = new Promise((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        }),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}
