import { describe, expect, it } from "vitest";
import { passThroughContext, waitUntilContext } from "../../../Support/Runtime/harness.js";

export function registerContextCases(): void {
  describe("public WASM execution context adapter", () => {
    it("invokes passThroughOnException once with the original receiver", async () => {
      let calls = 0;
      let originalReceiver = false;
      const context = {
        passThroughOnException() {
          calls += 1;
          originalReceiver = this === context;
        },
      };
      await passThroughContext(context);
      expect(calls).toBe(1);
      expect(originalReceiver).toBe(true);
    });
    it("propagates a native context failure instead of silently succeeding", async () => {
      await expect(passThroughContext({
        passThroughOnException() {
          throw new Error("context-pass-through-rejected");
        },
      })).rejects.toThrow("context-pass-through-rejected");
      let recovered = false;
      await passThroughContext({ passThroughOnException() { recovered = true; } });
      expect(recovered).toBe(true);
    });
    it("registers one waitUntil promise and runs the background action", async () => {
      const promises: Promise<unknown>[] = [];
      let calls = 0;
      const context = { waitUntil(promise: Promise<unknown>) { promises.push(promise); } };
      await waitUntilContext(context, () => { calls += 1; });
      expect(promises).toHaveLength(1);
      await Promise.all(promises);
      expect(calls).toBe(1);
    });
    it("rejects the registered promise when the background action fails", async () => {
      let observed: Promise<unknown> | undefined;
      await waitUntilContext({
        waitUntil(promise: Promise<unknown>) { observed = promise.catch(error => error); },
      }, () => { throw new Error("background-action-rejected"); });
      expect(observed).toBeDefined();
      const error = await observed;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("background-action-rejected");
      await passThroughContext({ passThroughOnException() {} });
    });
    it("does not start an action after registration fails and remains usable", async () => {
      let calls = 0;
      await expect(waitUntilContext({
        waitUntil() { throw new Error("wait-until-registration-rejected"); },
      }, () => { calls += 1; })).rejects.toThrow("wait-until-registration-rejected");
      expect(calls).toBe(0);
      await passThroughContext({ passThroughOnException() { calls += 1; } });
      expect(calls).toBe(1);
    });
  });
}
