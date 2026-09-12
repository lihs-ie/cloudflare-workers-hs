import { describe, expect, it } from "vitest";
import { socketProbe, streamProbe, producerProbe } from "../../../Support/Runtime/harness.js";

interface FixtureSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<{ remoteAddress?: string; localAddress?: string }>;
  closed: Promise<void>;
  close(): Promise<void>;
  startTls(): FixtureSocket;
}
function socketFixture(): FixtureSocket {
  return {
    readable: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    writable: new WritableStream<Uint8Array>(),
    opened: Promise.resolve({ remoteAddress: "fixture:443", localAddress: "local:1" }),
    closed: Promise.resolve(),
    close() { return Promise.resolve(); },
    startTls() { return socketFixture(); },
  };
}
function bytes() {
  return new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array([97, 98, 99]));
    controller.close();
  } });
}

export function registerSocketStreamCases(): void {
  describe("Byte array boundary through real Haskell WASM", () => {
    for (const value of [null, undefined, "bytes", [1, 2], {}, new ArrayBuffer(2)]) {
      it(`rejects non-view input ${String(value)}`, async () => {
        expect((await streamProbe(value, "bytes", "0"))[0]).toContain("not an ArrayBufferView");
      });
    }
    it("rejects wide views and DataView while accepting every one-byte view", async () => {
      for (const value of [new Uint16Array([256]), new Int32Array(0), new Float64Array([1]), new DataView(new ArrayBuffer(2))]) {
        expect((await streamProbe(value, "bytes", "0"))[0]).toContain("wider than one byte");
      }
      for (const value of [new Uint8Array([0, 255]), new Int8Array([0, -1]), new Uint8ClampedArray([0, 255])]) {
        expect(await streamProbe(value, "bytes", "0")).toEqual(["[0,255]"]);
      }
      expect(await streamProbe(new Uint8Array(0), "bytes", "0")).toEqual(["[]"]);
    });
    it("copies only the selected byte view and recovers after throwing conversion", async () => {
      const source = new Uint8Array([11, 22, 33, 44]);
      expect(await streamProbe(source.subarray(1, 3), "bytes", "0")).toEqual(["[22,33]"]);
      expect((await streamProbe({}, "bytes-throw", "0"))[0]).toContain("JSByteArrayReadError");
      expect(await streamProbe(source, "bytes-throw", "0")).toEqual(["[11,22,33,44]"]);
    });
    it("rejects spoofed lengths without allocating or leaking trailing memory", async () => {
      for (const length of [-1, 0.5, NaN, Infinity, 2147483648, 9007199254740992, 3]) {
        const source = new Uint8Array([1, 2]);
        Object.defineProperty(source, "length", { value: length });
        expect((await streamProbe(source, "bytes", "0"))[0]).toContain("non-negative integer");
      }
      const throwing = new Uint8Array([1]);
      Object.defineProperty(throwing, "length", { get() { throw new Error("length-getter-failed"); } });
      expect((await streamProbe(throwing, "bytes", "0"))[0]).toContain("non-negative integer");
      expect(await streamProbe(new Uint8Array([2]), "bytes", "0")).toEqual(["[2]"]);
    });
    it("rejects a spoofed element width and detached views", async () => {
      const wide = new Uint16Array([257]);
      Object.defineProperty(wide, "BYTES_PER_ELEMENT", { value: 1 });
      expect((await streamProbe(wide, "bytes", "0"))[0]).toContain("wider than one byte");
      const detached = new Uint8Array([1]);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      expect((await streamProbe(detached, "bytes", "0"))[0]).toContain("non-negative integer");
    });
  });
  describe("Socket failures through real Haskell WASM", () => {
    for (const [message, kind] of [["DNS refused", "SocketConnectionError"], ["writable failed", "SocketStreamError"], ["TLS failed", "SocketOtherError"]]) {
      it(`classifies opened rejection ${kind} and closes state`, async () => {
        const socket = socketFixture();
        socket.opened = Promise.reject(new Error(message));
        const result = await socketProbe(() => socket, "opened");
        expect(result[0]).toContain(kind);
        expect(result[0]).toContain(message);
        expect(result[1]).toBe("SocketClosed");
        expect((await socketProbe(socketFixture, "opened"))[0]).toContain("Right");
      });
    }
    it("observes successful closed and prevents later writes", async () => {
      const result = await socketProbe(socketFixture, "closed-success");
      expect(result[0]).toBe("Right ()");
      expect(result[1]).toContain("not ready");
      expect(result[2]).toContain("not ready");
      expect(result[3]).toBe("SocketClosed");
    });
    it("delegates repeated close and retains closed state when the second call rejects", async () => {
      for (const rejectSecond of [false, true]) {
        const socket = socketFixture();
        let calls = 0;
        socket.close = async () => {
          calls += 1;
          if (rejectSecond && calls === 2) { throw new Error("second-close-failure"); }
        };
        const result = await socketProbe(() => socket, "double-close");
        expect(result[0]).toBe("Right ()");
        expect(result[1]).toContain(rejectSecond ? "second-close-failure" : "Right ()");
        expect(result[2]).toBe("SocketClosed");
        expect(calls).toBe(2);
      }
    });
    it("reads to EOF after half-close and releases a repeatedly closed writer", async () => {
      const socket = socketFixture();
      socket.readable = bytes();
      const result = await socketProbe(() => socket, "half-open");
      expect(result[0]).toBe("Right ()");
      expect(result[1]).toBe('Right "abc"');
      expect(result[2]).toContain("Left");
      expect(socket.readable.locked).toBe(false);
      expect(socket.writable.locked).toBe(false);
    });
    it("uses the upgraded socket with preserved half-open options and a distinct identity", async () => {
      const socket = socketFixture();
      const upgraded = socketFixture();
      const writes: number[][] = [];
      upgraded.writable = new WritableStream({ write(chunk) { writes.push([...chunk]); } });
      socket.startTls = () => upgraded;
      const result = await socketProbe(() => socket, "tls-use");
      expect(result[0]).toContain("SecureTransportOn");
      expect(result[0]).toContain("True");
      expect(result.slice(1, 3)).toEqual(["Right ()", "Right ()"]);
      expect(result[3]).toContain("not ready");
      expect(result[4]).toContain("not ready");
      expect(result[5]).toBe("True");
      expect(writes).toEqual([[112, 97, 121, 108, 111, 97, 100]]);
      expect(upgraded.writable.locked).toBe(false);
    });
    it("accepts absent optional socket addresses", async () => {
      const socket = socketFixture();
      socket.opened = Promise.resolve({});
      expect((await socketProbe(() => socket, "opened"))[0]).toContain("Nothing");
    });
    it("catches a synchronous connector failure and recovers", async () => {
      expect((await socketProbe(() => { throw new Error("connect-refused"); }, "opened"))[0]).toContain("connect-refused");
      expect((await socketProbe(socketFixture, "opened"))[0]).toContain("socketInfoRemoteAddress");
    });
    it("releases the writer lock after failed write and finish", async () => {
      for (const command of ["write", "finish"]) {
        const socket = socketFixture();
        socket.writable = new WritableStream({
          write() { throw new Error("writable-write-failure"); },
          close() { throw new Error("writable-close-failure"); },
        });
        expect((await socketProbe(() => socket, command))[0]).toContain("SocketStreamError");
        expect(socket.writable.locked).toBe(false);
      }
    });
    it("handles a locked writable without releasing another owner's lock", async () => {
      const socket = socketFixture();
      const writer = socket.writable.getWriter();
      expect((await socketProbe(() => socket, "write"))[0]).toContain("Left");
      expect(socket.writable.locked).toBe(true);
      writer.releaseLock();
    });
    it("restores readiness after startTls rejection and permits retry", async () => {
      const socket = socketFixture();
      let attempts = 0;
      socket.startTls = () => {
        attempts += 1;
        if (attempts === 1) { throw new Error("TLS-upgrade-failure"); }
        return socketFixture();
      };
      const result = await socketProbe(() => socket, "tls");
      expect(result[0]).toContain("TLS-upgrade-failure");
      expect(result.slice(1)).toEqual(["SocketReady", "SecureTransportOn", "SocketClosed"]);
      expect(attempts).toBe(2);
    });
    it("observes both upgraded socket rejection promises while preserving failure details", async () => {
      const socket = socketFixture();
      socket.startTls = () => {
        const upgraded = socketFixture();
        upgraded.opened = Promise.reject(new Error("TLS-network-opened"));
        upgraded.closed = Promise.reject(new Error("TLS-network-closed"));
        return upgraded;
      };
      const result = await socketProbe(() => socket, "tls-failure");
      expect(result[0]).toContain("TLS-network-opened");
      expect(result[1]).toContain("TLS-network-closed");
      expect(result[2]).toBe("SocketClosed");
    });
    it("rejects a second successful TLS upgrade without invoking native startTls twice", async () => {
      const socket = socketFixture();
      let attempts = 0;
      socket.startTls = () => { attempts += 1; return socketFixture(); };
      const result = await socketProbe(() => socket, "tls");
      expect(result[0]).toBe("SecureTransportOn");
      expect(result[2]).toContain("only available once");
      expect(attempts).toBe(1);
    });
    it("rejects write and finish after close", async () => {
      const result = await socketProbe(socketFixture, "close");
      expect(result[0]).toBe("Right ()");
      expect(result[1]).toContain("not ready");
      expect(result[2]).toContain("not ready");
      expect(result[3]).toBe("SocketClosed");
    });
    it("retains ready state if native close fails", async () => {
      const socket = socketFixture();
      socket.close = () => Promise.reject(new Error("close-failure"));
      const result = await socketProbe(() => socket, "close");
      expect(result[0]).toContain("close-failure");
      expect(result.slice(1)).toEqual(["Right ()", "Right ()", "SocketReady"]);
    });
    it("marks closed on rejection of the native closed promise", async () => {
      const socket = socketFixture();
      socket.closed = Promise.reject(new Error("network-close-failure"));
      const result = await socketProbe(() => socket, "closed");
      expect(result[0]).toContain("SocketConnectionError");
      expect(result[1]).toBe("SocketClosed");
    });
  });
  describe("Stream boundaries through real Haskell WASM", () => {
    it("awaits successful and rejected asynchronous cancellation", async () => {
      for (const reject of [false, true]) {
        let finished = false;
        const stream = new ReadableStream({ async cancel() {
          await Promise.resolve();
          finished = true;
          if (reject) { throw new Error("cancel-rejected"); }
        } });
        const result = await streamProbe(stream, "cancel", "0");
        expect(finished).toBe(true);
        expect(result[0]).toContain(reject ? "cancel-rejected" : "cancelled");
      }
    });
    it("preserves the exact declared byte count and rejects excess or missing bytes", async () => {
      expect((await streamProbe(bytes(), "fixed", "3"))[0]).toContain('Right "abc"');
      for (const length of ["2", "4"]) {
        expect((await streamProbe(bytes(), "fixed", length))[0]).toContain("StreamDrainFailure");
      }
      expect((await streamProbe(bytes(), "fixed", "3"))[0]).toContain('Right "abc"');
    });
    it("validates negative and unsafe integer lengths before touching source", async () => {
      for (const length of ["-1", "9007199254740992"]) {
        const source = bytes();
        expect((await streamProbe(source, "fixed", length))[0]).toContain("Invalid fixed stream byte length");
        expect(source.locked).toBe(false);
        await source.cancel();
      }
    });
    it("accepts zero and safe integer maximum without allocating the declared body", async () => {
      const empty = new ReadableStream({ start(controller) { controller.close(); } });
      expect((await streamProbe(empty, "fixed", "0"))[0]).toContain('Right ""');
      let recordCancellation: (() => void) | undefined;
      const cancellation = new Promise<void>((resolve) => { recordCancellation = resolve; });
      const source = new ReadableStream({ cancel() { recordCancellation?.(); } });
      expect(await streamProbe(source, "fixed-cancel", "9007199254740991")).toEqual(["cancelled"]);
      await Promise.race([
        cancellation,
        new Promise((_, reject) => setTimeout(() => reject(new Error("upstream cancellation did not propagate")), 1000)),
      ]);
    });
    it("preserves upstream cancellation rejection through fixed stream cancellation", async () => {
      let called = false;
      const source = new ReadableStream({ cancel() {
        called = true;
        return Promise.reject(new Error("upstream-cancel-failed"));
      } });
      const outcome = await streamProbe(source, "fixed-cancel", "1");
      expect(called).toBe(true);
      expect(outcome[0]).toContain("upstream-cancel-failed");
      expect(await streamProbe(bytes(), "fixed", "3")).toEqual(['Right "abc"']);
    });
    it("propagates source failure through fixed length wrapping", async () => {
      const stream = new ReadableStream({ start(controller) { controller.error(new Error("source-failed")); } });
      expect((await streamProbe(stream, "fixed", "3"))[0]).toContain("source-failed");
    });
    it("rejects a locked readable without unwinding the reactor or releasing its owner's reader", async () => {
      const source = bytes();
      const reader = source.getReader();
      expect((await streamProbe(source, "lazy", "3"))[0]).toContain("StreamDrainFailure");
      expect(source.locked).toBe(true);
      expect((await streamProbe(source, "fixed", "3"))[0]).toContain("locked stream");
      expect(source.locked).toBe(true);
      reader.releaseLock();
      expect((await streamProbe(source, "fixed", "3"))[0]).toBe('Right "abc"');
    });
    it("rejects malformed reader results and throwing getters without unwinding WASM", async () => {
      const getterFailure = { done: false, get value() { throw new Error("chunk-getter-failed"); } };
      for (const result of [null, undefined, {}, { done: 1 }, getterFailure]) {
        let released = false;
        let cancelled = false;
        const source = { getReader() { return {
          read() { return Promise.resolve(result); },
          cancel() { cancelled = true; return Promise.resolve(); },
          releaseLock() { released = true; },
        }; } };
        expect((await streamProbe(source, "lazy", "3"))[0]).toContain("StreamDrainFailure");
        expect(released).toBe(true);
        expect(cancelled).toBe(true);
        expect(await streamProbe(bytes(), "lazy", "3")).toEqual(['Just "abc"']);
      }
    });
    it("enforces the intrinsic chunk size even when byteLength is shadowed", async () => {
      for (const throwing of [false, true]) {
        for (const limit of [2, 3]) {
          const chunk = new Uint8Array([97, 98, 99]);
          let getterCalls = 0;
          Object.defineProperty(chunk, "byteLength", throwing
            ? { get() { getterCalls += 1; throw new Error("byteLength-getter-failed"); } }
            : { value: 0 });
          const source = new ReadableStream<Uint8Array>({ start(controller) {
            controller.enqueue(chunk);
            controller.close();
          } });
          expect(await streamProbe(source, "lazy", String(limit))).toEqual([limit === 2 ? "Nothing" : 'Just "abc"']);
          expect(getterCalls).toBe(0);
          expect(await streamProbe(bytes(), "lazy", "3")).toEqual(['Just "abc"']);
        }
      }
    });
    it("drains optional lazy bytes, enforces limits, and preserves failure", async () => {
      expect((await streamProbe(bytes(), "lazy", "3"))[0]).toBe('Just "abc"');
      expect(await streamProbe(bytes(), "lazy", "2")).toEqual(["Nothing"]);
      expect(await streamProbe(bytes(), "lazy", "-1")).toEqual(["Nothing"]);
      const stream = new ReadableStream({ start(controller) { controller.error(new Error("lazy-source-failed")); } });
      expect((await streamProbe(stream, "lazy", "3"))[0]).toContain("lazy-source-failed");
    });
    it("preserves read and byte-limit outcomes while awaiting rejected cleanup", async () => {
      for (const mode of ["read-error", "limit", "negative"]) {
        let reads = 0;
        let cancelled = false;
        let releases = 0;
        const source = { getReader() { return {
          async read() {
            reads += 1;
            if (mode === "read-error") { throw new Error("primary-read-failure"); }
            return { done: false, value: new Uint8Array([1, 2]) };
          },
          async cancel() {
            await Promise.resolve();
            cancelled = true;
            throw new Error("cleanup-cancel-failure");
          },
          releaseLock() { releases += 1; },
        }; } };
        const result = await streamProbe(source, "lazy", mode === "negative" ? "-1" : "1");
        expect(result[0]).toContain(mode === "read-error" ? "primary-read-failure" : "Nothing");
        expect(result[0]).not.toContain("cleanup-cancel-failure");
        expect(reads).toBe(mode === "negative" ? 0 : 1);
        expect(cancelled).toBe(true);
        expect(releases).toBe(1);
        expect(await streamProbe(bytes(), "lazy", "3")).toEqual(['Just "abc"']);
      }
    });
    it("returns EOF repeatedly without reading a completed result value", async () => {
      let reads = 0;
      const source = { getReader() { return { async read() {
        reads += 1;
        return { done: true, get value() { throw new Error("unused EOF value"); } };
      } }; } };
      expect(await streamProbe(source, "reader-eof", "0")).toEqual(["Right Nothing", "Right Nothing"]);
      expect(reads).toBe(2);
    });
    it("settles producer failure after downstream cancellation without poisoning the reactor", async () => {
      for (const mode of ["cancel-failure", "cancel-throw"]) {
        const stream = await producerProbe(mode);
        const reader = stream.getReader();
        expect((await reader.read()).value).toEqual(new TextEncoder().encode("first"));
        await reader.cancel();
        const completion: unknown = Reflect.get(stream, "producerCompletion");
        if (!(completion instanceof Promise)) {
          throw new Error("Missing producer callback completion notification");
        }
        await completion;
        reader.releaseLock();
        expect(stream.locked).toBe(false);
        expect(await new Response(await producerProbe("normal")).text()).toBe("firstsecond");
      }
    });
    it("delivers producer output and propagates declared and thrown producer failures", async () => {
      expect(await new Response(await producerProbe("normal")).text()).toBe("firstsecond");
      for (const mode of ["failure", "throw"]) {
        await expect(new Response(await producerProbe(mode)).text()).rejects.toThrow("producer-");
      }
    });
    it("allows downstream cancellation and leaves the reactor usable", async () => {
      const stream = await producerProbe("normal");
      await stream.cancel();
      expect(await new Response(await producerProbe("normal")).text()).toBe("firstsecond");
    });
  });
}
