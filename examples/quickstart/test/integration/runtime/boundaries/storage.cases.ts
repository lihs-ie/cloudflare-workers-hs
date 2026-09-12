import { describe, expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../../../Support/Runtime/harness.js";

export function registerStorageCases(): void {
  describe("real WASM Durable Object storage", () => {
    it("persists an atomic put then deletes with existence results", async () => {
      const response = await worker.fetch(
        new Request("https://example.test/__model/storage", {
          method: "POST",
          body: JSON.stringify([
            { command: "get", key: "key", bytes: [] },
            { command: "transaction", key: "key", bytes: [0, 255, 42] },
            { command: "get", key: "key", bytes: [] },
            { command: "rollback", key: "key", bytes: [9] },
            { command: "get", key: "key", bytes: [] },
            { command: "delete", key: "key", bytes: [] },
            { command: "get", key: "key", bytes: [] },
            { command: "delete", key: "key", bytes: [] },
          ]),
        }),
        env,
        createExecutionContext(),
      );
      expect(await response.json()).toEqual([
        null,
        null,
        [0, 255, 42],
        "rolled-back",
        [0, 255, 42],
        true,
        null,
        false,
      ]);
    });
  });
}
