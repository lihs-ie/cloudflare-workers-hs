import { describe, expect, it } from "vitest";
import { probeEnvelope } from "../../../Support/Runtime/harness.js";

export function registerEnvelopeCases(): void {
  describe("Haskell FFI envelope validation", () => {
    for (const [label, input] of [
      ["null", null], ["undefined", undefined], ["missing ok", {}],
      ["string ok", { ok: "true" }], ["numeric ok", { ok: 1 }],
    ] as const) {
      it(`rejects ${label} without running the value decoder and recovers`, async () => {
        const result = JSON.parse(await probeEnvelope(input));
        expect(result.succeeded).toBe(false);
        expect(result.decoderCalls).toBe(0);
        expect(result.message).toContain("not a boolean");
        expect(JSON.parse(await probeEnvelope({ ok: true, value: null }))).toEqual({
          succeeded: true, message: "decoded", decoderCalls: 1,
        });
      });
    }
    for (const message of [undefined, null, "", 42, false]) {
      it(`rejects failure with unusable message ${String(message)}`, async () => {
        const result = JSON.parse(await probeEnvelope({ ok: false, message }));
        expect(result.succeeded).toBe(false);
        expect(result.decoderCalls).toBe(0);
        expect(result.message).toContain("no usable message");
      });
    }
    it("preserves a native failure message without invoking the decoder", async () => {
      expect(JSON.parse(await probeEnvelope({ ok: false, message: "fixture-rejected" }))).toEqual({
        succeeded: false, message: "fixture-rejected", decoderCalls: 0,
      });
    });
  });
}
