import { describe, expect, it } from "vitest";
import { transportExtraProbe, transportRequestExtra, transportResponseExtra, streamProbe, socketProbe } from "../../../Support/Runtime/harness.js";

function source(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode("stream bytes"));
    controller.close();
  } });
}

export function registerTransportExtraCases(): void {
  describe("Public transport boundary contracts", () => {
    it("returns successful values through the same typed stream handlers after failures", async () => {
      for (const mode of ["typed-byte-drain", "typed-stream-drain"]) {
        expect(await transportExtraProbe(source(), mode)).toEqual(['Just "stream bytes"']);
      }
    });
    it("observes socket success and propagates opened and low-level connection failures", async () => {
      const writes: string[] = [];
      function connect() {
        return {
          readable: source(),
          writable: new WritableStream<Uint8Array>({ write(value) { writes.push(new TextDecoder().decode(value)); } }),
          opened: Promise.resolve({ remoteAddress: "remote:443", localAddress: "local:123" }),
          closed: Promise.resolve(),
          close() { return Promise.resolve(); },
        };
      }
      expect(await transportExtraProbe(connect, "socket-typed-error")).toEqual(["write succeeded"]);
      expect(writes).toEqual(["payload"]);
      expect(await transportExtraProbe(connect, "socket-connect-error"))
        .toEqual(["SocketOptions {socketOptionsSecureTransport = SecureTransportOff, socketOptionsAllowHalfOpen = False}"]);
      const openedFailure = () => ({ ...connect(), opened: Promise.reject(new Error("network failure")) });
      expect(await transportExtraProbe(openedFailure, "socket-metadata"))
        .toEqual(['SocketError {socketErrorKind = SocketConnectionError, socketErrorInformation = "Error: network failure"}']);
      expect(await transportExtraProbe(() => { throw new Error("connect refused"); }, "socket-native-writable"))
        .toEqual(["user error (Error: connect refused)"]);
      expect(await transportExtraProbe(connect, "socket-metadata"))
        .toEqual(['Just "remote:443"', 'Just "local:123"']);
    });
    it("propagates rejected TLS upgrades in both composite socket consumers", async () => {
      function connect() {
        return {
          readable: source(), writable: new WritableStream<Uint8Array>(),
          opened: Promise.resolve({}), closed: Promise.resolve(),
          close() { return Promise.resolve(); },
          startTls() { throw new Error("tls upgrade rejected"); },
        };
      }
      for (const mode of ["tls-use", "tls-failure"]) {
        expect(await socketProbe(connect, mode))
          .toEqual(['SocketError {socketErrorKind = SocketOtherError, socketErrorInformation = "Error: tls upgrade rejected"}']);
      }
      expect(await socketProbe(connect, "closed-success"))
        .toEqual(["Right ()", 'Left (SocketError {socketErrorKind = SocketStreamError, socketErrorInformation = "socket is not ready for writing"})',
          'Left (SocketError {socketErrorKind = SocketStreamError, socketErrorInformation = "socket is not ready for writing"})', "SocketClosed"]);
    });
    it("rejects unsupported fixture commands visibly and allows the next valid call", async () => {
      expect(await transportExtraProbe(null, "unsupported")).toEqual(["user error (Unknown transport probe)"]);
      await expect(transportResponseExtra(null, "unsupported")).rejects.toThrow("Unknown response probe");
      expect(await streamProbe(null, "unsupported", "0")).toEqual(["user error (Unknown stream probe)"]);
      const connect = () => ({
        readable: source(), writable: new WritableStream<Uint8Array>(),
        opened: Promise.resolve({}), closed: Promise.resolve(), close() { return Promise.resolve(); },
      });
      expect(await socketProbe(connect, "unsupported")).toEqual(["user error (Unknown socket probe)"]);
      expect(await transportExtraProbe("recovered", "unicode")).toEqual(["recovered"]);
      expect(await streamProbe(source(), "lazy", "32")).toEqual(['Just "stream bytes"']);
    });
    it("keeps diagnostic collections and snapshot equality consistent across public transport values", async () => {
      const contracts = [
        ["http-method", 9, "GET"],
        ["http-status", 2, "Status {statusCode = 200}"],
        ["http-body-placeholder", 2, 'RequestBodyPlaceholder "first"'],
        ["byte-rejection", 5, "JSByteArrayNotAView"],
        ["byte-exception", 2, 'JSByteArrayReadError "first"'],
        ["stream-step", 4, "StreamDrainContinue 1"],
        ["stream-outcome", 6, 'StreamDrainCompleted "a"'],
        ["stream-exception", 2, 'StreamDrainFailure "first"'],
        ["string-kind", 4, "JSStringKindUndefined"],
        ["string-outcome", 6, "JSStringAbsent"],
        ["socket-connect-exception", 2, 'SocketConnectError "first"'],
        ["socket-port", 2, "SocketPort 443"],
        ["socket-address", 5, 'SocketAddressText "first:443"'],
        ["socket-security", 3, "SecureTransportOff"],
        ["socket-options", 3, "SocketOptions {socketOptionsSecureTransport = SecureTransportOff, socketOptionsAllowHalfOpen = False}"],
        ["socket-identifier", 2, "SocketIdentifier 1"],
        ["socket-state", 3, "SocketReady"],
        ["socket-info", 5, "SocketInfo {socketInfoRemoteAddress = Nothing, socketInfoLocalAddress = Nothing}"],
        ["socket-error-kind", 3, "SocketConnectionError"],
        ["socket-error", 3, 'SocketError {socketErrorKind = SocketConnectionError, socketErrorInformation = "first"}'],
        ["read-error", 2, "ReadableStreamExceededByteLimit"],
        ["emit-outcome", 2, "StreamEmitAccepted"],
        ["producer-outcome", 3, "StreamProducerCompleted"],
      ] as const;
      const observed = await transportExtraProbe(null, "diagnostic-contracts");
      expect(observed).toHaveLength(contracts.length);
      for (const [index, [name, uniqueCount, firstDiagnostic]] of contracts.entries()) {
        const value = JSON.parse(observed[index]);
        expect(value.name).toBe(name);
        expect(value.diagnostics).toHaveLength(uniqueCount + 1);
        expect(value.diagnostics[0]).toBe(firstDiagnostic);
        expect(value.diagnostics[uniqueCount]).toBe(firstDiagnostic);
        expect(new Set(value.diagnostics.slice(0, uniqueCount)).size).toBe(uniqueCount);
        expect(value.collection).toBe(`[${value.diagnostics.join(",")}]`);
        expect(value.showListConsistent).toBe(true);
        expect(value.showsPrecConsistent).toBe(true);
        const equality = Array.from({ length: uniqueCount + 1 }, (_, left) =>
          Array.from({ length: uniqueCount + 1 }, (_, right) => left % uniqueCount === right % uniqueCount));
        expect(value.equality).toEqual(equality);
        expect(value.inequality).toEqual(equality.map(row => row.map(equal => !equal)));
      }
    });
    it("cleans up a decoded non-byte chunk through the Haskell exception path before returning", async () => {
      let cleanupFinished = false;
      const invalid = new ReadableStream<unknown>({
        start(controller) { controller.enqueue("not bytes"); },
        async cancel() {
          await new Promise(resolve => setTimeout(resolve, 5));
          cleanupFinished = true;
        },
      });
      const result = await transportExtraProbe(invalid, "typed-byte-drain");
      expect(result[0]).toBe("True");
      expect(result[1]).toContain("JSByteArrayReadError");
      expect(cleanupFinished).toBe(true);
      expect(invalid.locked).toBe(false);
      expect(await streamProbe(source(), "lazy", "32")).toEqual(['Just "stream bytes"']);
    });
    it("retains the typed read failure when asynchronous cleanup rejects", async () => {
      let cleanupFinished = false;
      const failing = {
        getReader() {
          return {
            read() { return Promise.reject(new Error("read failure")); },
            async cancel() {
              await new Promise(resolve => setTimeout(resolve, 5));
              cleanupFinished = true;
              throw new Error("cleanup failure");
            },
            releaseLock() {},
          };
        },
      };
      const result = await transportExtraProbe(failing, "typed-stream-drain");
      expect(result[0]).toBe("True");
      expect(result[1]).toContain('StreamDrainFailure "read failure"');
      expect(cleanupFinished).toBe(true);
    });
    it("provides the complete representable reader budget to a reader-backed request", async () => {
      const request = await transportRequestExtra(null, "reader-budget");
      expect(await request.text()).toBe("2147483647");
    });
    it("exposes socket connection metadata and catches typed socket errors", async () => {
      function socket() {
        return {
          readable: source(),
          writable: new WritableStream<Uint8Array>(),
          opened: Promise.resolve({ remoteAddress: "remote:443", localAddress: "local:123" }),
          closed: Promise.resolve(),
          close() { return Promise.resolve(); },
        };
      }
      expect(await transportExtraProbe(socket, "socket-metadata"))
        .toEqual(['Just "remote:443"', 'Just "local:123"']);
      const failure = await transportExtraProbe(() => {
        return { ...socket(), writable: new WritableStream({ write() { throw new Error("writable failure"); } }) };
      }, "socket-typed-error");
      expect(failure[0]).toBe("SocketStreamError");
      expect(failure[1]).toBe("Error: writable failure");
      expect(failure[2]).toBe("True");
      expect(failure[3]).toContain("writable failure");
      expect((await transportExtraProbe(() => { throw new Error("connect refused"); }, "socket-connect-error"))[0])
        .toContain("SocketConnectError");
    });
    it("uses the writable returned by the public low-level socket FFI", async () => {
      const chunks: number[] = [];
      let closed = false;
      const writable = new WritableStream<Uint8Array>({
        write(chunk) { chunks.push(...chunk); },
        close() { closed = true; },
      });
      const connector = () => ({
        readable: source(), writable, opened: Promise.resolve({}), closed: Promise.resolve(),
      });
      expect(await transportExtraProbe(connector, "socket-native-writable")).toEqual(["written and closed"]);
      expect(chunks).toEqual([110, 97, 116, 105, 118, 101]);
      expect(closed).toBe(true);
      expect(writable.locked).toBe(false);
    });
    it("decides stalled, overflowing and exact-limit chunks without Int wraparound", async () => {
      expect(await transportExtraProbe(null, "steps")).toEqual([
        "StreamDrainStopStalled", "StreamDrainStopStalled", "StreamDrainStopByteLimitExceeded",
        "StreamDrainContinue 10", "StreamDrainContinue 1", "StreamDrainStopByteLimitExceeded",
      ]);
    });
    it("roundtrips standard, extension and case-sensitive methods", async () => {
      expect(await transportExtraProbe(null, "methods")).toEqual([
        "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "PROPFIND", "patch",
      ]);
    });
    it("describes unknown byte decoder codes and preserves valid lengths", async () => {
      const values = await transportExtraProbe(null, "byte-codes");
      expect(values[0]).toContain("unrecognised rejection code -4");
      expect(values[1]).toContain("unrecognised rejection code -99");
      expect(values.slice(2)).toEqual(["0", "17"]);
    });
    it("catches native header iteration and append failures without poisoning later calls", async () => {
      const invalid = [
        { get entries() { throw new Error("entries getter"); } },
        { entries() { throw new Error("entries call"); } },
        { entries() { return [["x-ok", "value"]]; }, getSetCookie() { throw new Error("cookies call"); } },
      ];
      for (const value of invalid) {
        expect((await transportExtraProbe(value, "header-decode"))[0]).toContain("Failed to decode native Headers entries");
      }
      for (const command of ["header-name", "header-value"]) {
        expect((await transportExtraProbe(null, command))[0]).toContain("Failed to append a native Header");
      }
      expect(await transportExtraProbe(new Headers({ "x-ok": "value" }), "header-decode"))
        .toEqual(['[("x-ok","value")]']);
    });
    it("validates socket port bounds", async () => {
      expect(await transportExtraProbe(null, "ports")).toEqual(["Nothing", "Nothing", "Just 1", "Just 65535", "Nothing"]);
    });
    it("preserves Unicode across the text boundary", async () => {
      expect(await transportExtraProbe("日本語🌐\u0000", "unicode")).toEqual(["日本語🌐\u0000"]);
    });
    it("rejects non-101 websocket responses before accessing the native upgrade", async () => {
      expect((await transportExtraProbe(null, "invalid-upgrade"))[0]).toContain("WebSocket response status must remain 101");
    });
    it("observes body presence and optional data center metadata", async () => {
      expect(await transportExtraProbe({ method: "PATCH", body: null }, "metadata"))
        .toEqual(["PATCH", "False", "Nothing"]);
      expect(await transportExtraProbe({ method: "PROPFIND", body: source(), cf: { colo: "NRT" } }, "metadata"))
        .toEqual(["PROPFIND", "True", 'Just "NRT"']);
      expect(await transportExtraProbe({ method: "GET", body: null, cf: { colo: 42 } }, "metadata"))
        .toEqual(["GET", "False", "Nothing"]);
    });
    it("encodes empty, reader-backed and stream-backed native requests", async () => {
      for (const [mode, body, method] of [["empty", "", "GET"], ["reader", "reader bytes", "PATCH"], ["stream", "stream bytes", "PATCH"]]) {
        const request = await transportRequestExtra(source(), mode);
        expect(request.method).toBe(method);
        expect(request.url).toBe("https://transport.example/path?q=1");
        expect(request.headers.get("x-transport")).toBe("present");
        expect(await request.text()).toBe(body);
      }
    });
    it("rejects bounded-reader failures before constructing a native request and recovers", async () => {
      expect((await transportExtraProbe(null, "reader-limit"))[0]).toContain("exceeded the representable byte limit");
      expect((await transportExtraProbe(null, "reader-stalled"))[0]).toContain("request body stream stalled");
      expect(await (await transportRequestExtra(null, "reader")).text()).toBe("reader bytes");
    });
    it("cancels a fixed stream whose consumer owns the readable lock and releases its producer", async () => {
      let cancelled = false;
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        cancel() { cancelled = true; },
      });
      const response = await transportResponseExtra(upstream, "fixed");
      const body = response.body;
      if (body === null) {
        throw new Error("Missing fixed stream body");
      }
      const reader = body.getReader();
      const closed = reader.closed.then(() => "closed", () => "aborted");
      expect(await streamProbe(body, "cancel", "0")).toEqual(["cancelled"]);
      expect(cancelled).toBe(true);
      expect(upstream.locked).toBe(false);
      // Native fixed streams can retain an already-buffered chunk after abort.
      // Consume it before awaiting the consumer's terminal error.
      await expect((async () => {
        while (!(await reader.read()).done) {
          // Drain buffered data to observe the cancellation error.
        }
      })()).rejects.toThrow();
      expect(await closed).toBe("aborted");
      reader.releaseLock();
    });
    it("cancels an unconsumed fixed destination with a pending write", async () => {
      let cancelled = false;
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        cancel() { cancelled = true; },
      });
      const response = await transportResponseExtra(upstream, "fixed");
      expect(await streamProbe(response.body, "cancel", "0")).toEqual(["cancelled"]);
      expect(cancelled).toBe(true);
      expect(upstream.locked).toBe(false);
    });
    it("retains cancellation ownership after pump completion while the consumer keeps its lock", async () => {
      const upstream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(10)); controller.close(); },
      });
      const response = await transportResponseExtra(upstream, "fixed");
      const body = response.body;
      if (body === null) {
        throw new Error("Missing fixed stream body");
      }
      const reader = body.getReader();
      expect((await reader.read()).value?.byteLength).toBe(10);
      expect((await reader.read()).done).toBe(true);
      expect(body.locked).toBe(true);
      expect(await streamProbe(body, "cancel", "0")).toEqual(["cancelled"]);
      expect(upstream.locked).toBe(false);
      reader.releaseLock();
    });
    it("encodes lazy chunks, streams and passthrough bodies with replacement status and headers", async () => {
      for (const [mode, value, expected] of [
        ["lazy", null, "firstsecond"], ["stream", source(), "stream bytes"],
        ["passthrough", new Response("upstream", { status: 201 }), "upstream"],
      ] as const) {
        const response = await transportResponseExtra(value, mode);
        expect(response.status).toBe(202);
        expect(response.headers.get("x-transport")).toBe("present");
        expect(await response.text()).toBe(expected);
      }
    });
  });
}
