import { expect, it } from "vitest";
import { cacheServiceErrorsProbe } from "../../../Support/Runtime/harness.js";

const probe = async (handle: unknown, command: string) =>
  JSON.parse(await cacheServiceErrorsProbe(handle, command));

async function withCache<T>(open: () => unknown, action: () => Promise<T>): Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(caches, "open");
  Object.defineProperty(caches, "open", { configurable: true, value: open });
  try {
    return await action();
  } finally {
    if (previous) {
      Object.defineProperty(caches, "open", previous);
    } else {
      Reflect.deleteProperty(caches, "open");
    }
  }
}

const cacheProbe = (cache: unknown, command: string) =>
  withCache(() => cache, () => probe(null, command));
const emptyResponse = () => new Response(null, { status: 204, headers: { "x-fixture": "response" } });

export function registerCacheServiceErrorsCases(): void {
  it("converts cache open rejection to CacheOpenFailed and allows subsequent open", async () => {
    const result = await withCache(() => Promise.reject(new Error("open failed")), () => probe(null, "open"));
    expect(result).toMatchObject({ ok: false, kind: "CacheOpenFailed" });
    expect(result.message).toContain("open failed");
    expect(await cacheProbe({}, "open")).toEqual({ ok: true, value: { opened: true } });
  });

  it("classifies cache put failures while forwarding a public Request key and response", async () => {
    for (const [message, kind] of [
      ["request method invalid", "CachePutInvalidMethod"],
      ["status 206", "CachePutPartialResponse"],
      ["Vary: *", "CachePutVaryWildcard"],
      ["not cacheable", "CachePutNotCacheableOrTooLarge"],
      ["too large", "CachePutNotCacheableOrTooLarge"],
      ["storage unavailable", "CachePutOther"],
    ]) {
      const result = await cacheProbe({ put() { throw new Error(message); } }, "put");
      expect(result).toMatchObject({ ok: false, kind: `CachePutRejected:${kind}` });
      expect(result.message).toContain(message);
    }
    let calls = 0;
    const result = await cacheProbe({ async put(request: Request, response: Response) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("x-fixture")).toBe("request");
      expect(await response.text()).toBe("payload");
      calls += 1;
    } }, "put");
    expect(result).toEqual({ ok: true, value: { stored: true } });
    expect(calls).toBe(1);
  });

  it("converts cache delete failures and observes false and true settlements with ignoreMethod", async () => {
    expect(await cacheProbe({ delete() { throw new Error("delete failed"); } }, "delete"))
      .toMatchObject({ ok: false, kind: "CacheDeleteFailed" });
    for (const deleted of [false, true]) {
      expect(await cacheProbe({ delete(request: Request, options: CacheQueryOptions) {
        expect(request.url).toBe("https://cache.example/fixture?key=1");
        expect(options.ignoreMethod).toBe(true);
        return Promise.resolve(deleted);
      } }, "delete")).toEqual({ ok: true, value: { deleted } });
    }
  });

  it("decodes absent and bodyless cache matches and catches response getter failures", async () => {
    for (const absent of [null, undefined]) {
      expect(await cacheProbe({ match: () => absent }, "match"))
        .toEqual({ ok: true, value: { missing: true } });
    }
    const failures = [
      { match() { throw new Error("match failed"); } },
      { match: () => ({ get status() { throw new Error("status getter"); } }) },
      { match: () => ({ status: 200, get headers() { throw new Error("headers getter"); } }) },
      { match: () => ({ status: 200, headers: new Headers(), get body() { throw new Error("body getter"); } }) },
      ...[-1, 0.5, NaN, 2147483648].map((status) => ({ match: () => ({ status }) })),
    ];
    for (const cache of failures) {
      expect(await cacheProbe(cache, "match")).toMatchObject({ ok: false, kind: "CacheMatchFailed" });
      expect(await cacheProbe({ match: emptyResponse }, "match")).toEqual({ ok: true, value: {
        status: 204, headers: [["x-fixture", "response"]], body: { kind: "bytes", length: 0 },
      } });
    }
    expect(await cacheProbe({ match: () => new Response("stream") }, "match"))
      .toMatchObject({ ok: true, value: { status: 200, body: { kind: "stream" } } });
  });

  for (const [command, kind] of [["assets", "AssetsFetchFailed"], ["service", "ServiceFetchFailed"]]) {
    it(`converts ${command} native failures and invalid response decoding to ${kind}`, async () => {
      const failures = [
        { fetch() { throw new Error("native failed"); } },
        { get fetch() { throw new Error("fetch getter"); } },
        { fetch: () => ({ get status() { throw new Error("status getter"); } }) },
        { fetch: () => ({ status: 200, get headers() { throw new Error("headers getter"); } }) },
        { fetch: () => ({ status: 200, headers: new Headers(), get body() { throw new Error("body getter"); } }) },
        ...[-1, 0.25, Infinity, 2147483648].map((status) => ({ fetch: () => ({ status }) })),
      ];
      for (const binding of failures) {
        expect(await probe(binding, command)).toMatchObject({ ok: false, kind });
        expect(await probe({ fetch(request: Request) {
          expect(request.headers.get("x-fixture")).toBe("request");
          return emptyResponse();
        } }, command)).toEqual({ ok: true, value: {
          status: 204, headers: [["x-fixture", "response"]], body: { kind: "bytes", length: 0 },
        } });
      }
      expect(await probe({ fetch: () => new Response("stream") }, command))
        .toMatchObject({ ok: true, value: { body: { kind: "stream" } } });
    });
  }

  it("classifies invalid service request construction before invoking the binding", async () => {
    let calls = 0;
    expect(await probe({ fetch() { calls += 1; return emptyResponse(); } }, "service-invalid-request"))
      .toMatchObject({ ok: false, kind: "ServiceFetchFailed" });
    expect(calls).toBe(0);
  });

  it("returns service RPC failures as Left and forwards arguments and receiver during recovery", async () => {
    for (const binding of [{}, { operation() { throw new Error("RPC failed"); } }]) {
      const result = await probe(binding, "call");
      expect(result.ok).toBe(true);
      expect(result.value.callError).toContain("ServiceCallFailed");
    }
    expect(await probe({ prefix: "receiver:", operation(this: { prefix: string }, argument: string) {
      return this.prefix + argument;
    } }, "call")).toEqual({ ok: true, value: { output: "receiver:argument" } });
  });

  it("preserves the custom purge option contract independently of native availability", async () => {
    for (const [command, options] of [
      ["purge-tags", { tags: ["tag-one", "tag-two"] }],
      ["purge-prefixes", { pathPrefixes: ["/one", "/two"] }],
      ["purge-all", { purgeEverything: true }],
    ] as const) {
      expect(await probe({ cache: { purge(actual: unknown) {
        expect(actual).toEqual(options);
        return { success: false, errors: [{ code: 42, message: "policy rejection" }] };
      } } }, command)).toEqual({ ok: true, value: { success: false, errors: [[42, "policy rejection"]] } });
    }
  });

  it("converts rejected, malformed, and throwing purge results to CachePurgeFailed and recovers", async () => {
    const failures = [
      {},
      { cache: { purge() { throw new Error("purge failed"); } } },
      { cache: { purge() { throw { toString() { throw new Error("unprintable"); } }; } } },
      ...[null, {}, { success: "true" },
        { get success() { throw new Error("success getter"); } },
        { success: false, get errors() { throw new Error("errors getter"); } },
        { success: false, errors: [{ code: -1, message: "invalid" }] },
      ].map((result) => ({ cache: { purge: () => result } })),
    ];
    for (const context of failures) {
      expect(await probe(context, "purge-all")).toMatchObject({ ok: false, kind: "CachePurgeFailed" });
      expect(await probe({ cache: { purge: () => ({ success: true }) } }, "purge-all"))
        .toEqual({ ok: true, value: { success: true, errors: [] } });
    }
  });

  it("reads the cached stream payload through the public Haskell consumer", async () => {
    for (const bytes of [[0, 127, 128, 255], []]) {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (bytes.length > 0) {
            controller.enqueue(new Uint8Array(bytes));
          }
          controller.close();
        },
      });
      expect(await cacheProbe({ match: () => new Response(body) }, "match-read"))
        .toEqual({ ok: true, value: { bytes } });
      expect(pulls).toBe(1);
    }
  });

  it("catches every late custom-purge field failure without leaking unhandled rejections", async () => {
    let successReads = 0;
    let errorsReads = 0;
    let changedErrorsReads = 0;
    const throwingEntry: unknown[] = [null];
    Object.defineProperty(throwingEntry, "0", {
      get() { throw new Error("entry getter failed"); },
    });
    const throwingLength = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length getter failed");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const results = [
      { success: false, errors: [{ code: 42, get message() { throw new Error("message getter failed"); } }] },
      { get success() {
        successReads += 1;
        if (successReads === 1) {
          return false;
        }
        throw new Error("second success read failed");
      } },
      { success: false, get errors() {
        errorsReads += 1;
        if (errorsReads === 1) {
          return [];
        }
        throw new Error("second errors read failed");
      } },
      { success: "malformed", get errors() { throw new Error("diagnostic getter failed"); } },
      { success: false, errors: throwingEntry },
      { success: false, errors: throwingLength },
      { success: false, get errors() {
        changedErrorsReads += 1;
        return changedErrorsReads === 1 ? [] : {};
      } },
      { success: false, errors: new Array(2147483648) },
    ];
    for (const result of results) {
      expect(await probe({ cache: { purge: () => result } }, "purge-all"))
        .toMatchObject({ ok: false, kind: "CachePurgeFailed" });
      expect(await probe({ cache: { purge: () => ({ success: true }) } }, "purge-all"))
        .toEqual({ ok: true, value: { success: true, errors: [] } });
    }
    expect(successReads).toBe(2);
    expect(errorsReads).toBe(2);
    expect(changedErrorsReads).toBe(2);
  });

  it("reads public cache-policy selectors and reports comparable configuration diagnostics", async () => {
    const result = await probe(null, "policy-contract");
    expect(result.ok).toBe(true);
    expect(result.value.policies).toEqual([
      { maxAge: 10, sharedMaxAge: 20, stale: 30, header: "public, max-age=10, s-maxage=20, stale-while-revalidate=30" },
      { maxAge: null, sharedMaxAge: null, stale: null, header: "private" },
    ]);
    for (const [key, constructor] of [
      ["directive", "CachePublic"], ["query", "CacheQueryOptions"],
      ["purge", "PurgeTags"], ["error", "CachePurgeError"],
    ]) {
      expect(result.value[key]).toMatchObject({ matches: true, differs: true });
      expect(result.value[key].summary).toContain(constructor);
      expect(result.value[key].batch).toBe(`[${result.value[key].summary}]`);
      expect(result.value[key].nested).toBe(`(${result.value[key].summary})`);
    }
  });

  it("compares actual typed purge and cache failures with expected errors and renders diagnostics", async () => {
    const results = [
      await probe({ cache: { purge: () => ({ success: false, errors: [{ code: 42, message: "policy rejection" }] }) } }, "purge-contract"),
      await probe({ cache: { purge() { throw new Error("purge failed"); } } }, "purge-failure-contract"),
    ];
    for (const result of results) {
      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({ matches: true, differs: true });
      expect(result.value.summary).toContain("CachePurge");
      expect(result.value.batch).toBe(`[${result.value.summary}]`);
      expect(result.value.nested).toBe(`(${result.value.summary})`);
    }
    const put = await cacheProbe({ put() { throw new Error("request method invalid"); } }, "put-contract");
    expect(put.ok).toBe(true);
    expect(put.value.failure).toMatchObject({ matches: true, differs: true });
    expect(put.value.failure.summary).toBe('CachePutRejected CachePutInvalidMethod "Error: request method invalid"');
    expect(put.value.failure.batch).toBe(`[${put.value.failure.summary}]`);
    expect(put.value.failure.nested).toBe(`(${put.value.failure.summary})`);
    expect(put.value.kind).toEqual({
      matches: true, differs: true,
      summary: "CachePutInvalidMethod", batch: "[CachePutInvalidMethod]", nested: "CachePutInvalidMethod",
    });
  });


  it("compares and displays public Assets and ServiceBinding error values", async () => {
    for (const [command, constructor] of [["assets-contract", "AssetsFetchFailed"], ["service-contract", "ServiceFetchFailed"]]) {
      const failure = await probe({ fetch() { throw new Error("fetch failed"); } }, command);
      expect(failure.ok).toBe(true);
      expect(failure.value).toEqual({
        matches: true, differs: true,
        summary: `${constructor} "Error: fetch failed"`,
        batch: `[${constructor} "Error: fetch failed"]`,
        nested: `(${constructor} "Error: fetch failed")`,
      });
      expect(await probe({ fetch: emptyResponse }, command))
        .toMatchObject({ ok: true, value: { status: 204, body: { kind: "bytes", length: 0 } } });
    }
  });

  it("reports invalid fixture modes and unsatisfied scenario preconditions without poisoning subsequent probes", async () => {
    const results = [
      [await cacheProbe({}, "unknown-mode"), "Unknown cache/service scenario"],
      [await probe({ cache: { purge: () => ({ success: true }) } }, "purge-failure-contract"), "Expected typed purge rejection"],
      [await cacheProbe({ put() {} }, "put-contract"), "Expected typed cache put rejection"],
      [await cacheProbe({ match: emptyResponse }, "match-read"), "Expected cached stream body"],
      [await cacheProbe({ match: () => undefined }, "match-read"), "Expected cache hit"],
    ];
    for (const [result, message] of results) {
      expect(result).toMatchObject({ ok: false, kind: "UnexpectedException" });
      expect(result.message).toContain(message);
      expect(await cacheProbe({}, "open")).toEqual({ ok: true, value: { opened: true } });
    }
  });

  it("reports a cached stream read error and recovers with a new cached response", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("cached stream failed"));
      },
    }));
    const result = await cacheProbe({ match: () => response }, "match-read");
    expect(result).toMatchObject({ ok: false, kind: "UnexpectedException" });
    expect(result.message).toContain("cached stream failed");
    const oversized = await cacheProbe({ match: () => new Response(new Uint8Array(1025)) }, "match-read");
    expect(oversized).toMatchObject({ ok: false, kind: "UnexpectedException" });
    expect(oversized.message).toContain("ReadableStreamExceededByteLimit");
    expect(await cacheProbe({ match: () => new Response(new Uint8Array([17, 255])) }, "match-read"))
      .toEqual({ ok: true, value: { bytes: [17, 255] } });
  });

}
