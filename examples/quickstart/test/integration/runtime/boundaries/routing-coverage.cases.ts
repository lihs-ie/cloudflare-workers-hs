import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { routingCoverageProbe, routingProbe } from "../../../Support/Runtime/harness.js";

export function registerRoutingCoverageCases(): void {
  describe("Servant response resource ownership", () => {
    it("serves the GET body of the HEAD-compatible fixture", async () => {
      const response = await routingProbe("head", new Request("https://fixture.test/"), createExecutionContext());
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Result")).toBe("present");
      expect(await response.text()).toBe("payload");
    });
    it("delegates the public content parser helper for matching and rejected media", async () => {
      const response = await routingCoverageProbe("custom-parser-helper", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{ Right: "input" }, null]);
    });
    it("rejects unsupported content types through the custom parser", async () => {
      const response = await routingCoverageProbe("custom-typeclass-response", new Request("https://fixture.test/", { headers: { "Content-Type": "text/plain" } }), createExecutionContext(), new ReadableStream());
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: { status: 415, message: "Unsupported Media Type" } });
      const recovery = await routingCoverageProbe("custom-typeclass-response", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(recovery.status).toBe(207);
      expect(await recovery.text()).toBe("input-response");
    });
    it("supports downstream content, parser and method instances", async () => {
      const response = await routingCoverageProbe("custom-typeclass-response", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(response.status).toBe(207);
      expect(response.headers.get("Content-Type")).toBe("application/x-contract");
      expect(response.headers.get("X-Contract")).toBe("custom");
      expect(await response.text()).toBe("input-response");
    });
    it("supports custom methods and content types for streams", async () => {
      const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("custom-stream")); controller.close(); } });
      const response = await routingCoverageProbe("custom-typeclass-stream", new Request("https://fixture.test/", { headers: { Accept: "application/x-contract" } }), createExecutionContext(), source);
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Type")).toBe("application/x-contract");
      expect(await response.text()).toBe("custom-stream");
    });
    it("supports custom methods for no-content responses", async () => {
      const response = await routingCoverageProbe("custom-typeclass-no-content", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    });

    for (const [mode, path, expected] of [
      ["handler-operations", "/", [5, 12, 7, 9, 10, 40, 413, 5]],
      ["context-forwarding", "/fixed/1/2?one=3&many=4&flag", 42],
      ["named-routes-context", "/", 42],
      ["malformed-header-bytes", "/", "�"],
    ] as const) {
      it(`${mode} exercises public contracts`, async () => {
        const response = await routingCoverageProbe(mode, new Request(`https://fixture.test${path}`), createExecutionContext(), new ReadableStream());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      });
    }
    for (const mode of ["cache-raw-path", "no-content-context"]) {
      it(`${mode} consumes its arguments`, async () => {
        const context = createExecutionContext();
        const passThrough = vi.spyOn(context, "passThroughOnException");
        try {
          const response = await routingCoverageProbe(mode, new Request(mode === "cache-raw-path" ? "https://fixture.test/a/b" : "https://fixture.test/"), context, new ReadableStream());
          if (mode === "cache-raw-path") {
            expect(await response.json()).toEqual(["a", "b"]);
          } else {
            expect(response.status).toBe(204);
            expect(await response.text()).toBe("");
          }
          expect(passThrough).toHaveBeenCalledTimes(1);
        } finally {
          passThrough.mockRestore();
        }
      });
    }
    for (const method of ["GET", "POST"]) {
      it(`method choice executes its ${method} handler`, async () => {
        const response = await routingProbe("method-choice", new Request("https://fixture.test/", { method }), createExecutionContext());
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(method.toLowerCase());
      });
    }
    it("converts unknown base routing modes to a sanitized 500 and recovers", async () => {
      const response = await routingProbe("unknown-mode", new Request("https://fixture.test/"), createExecutionContext());
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      const recovery = await routingProbe("method-choice", new Request("https://fixture.test/"), createExecutionContext());
      expect(recovery.status).toBe(200);
      expect(await recovery.text()).toBe("get");
    });
    it("converts unknown coverage modes to a sanitized 500 and recovers", async () => {
      const response = await routingCoverageProbe("unknown-mode", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      const recovery = await routingCoverageProbe("named-context-route", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(recovery.status).toBe(200);
      expect(await recovery.json()).toBe(42);
    });

    it("preserves Unicode response metadata and body", async () => {
      const response = await routingCoverageProbe("unicode-headers", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(response.headers.get("X-Name")).toBe("café");
      expect(await response.json()).toBe("body-é");
    });
    it("preserves environment and context through streaming routes", async () => {
      const context = createExecutionContext();
      const passThrough = vi.spyOn(context, "passThroughOnException");
      try {
        const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("stream-body")); controller.close(); } });
        const response = await routingCoverageProbe("stream-context", new Request("https://fixture.test/"), context, source);
        expect(response.status).toBe(206);
        expect(response.headers.get("X-Environment")).toBe("stream-env");
        expect(await response.text()).toBe("stream-body");
        expect(passThrough).toHaveBeenCalledTimes(1);
      } finally {
        passThrough.mockRestore();
      }
    });
    it("supports useful public error diagnostics", async () => {
      const response = await routingCoverageProbe("error-diagnostics", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(await response.json()).toEqual([
        expect.stringContaining('serverErrorMessage = "Payload Too Large"'),
        expect.stringContaining('serverErrorMessage = "Unsupported Media Type"'),
        true,
      ]);
    });
    for (const [mode, status, message] of [["payload-error", 413, "Payload Too Large"], ["media-error", 415, "Unsupported Media Type"], ["renderer-rejection", 406, "Not Acceptable"]] as const) {
      it(`${mode} emits complete error metadata and body`, async () => {
        const response = await routingCoverageProbe(mode, new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
        expect(response.status).toBe(status);
        expect(response.headers.get("Content-Type")).toBe("application/json;charset=utf-8");
        expect(await response.json()).toEqual({ error: { status, message } });
      });
    }
    for (const [mode, expected] of [["named-context-route", 42]] as const) {
      it(`${mode} preserves downstream inputs`, async () => {
        const response = await routingCoverageProbe(mode, new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      });
    }
    for (const [mode, expected] of [["environment-context", "environment-preserved"], ["assets-context", "assets-environment"]] as const) {
      it(`${mode} preserves environment and execution context`, async () => {
        const context = createExecutionContext();
        const passThrough = vi.spyOn(context, "passThroughOnException");
        try {
          const response = await routingCoverageProbe(mode, new Request("https://fixture.test/"), context, new ReadableStream());
          expect(await response.json()).toBe(expected);
          expect(passThrough).toHaveBeenCalledTimes(1);
        } finally {
          passThrough.mockRestore();
        }
      });
    }

    for (const [mode, expected] of [["long-error", "é".repeat(512) + "... (truncated)"], ["limit-error", "é".repeat(512)]] as const) {
      for (const accept of ["application/json", "text/plain"]) {
        it(`${mode} bounds Unicode diagnostics for ${accept}`, async () => {
          const response = await routingCoverageProbe(mode, new Request("https://fixture.test/", { headers: { Accept: accept } }), createExecutionContext(), new ReadableStream());
          expect(response.status).toBe(400);
          if (accept === "application/json") {
            expect(await response.json()).toEqual({ error: { status: 400, message: "Bad Request", detail: expected } });
          } else {
            expect(await response.text()).toBe(`Bad Request: ${expected}`);
          }
        });
      }
    }
    it("retrieves a value from a named context", async () => {
      const response = await routingCoverageProbe("named-context-value", new Request("https://fixture.test/"), createExecutionContext(), new ReadableStream());
      expect(response.status).toBe(200);
      expect(await response.json()).toBe(42);
    });
    for (const method of ["GET", "HEAD"]) {
      it(`${method} preserves response headers and body semantics for an opaque stream`, async () => {
        const response = await routingCoverageProbe("stream-headers", new Request("https://fixture.test/", { method }), createExecutionContext(), new ReadableStream());
        expect(response.status).toBe(206);
        expect(response.headers.get("X-Download")).toBe("attachment");
        expect(response.headers.get("X-Version")).toBe("7");
        expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
        expect(await response.text()).toBe(method === "HEAD" ? "" : "download");
      });
    }
    for (const method of ["GET", "HEAD"]) {
      it(`${method} emits NoContent metadata without a serialization content type`, async () => {
        const response = await routingCoverageProbe("no-content-headers", new Request("https://fixture.test/", { method }), createExecutionContext(), new ReadableStream());
        expect(response.status).toBe(200);
        expect(response.headers.get("X-Version")).toBe("7");
        expect(response.headers.has("Content-Type")).toBe(false);
        expect(await response.text()).toBe("");
      });
    }
    for (const [path, expected] of [["/download/alice/a/b", ["alice", ["a", "b"]]], ["/download/alice", ["alice", []]]] as const) {
      it(`passes only residual path segments to Raw for ${path}`, async () => {
        const response = await routingCoverageProbe("raw-residual", new Request(`https://fixture.test${path}`), createExecutionContext(), new ReadableStream());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      });
    }
  });
}
