import { createExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { accessVerificationProbe, accessRoutesProbe, routingProbe, clientServiceProbe } from "../../../Support/Runtime/harness.js";

export function registerServantCases(): void {
  describe("Servant routes through real WASM", () => {
    for (const [mode, method, path, status] of [
      ["no-content-get", "GET", "/", 204], ["no-content-delete", "DELETE", "/", 204],
      ["no-content-failure", "DELETE", "/", 400], ["no-content-get", "POST", "/", 405],
      ["head", "HEAD", "/", 200], ["method-choice", "PUT", "/", 405],
      ["capture-all", "GET", "/1/2", 200], ["capture-all", "GET", "/oops", 400],
      ["empty", "GET", "/", 404],
    ] as const) {
      it(`${mode} ${method} ${path}`, async () => {
        const response = await routingProbe(mode, new Request(`https://fixture.test${path}`, { method }), createExecutionContext());
        expect(response.status).toBe(status);
        if (method === "HEAD" || status === 204) { expect(await response.text()).toBe(""); }
        if (mode === "head") { expect(response.headers.get("X-Result")).toBe("present"); }
        if (mode === "method-choice") {
          const allow = response.headers.get("Allow") ?? "";
          expect(allow).toContain("GET"); expect(allow).toContain("POST");
        }
      });
    }
    for (const mode of ["empty-prefix", "named-context"]) {
      it(`reaches the ${mode} route instance`, async () => {
        const response = await routingProbe(mode, new Request("https://fixture.test/"), createExecutionContext());
        expect(response.status).toBe(200);
        expect(await response.json()).toBe(42);
      });
    }
    for (const flag of ["flag", "flag=1", "flag="]) {
      it(`recognizes the flag form ${flag} with semicolon separators`, async () => {
        const response = await routingProbe("parameters", new Request(`https://fixture.test/?one=7;${flag}`), createExecutionContext());
        expect(await response.json()).toEqual([7, [], true, null]);
      });
    }
    for (const [path, count, status] of [["/12", "3", 200], ["/bad", "3", 400], ["/12", "bad", 400]] as const) {
      it(`keeps delayed capture/header failures before Raw: ${path} ${count}`, async () => {
        const response = await routingProbe("capture-raw", new Request(`https://fixture.test${path}`, { headers: {"X-Count": count} }), createExecutionContext());
        expect(response.status).toBe(status);
        if (status === 200) { expect(await response.json()).toEqual([12, 3]); }
      });
    }
    for (const [method, accept, status] of [["GET", "application/octet-stream", 206], ["HEAD", "*/*", 206], ["POST", "*/*", 405], ["GET", "text/plain", 406]] as const) {
      it(`negotiates the native stream ${method} ${accept}`, async () => {
        const response = await routingProbe("native-stream", new Request("https://fixture.test/", {method, headers:{Accept:accept}}), createExecutionContext());
        expect(response.status).toBe(status);
        if (status === 206) {
          expect(response.headers.get("X-Stream")).toBe("present");
          expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
          expect(await response.text()).toBe(method === "HEAD" ? "" : "stream-body");
        }
      });
    }
    it("checks parameter, body, fallback and cache contracts through the router", async () => {
      const response = await routingProbe("matrix", new Request("https://fixture.test/"), createExecutionContext());
      expect(response.status).toBe(200);
      const names: unknown = await response.json();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toHaveLength(27);
    });
  });
  describe("Access public verification metadata and native failure paths", () => {
    let keys: CryptoKeyPair;
    let jwk: JsonWebKey;
    const issuer = "https://runtime-team.cloudflareaccess.com";
    const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const encodeJSON = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
    beforeAll(async () => {
      keys = await crypto.subtle.generateKey({name:"RSASSA-PKCS1-v1_5", modulusLength:2048, publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256"}, true, ["sign","verify"]);
      jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    });
    async function signed(claims: Record<string, unknown>): Promise<string> {
      const input = encodeJSON({alg:"RS256", kid:"metadata-key"}) + "." + encodeJSON(claims);
      const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(input)));
      return input + "." + encode(signature);
    }
    async function verify(mode: string, claims: Record<string, unknown>) {
      const token = await signed(claims);
      const original = globalThis.fetch;
      try {
        globalThis.fetch = async (input, init) => {
          expect(new Request(input, init).url).toBe(issuer + "/cdn-cgi/access/certs");
          return Response.json({keys:[{...jwk,kid:"metadata-key"}]});
        };
        return JSON.parse(await accessVerificationProbe(JSON.stringify({mode,token}), {}));
      } finally { globalThis.fetch = original; }
    }
    for (const mode of ["user", "service"]) {
      it(`returns verified ${mode} audience, issuer and expiration using default options`, async () => {
        const expiresAt = Math.floor(Date.now()/1000) + 3600;
        const common = {aud:["runtime-audience","secondary"], iss:issuer, exp:expiresAt};
        const claims = mode === "user" ? {...common,email:"member@example.test",sub:"member"} : {...common,common_name:"client.access",sub:""};
        const result = await verify(mode, claims);
        expect(result).toEqual(mode === "user"
          ? {ok:true,identity:"member@example.test",subject:"member",audience:common.aud,issuer,expiresAt}
          : {ok:true,identity:"client.access",audience:common.aud,issuer,expiresAt});
        const rejected = await verify(mode === "user" ? "service" : "user", claims);
        expect(rejected.ok).toBe(false);
        expect(rejected.message).toContain(mode === "user" ? "expected service identity" : "expected user identity");
      });
    }
    for (const [name, expiryOffset, notBeforeOffset, message] of [
      ["future-valid-window", 120, 60, "not yet valid"],
      ["inverted-window", 60, 120, "inconsistent validity window"],
    ] as const) {
      it(`classifies signed ${name} and recovers`, async () => {
        const now = Math.floor(Date.now()/1000);
        const common = {aud:["runtime-audience"],iss:issuer,common_name:"client.access",sub:""};
        const failure = await verify("service", {...common,exp:now+expiryOffset,nbf:now+notBeforeOffset});
        expect(failure.ok).toBe(false);
        expect(failure.message).toContain(message);
        expect((await verify("service", {...common,exp:now+3600})).ok).toBe(true);
      });
    }
    it("detects synthetic access configuration changes and formats snapshot diagnostics", async () => {
      const result = JSON.parse(await accessVerificationProbe(JSON.stringify({mode: "value-diagnostics"}), {}));
      expect(result.jwkRequiresValue).toBe(true);
      expect(result.snapshots.map((snapshot: {name: string}) => snapshot.name)).toEqual([
        "assertion", "user", "service", "config", "policy", "access-error", "crypto-error", "key",
      ]);
      const changes = [1, 5, 4, 3, 3, 2, 1, 2];
      result.snapshots.forEach((snapshot: {unchanged: boolean; changesDetected: boolean[]; single: string; batch: string}, index: number) => {
        expect(snapshot.unchanged).toBe(true);
        expect(snapshot.changesDetected).toEqual(Array(changes[index]).fill(true));
        expect(snapshot.single.length).toBeGreaterThan(0);
        expect(snapshot.batch).toBe(`[${snapshot.single},${snapshot.single}]`);
      });
    });
    it("preserves typed Access exceptions through a generic exception consumer", async () => {
      const diagnostics = JSON.parse(await accessVerificationProbe(JSON.stringify({mode: "typed-error-diagnostics"}), {}));
      expect(diagnostics).toEqual([
        {sameError: true, diagnostic: "AccessErrorInvalidSignature"},
        {sameError: true, diagnostic: "AccessErrorExpored"},
        {sameError: true, diagnostic: "AccessErrorAudienceMismach"},
        {sameError: true, diagnostic: 'AccessErrorMalformed "synthetic diagnostic"'},
      ]);
      const recovered = await verify("user", {email: "user@example.test", sub: "user", aud: ["runtime-audience"], iss: issuer, exp: Math.floor(Date.now() / 1000) + 3600});
      expect(recovered.ok).toBe(true);
    });
    for (const [input, diagnostic] of [
      ["not-json", 'Unexpected "not-json", expecting JSON value'],
      ["[]", "Access probe"],
      ["{}", "mode"],
      [JSON.stringify({mode: "unknown"}), "Unknown Access probe mode"],
      [JSON.stringify({mode: "user"}), "expected header.payload.signature"],
      [JSON.stringify({mode: "crypto-public-verify", jwk: {kid: "bad", kty: "invalid"}}), "subtleImportKey: kid=runtime-probe"],
      [JSON.stringify({mode: "crypto-public-verify"}), "jwk"],
      [JSON.stringify({mode: "crypto-import"}), "jwk"],
    ] as const) {
      it(`reports invalid Access probe input ${input} and accepts the next command`, async () => {
        const failure = JSON.parse(await accessVerificationProbe(input, {}));
        expect(failure.ok).toBe(false);
        expect(failure.message).toContain(diagnostic);
        const recovered = JSON.parse(await accessVerificationProbe(JSON.stringify({mode: "ping"}), {}));
        expect(recovered).toEqual({ok: true});
      });
    }
    it("reports a non-object JWK before native key import", async () => {
      const nativeImport = vi.spyOn(crypto.subtle, "importKey");
      try {
        const keyFailure = JSON.parse(await accessVerificationProbe(JSON.stringify({mode: "crypto-import", jwk: 42}), {}));
        expect(keyFailure.ok).toBe(false);
        expect(keyFailure.message).toContain("JWK");
        expect(keyFailure.message).toContain("Number");
        expect(nativeImport).not.toHaveBeenCalled();
        const recovered = JSON.parse(await accessVerificationProbe(JSON.stringify({mode: "ping"}), {}));
        expect(recovered).toEqual({ok: true});
      } finally {
        nativeImport.mockRestore();
      }
    });
    it("converts native import rejection and then imports a valid key", async () => {
      const failure = JSON.parse(await accessVerificationProbe(JSON.stringify({mode:"crypto-import",jwk:{...jwk,kid:"bad-usage",key_ops:["sign"]}}), {}));
      expect(failure.ok).toBe(false);
      expect(failure.message).toContain("SubtleCryptoError");
      expect(JSON.parse(await accessVerificationProbe(JSON.stringify({mode:"crypto-import",jwk:{...jwk,kid:"valid"}}), {}))).toEqual({ok:true});
    });
    it("converts public subtleVerify rejection and recovers after restoring crypto", async () => {
      const input = JSON.stringify({mode:"crypto-public-verify",jwk:{...jwk,kid:"public-verify"}});
      const rejected = vi.spyOn(crypto.subtle, "verify").mockRejectedValue(new Error("public-verify-rejected"));
      try {
        const failure = JSON.parse(await accessVerificationProbe(input, {}));
        expect(failure.ok).toBe(false);
        expect(failure.message).toContain("SubtleCryptoError");
        expect(failure.message).toContain("subtleVerify: verifyRS256: public-verify-rejected");
      } finally { rejected.mockRestore(); }
      expect(JSON.parse(await accessVerificationProbe(input, {}))).toEqual({ok:true,verified:false});
    });
    for (const token of [".payload.signature", "header..signature", "header.payload."]) {
      it(`rejects an empty JWT component before fetching: ${token}`, async () => {
        const nativeFetch = vi.spyOn(globalThis, "fetch");
        const nativeVerify = vi.spyOn(crypto.subtle, "verify");
        try {
          const failure = JSON.parse(await accessVerificationProbe(JSON.stringify({mode:"service",token}), {}));
          expect(failure.ok).toBe(false);
          expect(failure.message).toContain("expected header.payload.signature");
          expect(nativeFetch).not.toHaveBeenCalled();
          expect(nativeVerify).not.toHaveBeenCalled();
        } finally { nativeFetch.mockRestore(); nativeVerify.mockRestore(); }
        expect((await verify("service", {common_name:"client.access",sub:"",aud:["runtime-audience"],iss:issuer,exp:Math.floor(Date.now()/1000)+3600})).ok).toBe(true);
      });
    }
    it("reuses the service verifier cache through public options", async () => {
      const token = await signed({common_name:"client.access",sub:"",aud:["runtime-audience"],iss:issuer,exp:Math.floor(Date.now()/1000)+3600});
      const nativeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({keys:[{...jwk,kid:"metadata-key"}]}));
      try {
        const options = {mode:"service",token,cacheTtl:300,jwksURL:"https://cache-public-contract.example/certs"};
        const first = JSON.parse(await accessVerificationProbe(JSON.stringify(options), {}));
        const second = JSON.parse(await accessVerificationProbe(JSON.stringify(options), {}));
        expect(first.ok).toBe(true);
        expect(second).toEqual(first);
        expect(nativeFetch).toHaveBeenCalledTimes(1);
      } finally { nativeFetch.mockRestore(); }
    });
    it("returns a diagnostic for a correctly signed non-JSON payload", async () => {
      const input = encodeJSON({alg:"RS256",kid:"metadata-key"}) + "." + encode(new TextEncoder().encode("not JSON"));
      const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5",keys.privateKey,new TextEncoder().encode(input)));
      const nativeFetch = vi.spyOn(globalThis,"fetch").mockImplementation(async () => Response.json({keys:[{...jwk,kid:"metadata-key"}]}));
      try {
        const failure = JSON.parse(await accessVerificationProbe(JSON.stringify({mode:"user",token:input+"."+encode(signature)}), {}));
        expect(failure.ok).toBe(false);
        expect(failure.message).toContain("AccessErrorMalformed");
        expect(failure.message).not.toContain("verification failed");
        expect(failure.message).not.toContain("InvalidSignature");
      } finally { nativeFetch.mockRestore(); }
    });
    it("preserves the issuer mismatch diagnosis after successful signature validation", async () => {
      const failure = await verify("user", {email:"user@example.test",sub:"user",aud:["runtime-audience"],iss:"https://other.example",exp:Math.floor(Date.now()/1000)+3600});
      expect(failure.ok).toBe(false);
      expect(failure.message).toContain("issuer mismatch");
    });
    for (const mode of ["user", "user-bottom-config"]) {
      it(`masks pipeline exceptions and logs only their category for ${mode}`, async () => {
        const token = await signed({email:"user@example.test",sub:"user",aud:["runtime-audience"],iss:issuer,exp:Math.floor(Date.now()/1000)+3600});
        const logs: string[] = [];
        const logger = vi.spyOn(console,"log").mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(" ")); });
        const nativeFetch = vi.spyOn(globalThis,"fetch").mockImplementation(async () => Response.json({keys:[mode === "user" ? {...jwk,kid:"metadata-key",key_ops:["sign"]} : {...jwk,kid:"metadata-key"}]}));
        try {
          const failure = JSON.parse(await accessVerificationProbe(JSON.stringify({mode,token}), {}));
          expect(failure).toEqual({ok:false,message:'AccessErrorMalformed "verification failed"'});
          expect(logs).toContain(mode === "user" ? "SubtleCryptoError" : "SomeException");
          expect(logs.join(" ")).not.toContain(token);
          expect(logs.join(" ")).not.toContain("sensitive fixture marker");
        } finally { nativeFetch.mockRestore(); logger.mockRestore(); }
        expect((await verify("user", {email:"user@example.test",sub:"user",aud:["runtime-audience"],iss:issuer,exp:Math.floor(Date.now()/1000)+3600})).ok).toBe(true);
      });
    }
    for (const failureKind of ["error", "unprintable"] as const) {
      it(`preserves authentication failure when logging throws ${failureKind}, then recovers`, async () => {
        const loggingFailure = failureKind === "error"
          ? new Error("logging-failed-private-marker")
          : {
              get message(): never {
                throw new Error("message-access-private-marker");
              },
              [Symbol.toPrimitive](): never {
                throw new Error("stringification-private-marker");
              },
            };
        const logger = vi.spyOn(console, "log").mockImplementation(() => {
          throw loggingFailure;
        });
        try {
          const failure = JSON.parse(await accessVerificationProbe(JSON.stringify({mode: "user", token: "malformed"}), {}));
          expect(failure).toEqual({ok: false, message: 'AccessErrorMalformed "expected header.payload.signature"'});
          expect(logger).toHaveBeenCalledTimes(1);
          expect(logger).toHaveBeenCalledWith("AccessErrorMalformed");
        } finally {
          logger.mockRestore();
        }
        const recovered = await verify("user", {email: "user@example.test", sub: "user", aud: ["runtime-audience"], iss: issuer, exp: Math.floor(Date.now() / 1000) + 3600});
        expect(recovered.ok).toBe(true);
        expect(recovered.identity).toBe("user@example.test");
      });
    }
    it("enforces service route authentication and consumes nested context", async () => {
      const response = await accessRoutesProbe(new Request("https://fixture.test/"), createExecutionContext());
      expect(response.status).toBe(200);
      const names: unknown = await response.json();
      expect(names).toHaveLength(9);
    });
  });
  describe("Service Binding client body ownership", () => {
    for (const mode of ["throw", "abandon"]) {
      it(`cancels and releases an unread body on ${mode}, then recovers`, async () => {
        let cancelled = 0;
        const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } });
        const first = JSON.parse(await clientServiceProbe({ fetch() { return Promise.resolve(new Response(stream)); } }, mode));
        expect(first.ok).toBe(mode === "abandon");
        expect(cancelled).toBe(1);
        expect(stream.locked).toBe(false);
        const next = JSON.parse(await clientServiceProbe({ fetch() { return Promise.resolve(new Response("recovered")); } }, "buffered"));
        expect(next).toEqual({ ok: true, value: "recovered" });
      });
    }
    it("reports response stream failure and permits subsequent calls", async () => {
      const binding = { fetch() { return Promise.resolve(new Response(new ReadableStream({ pull(c) { c.error(new Error("body-failed")); } }), { status: 500 })); } };
      const failure = JSON.parse(await clientServiceProbe(binding, "drain"));
      expect(failure.ok).toBe(false);
      expect(failure.message).toContain("body-failed");
      expect(JSON.parse(await clientServiceProbe({ fetch() { return Promise.resolve(new Response("ok")); } }, "buffered"))).toEqual({ ok: true, value: "ok" });
    });
  });
  describe("Client transport response variants", () => {
    for (const mode of ["strict-request", "lazy-request", "global-strict-request", "global-lazy-request"]) {
      it(`preserves native request bytes for ${mode}`, async () => {
        const original = globalThis.fetch;
        const fetch = async (input: RequestInfo | URL) => new Response(await new Request(input).text());
        try {
          globalThis.fetch = fetch;
          const result = JSON.parse(await clientServiceProbe({fetch}, mode));
          expect(result).toEqual({ok: true, value: mode.includes("strict") ? "strict-body" : "lazy-body"});
        } finally { globalThis.fetch = original; }
      });
    }
    for (const mode of ["buffered", "global-buffered", "global-drain"]) {
      it(`propagates body failure on ${mode} and recovers`, async () => {
        const original = globalThis.fetch;
        const fetch = async () => new Response(new ReadableStream({pull(controller) {controller.error(new Error("reader-failure"));}}));
        try {
          globalThis.fetch = fetch;
          const failure = JSON.parse(await clientServiceProbe({fetch}, mode));
          expect(failure.ok).toBe(false);
          expect(failure.message).toContain("reader-failure");
          globalThis.fetch = async () => new Response("recovered");
          expect(JSON.parse(await clientServiceProbe({fetch: globalThis.fetch}, mode))).toEqual({ok:true, value:"recovered"});
        } finally { globalThis.fetch = original; }
      });
    }
    it("handles a successful empty streaming response", async () => {
      const original = globalThis.fetch;
      try {
        globalThis.fetch = async () => new Response(null, {status:204});
        expect(JSON.parse(await clientServiceProbe({}, "global-drain"))).toEqual({ok:true, value:""});
      } finally { globalThis.fetch = original; }
    });
    it("does not retry the global subrequest limit", async () => {
      const original = globalThis.fetch;
      let calls = 0;
      try {
        globalThis.fetch = async () => { calls += 1; throw new Error("Too many subrequests"); };
        const failure = JSON.parse(await clientServiceProbe({}, "global-retry"));
        expect(failure.ok).toBe(false);
        expect(calls).toBe(1);
      } finally { globalThis.fetch = original; }
    });
  });
  describe("Client request streaming and global fetch recovery", () => {
    for (const mode of ["stream-request", "stream-request-error"]) {
      it(`preserves request producer outcome: ${mode}`, async () => {
        const binding = { async fetch(request: Request) { return new Response(new TextDecoder().decode(await request.arrayBuffer())); } };
        const result = JSON.parse(await clientServiceProbe(binding, mode));
        if (mode === "stream-request") {
          expect(result).toEqual({ ok: true, value: "firstsecond" });
        } else {
          expect(result.ok).toBe(false);
          expect(result.message).toContain("client request producer failed");
        }
        expect(JSON.parse(await clientServiceProbe(binding, "stream-request"))).toEqual({ ok: true, value: "firstsecond" });
      });
    }
    for (const [mode, failures, expectedCalls, succeeds] of [
      ["global-retry", 2, 3, true],
      ["global-retry", 3, 3, false],
      ["global-no-retry-post", 3, 1, false],
    ] as const) {
      it(`${mode} preserves retry budget with ${failures} failures`, async () => {
        const original = globalThis.fetch;
        let calls = 0;
        try {
          globalThis.fetch = async () => {
            calls += 1;
            if (calls <= failures) { throw new Error("network connection failed"); }
            return new Response("recovered");
          };
          const result = JSON.parse(await clientServiceProbe({}, mode));
          expect(calls).toBe(expectedCalls);
          expect(result.ok).toBe(succeeds);
          if (succeeds) { expect(result.value).toBe("recovered"); }
          globalThis.fetch = async () => new Response("following-request");
          expect(JSON.parse(await clientServiceProbe({}, "global-buffered"))).toEqual({ ok: true, value: "following-request" });
        } finally {
          globalThis.fetch = original;
        }
      });
    }
    for (const mode of ["global-throw", "global-abandon"]) {
      it(`releases the global response reader on ${mode}`, async () => {
        const original = globalThis.fetch;
        let cancelled = 0;
        const body = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; } });
        try {
          globalThis.fetch = async () => new Response(body);
          const result = JSON.parse(await clientServiceProbe({}, mode));
          expect(result.ok).toBe(mode === "global-abandon");
          expect(cancelled).toBe(1);
          expect(body.locked).toBe(false);
        } finally {
          globalThis.fetch = original;
        }
      });
    }
  });
}
