import { expect, it } from "vitest";
import { entrypointLifecycleErrorsProbe } from "../../../Support/Runtime/harness.js";

async function probe(
  mode: string,
  native: unknown,
  value: unknown = null,
  env: unknown = {},
) {
  return JSON.parse(
    await entrypointLifecycleErrorsProbe(mode, native, value, env),
  );
}

export function registerEntrypointLifecycleErrorsCases(): void {
  it("renders native error diagnostics without touching opaque native payloads", async () => {
    const native = new Proxy(
      {},
      {
        get() {
          throw new Error("opaque native payload accessed");
        },
      },
    );
    expect(await probe("native-error-diagnostics", native)).toEqual({
      ok: true,
      value: {
        list: "[first,second] suffix",
        individual: ["first suffix", "second suffix"],
      },
    });
  });
  it("echoes configured binary messages without altering their bytes", async () => {
    const sent: Uint8Array[] = [];
    const result = JSON.parse(
      await entrypointLifecycleErrorsProbe(
        "message-env",
        {
          send(value: ArrayBuffer | ArrayBufferView) {
            sent.push(
              value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(
                    value.buffer,
                    value.byteOffset,
                    value.byteLength,
                  ),
            );
          },
        },
        new Uint8Array([0, 128, 255]).buffer,
        { PREFIX: "unused-for-binary" },
      ),
    );
    expect(result).toEqual({ ok: true, value: true });
    expect(sent).toHaveLength(1);
    expect([...sent[0]]).toEqual([0, 128, 255]);
  });
  it("rejects malformed workflow lists and unsupported fixture modes", async () => {
    const invalid = await probe("workflow-list", {}, [null]);
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toContain("WorkflowEvent");
    expect(await probe("workflow-list", {}, [])).toEqual({
      ok: true,
      value: [],
    });
    expect((await probe("unknown-mode", {})).message).toContain(
      "Unknown entrypoint lifecycle mode",
    );
  });
  it("uses required configuration in message and close handlers", async () => {
    const sent: unknown[] = [];
    const attachments: unknown[] = [];
    const socket = {
      send: (value: unknown) => sent.push(value),
      serializeAttachment: (value: unknown) => attachments.push(value),
    };
    expect(
      await probe("message-env", socket, "hello", { PREFIX: "room:" }),
    ).toEqual({ ok: true, value: true });
    expect(sent).toEqual(["room:hello"]);
    expect(
      await probe(
        "close-env",
        socket,
        { code: 1001, reason: "away", clean: false },
        { PREFIX: "room:" },
      ),
    ).toEqual({ ok: true, value: true });
    expect(attachments).toEqual([
      { prefix: "room:", code: 1001, reason: "away", clean: false },
    ]);
    expect((await probe("message-env", socket, "hello")).ok).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("consumes workflow timestamps and validates ordered event batches", async () => {
    const first = {
      payload: 7,
      instanceIdentifier: "first",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const second = {
      payload: 8,
      instanceIdentifier: "second",
      timestamp: "2026-01-02T00:00:00.000Z",
    };
    expect(
      await probe(
        "workflow-timestamp",
        {},
        {
          payload: 7,
          instanceId: "first",
          timestamp: new Date(first.timestamp),
        },
      ),
    ).toEqual({
      ok: true,
      value: { ok: true, value: { payload: 7, timestamp: first.timestamp } },
    });
    expect(await probe("workflow-list", {}, [first, second])).toEqual({
      ok: true,
      value: [
        [7, first.timestamp],
        [8, second.timestamp],
      ],
    });
    for (const value of [null, []]) {
      const result = await probe("workflow-decode", {}, value);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("WorkflowEvent");
    }
    expect(await probe("workflow-decode", {}, first)).toEqual({
      ok: true,
      value: first.timestamp,
    });
  });

  it("propagates native WebSocket lifecycle failures as typed errors", async () => {
    const fail = () => {
      throw new Error("native lifecycle failure");
    };
    const native = {
      send: fail,
      getWebSockets: fail,
      deserializeAttachment: fail,
      acceptWebSocket: fail,
      serializeAttachment: fail,
      close: fail,
      setWebSocketAutoResponse: fail,
    };
    for (const mode of [
      "connections",
      "attachment",
      "send",
      "binary-send",
      "accept",
      "set-attachment",
      "close",
      "auto-response",
    ]) {
      const result = await probe(mode, native, {});
      expect(result.ok, mode).toBe(false);
      expect(result.message, mode).toContain("WebSocketSendFailed");
      expect(result.message, mode).toContain("native lifecycle failure");
    }
    expect(await probe("connections", { getWebSockets: () => [] })).toEqual({
      ok: true,
      value: 0,
    });
  });

  it("validates decoded attachment types and recovers after failure", async () => {
    const invalid = await probe("attachment", {
      deserializeAttachment: () => ({ invalid: true }),
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toContain("WebSocketSendFailed");
    expect(
      await probe("attachment", { deserializeAttachment: () => 7 }),
    ).toEqual({ ok: true, value: 7 });
    expect(
      await probe("attachment", { deserializeAttachment: () => undefined }),
    ).toEqual({ ok: true, value: null });
  });

  it("rejects negative and oversized frame limits before invoking handlers", async () => {
    expect((await probe("negative-limit", {}, "a")).message).toContain(
      "Invalid WebSocket message byte limit",
    );
    for (const value of ["abcd", "éé", new Uint8Array([1, 2, 3, 4]).buffer]) {
      expect((await probe("limit", {}, value)).message).toContain(
        "WebSocketMessageTooLarge 3",
      );
    }
    expect((await probe("limit", {}, "abc")).message).toContain(
      "message handler failed",
    );
    expect(
      (
        await probe(
          "close-handler-failure",
          {},
          { code: 1001, reason: "going away", clean: false },
        )
      ).message,
    ).toContain("close handler failed");
    expect(
      (await probe("handler-failure", {}, new Uint8Array([1]).buffer)).message,
    ).toContain("message handler failed");
  });

  it("contains malformed workflow payloads and unsafe output serialization", async () => {
    const event = {
      payload: {},
      instanceId: "lifecycle",
      timestamp: new Date("2026-01-01T00:00:00Z"),
    };
    const malformed = await probe("workflow-invalid", {}, event);
    expect(malformed.ok).toBe(true);
    expect(malformed.value.ok).toBe(false);
    expect(malformed.value.message).toContain("Invalid Workflow event:");
    const unsafe = await probe("workflow-unsafe-number", {}, event);
    expect(unsafe.ok).toBe(true);
    expect(unsafe.value.ok).toBe(false);
    expect(unsafe.value.message).toContain("safe integer range");
    const valid = await probe("workflow-invalid", {}, { ...event, payload: 7 });
    expect(valid).toEqual({ ok: true, value: { ok: true, value: 7 } });
  });

  it("preserves workflow asynchronous exceptions and native diagnostic text", async () => {
    const result = await probe(
      "workflow-async",
      {},
      {
        payload: {},
        instanceId: "lifecycle",
        timestamp: new Date("2026-01-01T00:00:00Z"),
      },
    );
    expect(result).toEqual({ ok: false, message: "thread killed" });
    expect(await probe("native-error-show", {})).toEqual({
      ok: true,
      value: "native failure",
    });
  });
}
