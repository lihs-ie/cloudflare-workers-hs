import { describe, expect, it } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../../../Support/Runtime/harness.js";

export function registerRequestCases(): void {
  describe("real WASM request boundary", () => {
    it.each(["", "日本語🙂", "abc\u0000xyz"])(
      "streams %j and preserves method",
      async (body) => {
        const response = await worker.fetch(
          new Request("https://example.test/", { method: "POST", body }),
          env,
          createExecutionContext(),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Method")).toBe("POST");
        expect(await response.text()).toBe(body);
      },
    );
  });
}
