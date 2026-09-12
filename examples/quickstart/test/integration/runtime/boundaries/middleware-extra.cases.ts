import { expect, it, vi } from "vitest";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

export function registerMiddlewareExtraCases(
  probe: (request: Request, context: ExecutionContext) => Promise<Response>,
) {
  it("logs middleware exception and recovers on the same runtime", async () => {
    const context = createExecutionContext();
    const response = await probe(new Request("https://example.test/middleware-failure"), context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    const result = await response.json() as {
      rejected: boolean;
      records: { level: string; request_id: string; message: string; duration_ms?: number; error_kind?: string }[];
    };
    expect(result.rejected).toBe(true);
    expect(result.records).toHaveLength(4);
    expect(result.records.every(record => record.request_id === "unknown")).toBe(true);
    const errors = result.records.filter(record => record.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("middleware-known-failure");
    expect(errors[0].error_kind).toBe("SomeException");
    expect(errors[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.records.filter(record => record.message === "request completed")).toHaveLength(1);
  });

  for (const registrationFails of [false, true]) {
    it(`uses the native structured logger with ${registrationFails ? "inline fallback" : "deferred registration"}`, async () => {
      const original = createExecutionContext();
      let registrations = 0;
      const context = new Proxy(original, {
        get(target, property) {
          if (property === "waitUntil") {
            return (promise: Promise<unknown>) => {
              registrations += 1;
              if (registrationFails) {
                throw new Error("controlled registration failure");
              }
              target.waitUntil(promise);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const response = await probe(new Request("https://example.test/middleware-native", {
          headers: { "x-hs-request-id": "native-request", "cf-ray": "native-ray" },
        }), context);
        await waitOnExecutionContext(original);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ rejected: true, records: [], registrationReceipts: ["()", "()"], formattedIdentifiers: ["00000000-0000-4000-8000-000000000000", "ffffffff-ffff-4fff-bfff-ffffffffffff"] });
        // Starts, completion, debug, and warn defer; errors emit inline. Default logging filters debug.
        expect(registrations).toBe(5);
        expect(log).toHaveBeenCalledTimes(5);
        expect(log).toHaveBeenCalledWith(expect.objectContaining({
          level: "info", request_id: "native-request", ray_id: "native-ray",
          method: "GET", path: "/middleware-native", status: 204,
          message: "request completed", duration_ms: expect.any(Number),
        }));
        expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", request_id: "native-level-check", message: "level dispatch" }));
        expect(log).toHaveBeenCalledWith(expect.objectContaining({
          level: "error", request_id: "native-request", error_kind: "SomeException",
          message: expect.stringContaining("middleware-known-failure"),
        }));
      } finally {
        log.mockRestore();
      }
    });
  }

  it("native zero sampling suppresses info while preserving errors and recovery", async () => {
    const context = createExecutionContext();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const response = await probe(new Request("https://example.test/middleware-sampled"), context);
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ rejected: true, records: [], formattedIdentifiers: ["00000000-0000-4000-8000-000000000000", "ffffffff-ffff-4fff-bfff-ffffffffffff"] });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({
        level: "error", request_id: "unknown",
        message: expect.stringContaining("middleware-known-failure"),
      }));
    } finally {
      log.mockRestore();
    }
  });
}
