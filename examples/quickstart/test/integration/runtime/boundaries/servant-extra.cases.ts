import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { clientServiceProbe, routingProbe } from "../../../Support/Runtime/harness.js";

export function registerServantExtraCases(): void {
  describe("Client fixture input and decoding contracts", () => {
    it("rejects misspelled modes before dispatch and recovers on a valid mode", async () => {
      let calls = 0;
      const binding = {
        async fetch() {
          calls += 1;
          return new Response("recovered");
        },
      };
      const failure = JSON.parse(await clientServiceProbe(binding, "bufffered"));
      expect(failure.ok).toBe(false);
      expect(failure.message).toContain("Unknown client fixture mode: bufffered");
      expect(calls).toBe(0);
      expect(JSON.parse(await clientServiceProbe(binding, "buffered"))).toEqual({
        ok: true,
        value: "recovered",
      });
      expect(calls).toBe(1);
    });
    it("decodes malformed response UTF-8 with replacement and preserves valid bytes", async () => {
      const binding = {
        async fetch() {
          return new Response(new Uint8Array([0x61, 0xff, 0x62]));
        },
      };
      expect(JSON.parse(await clientServiceProbe(binding, "buffered"))).toEqual({
        ok: true,
        value: "a\ufffdb",
      });
    });
  });
  describe("Servant independent retry conditions", () => {
    for (const mode of ["stream-put", "buffered-put", "zero-retry", "negative-retry"]) {
      it(`${mode} respects replay eligibility`, async () => {
        const original = globalThis.fetch;
        let calls = 0;
        const bodies: string[] = [];
        try {
          globalThis.fetch = async (input, init) => {
            calls += 1;
            bodies.push(await new Request(input, init).text());
            if (calls === 1) { throw new Error("network failed"); }
            return new Response("recovered");
          };
          const result = JSON.parse(await clientServiceProbe({}, mode));
          expect(result.ok).toBe(mode === "buffered-put");
          expect(calls).toBe(mode === "buffered-put" ? 2 : 1);
          if (mode === "buffered-put") { expect(bodies).toEqual(["repeatable", "repeatable"]); }
          if (mode === "stream-put") { expect(bodies).toEqual(["firstsecond"]); }
          globalThis.fetch = async () => new Response("next");
          expect(JSON.parse(await clientServiceProbe({}, "global-buffered"))).toEqual({ok: true, value: "next"});
        } finally { globalThis.fetch = original; }
      });
    }
    for (const [mode, status, ok] of [["accept-418", 418, true], ["accept-none", 200, false], ["buffered", 500, false]] as const) {
      it(`${mode} applies explicit accepted status without transport retry`, async () => {
        let calls = 0;
        const result = JSON.parse(await clientServiceProbe({fetch: async () => { calls += 1; return new Response("payload", {status}); }}, mode));
        expect(result.ok).toBe(ok);
        expect(calls).toBe(1);
        if (ok) { expect(result.value).toBe("payload"); }
      });
    }
    it("preserves the service transport across applicative and monadic composition", async () => {
      let calls = 0;
      let globalCalls = 0;
      const original = globalThis.fetch;
      try {
        globalThis.fetch = async () => { globalCalls += 1; return new Response("wrong transport"); };
        const result = JSON.parse(await clientServiceProbe({fetch: async () => new Response(String(++calls))}, "composed"));
        expect(result).toEqual({ok: true, value: "123"});
        expect(calls).toBe(3);
        expect(globalCalls).toBe(0);
      } finally { globalThis.fetch = original; }
    });
    it("retries an aborted idempotent request and recovers", async () => {
      const original = globalThis.fetch;
      let calls = 0;
      try {
        globalThis.fetch = async (input, init) => {
          calls += 1;
          if (calls > 1) { return new Response("after-timeout"); }
          const request = new Request(input, init);
          return await new Promise<Response>((_resolve, reject) => {
            const abort = () => reject(new DOMException("timed out", "AbortError"));
            if (request.signal.aborted) { abort(); } else { request.signal.addEventListener("abort", abort, {once: true}); }
          });
        };
        expect(JSON.parse(await clientServiceProbe({}, "retry"))).toEqual({ok: true, value: "after-timeout"});
        expect(calls).toBe(2);
      } finally { globalThis.fetch = original; }
    });
  });
  it("preserves all sixteen delayed failure boundaries", async () => {
    const response = await routingProbe("delayed-matrix", new Request("https://fixture.test/"), createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["recoverable", "fatal"].flatMap(kind => ["capture", "method", "auth", "accept", "content", "params", "headers", "body"].map(stage => `${kind}-${stage}`)));
  });
  it("does not read body before method, accept, or content validation", async () => {
    const response = await routingProbe("body-reader-matrix", new Request("https://fixture.test/"), createExecutionContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["method", "accept", "content", "missing-content-type", "empty-body", "limit", "recovery"]);
  });
  it("reports both invalid query occurrences", async () => {
    const response = await routingProbe("parameters", new Request("https://fixture.test/?many=bad&many[]=wrong"), createExecutionContext());
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("bad");
    expect(body).toContain("wrong");
  });
  describe("Servant parameter occurrence semantics", () => {
    for (const [query, status, expected] of [
      ["one=&one=7", 400, null], ["one&one=7", 200, [null, [], false, null]],
      ["flag=1", 200, [null, [], true, null]], ["flag=", 200, [null, [], true, null]],
      ["flag=TRUE", 200, [null, [], false, null]], ["flag=false&flag=true", 200, [null, [], false, null]],
      ["many=1&unrelated=x&many[]=2&many", 200, [null, [1, 2], false, null]],
      ["many=bad&many[]=wrong", 400, null],
    ] as const) {
      it(query, async () => {
        const response = await routingProbe("parameters", new Request(`https://fixture.test/?${query}`), createExecutionContext());
        expect(response.status).toBe(status);
        if (expected !== null) { expect(await response.json()).toEqual(expected); }
      });
    }
  });
}
