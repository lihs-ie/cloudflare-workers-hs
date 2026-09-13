import { describe, expect, it } from "vitest";
import { socketProbe } from "../../../Support/Runtime/harness.js";

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
}
