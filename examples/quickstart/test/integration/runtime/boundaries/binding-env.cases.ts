import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { bindingEnvProbe } from "../../../Support/Runtime/harness.js";

const required = {
  REQUIRED_VAR: "configuration",
  REQUIRED_SECRET: "private-value",
};
const configuration = async (env: unknown) =>
  JSON.parse(await bindingEnvProbe(env, "configuration"));

export function registerBindingEnvCases(): void {
  it("reports invalid consumer output and rejected RPC without poisoning typed bindings", async () => {
    const healthy = {
      KV: { async get() { return "restored"; } },
      SERVICE: { async decorate(value: string) { return `service:${value}`; } },
    };
    for (const [bindings, diagnostic] of [
      [{ ...healthy, KV: { async get() { return null; } } }, "Expected text configuration value"],
      [{ ...healthy, SERVICE: { async decorate() { throw new Error("service-consumer-failed"); } } }, "service-consumer-failed"],
    ] as const) {
      const rejected = JSON.parse(await bindingEnvProbe(bindings, "native-consumer"));
      expect(rejected.ok).toBe(false);
      expect(rejected.message).toContain(diagnostic);
      expect(JSON.parse(await bindingEnvProbe(healthy, "native-consumer"))).toEqual({
        ok: true, value: { configuration: "restored", decorated: "service:restored" },
      });
    }
  });
  it("reports typed namespace RPC failure and recovers through the same accessor", async () => {
    const rejected = JSON.parse(await bindingEnvProbe({ ROOMS: {
      getByName() { return { async operation() { throw new Error("namespace-consumer-failed"); } }; },
    } }, "namespace-rpc"));
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("namespace-consumer-failed");
    expect(JSON.parse(await bindingEnvProbe({ ROOMS: {
      getByName() { return { async operation() { return [1, 2, 3]; } }; },
    } }, "namespace-rpc"))).toEqual({ok: true, value: {persisted: "[1,2,3]"}});
  });
  it("rejects unknown environment commands and accepts a following valid command", async () => {
    const rejected = JSON.parse(await bindingEnvProbe({}, "unknown-command"));
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("Unknown binding environment scenario");
    expect(JSON.parse(await bindingEnvProbe({}, "empty"))).toEqual({ok: true, value: {bindings: 0, namespaces: 0}});
  });
  it("handles a missing binding by its exact exception type and recovers after configuration is supplied", async () => {
    expect(JSON.parse(await bindingEnvProbe({}, "typed-missing"))).toEqual({
      ok: true,
      value: { missing: "REQUIRED_VAR", recoverable: true },
    });
    // A malformed present value is a different failure and must not be mistaken
    // for missing configuration by the typed catch.
    const malformed = JSON.parse(await bindingEnvProbe({ REQUIRED_VAR: 7 }, "typed-missing"));
    expect(malformed.ok).toBe(false);
    expect(malformed.message).toContain("Expected a string configuration binding");
    expect(JSON.parse(await bindingEnvProbe({ REQUIRED_VAR: "restored" }, "typed-missing"))).toEqual({
      ok: true,
      value: { value: "restored" },
    });
  });
  it("uses converted KV and service bindings through typed consumers", async () => {
    const calls: string[] = [];
    const bindings = {
      KV: {
        value: "configured-value",
        async get(key: string, options: { type: string }) {
          calls.push(`get:${key}:${options.type}`);
          return this.value;
        },
      },
      SERVICE: {
        prefix: "service:",
        async decorate(value: string) {
          calls.push(`decorate:${value}`);
          return this.prefix + value;
        },
      },
    };
    expect(JSON.parse(await bindingEnvProbe(bindings, "native-consumer"))).toEqual({
      ok: true,
      value: { configuration: "configured-value", decorated: "service:configured-value" },
    });
    expect(calls).toEqual(["get:configuration-key:text", "decorate:configured-value"]);
  });
  it("reports manually constructed missing and wrong Dynamic bindings without poisoning later calls", async () => {
    for (const [mode,message] of [["missing-map","no binding registered"],["wrong-type","unexpected runtime type"],["missing-namespace","no dos binding registered"]]) {
      const result=JSON.parse(await bindingEnvProbe({},mode));
      expect(result.ok).toBe(false);
      expect(result.message).toContain(message);
      expect((await configuration(required)).ok).toBe(true);
    }
  });
  it("uses the typed namespace accessor to call a real Durable Object with persisted bytes", async () => {
    const stub=env.STORAGE.getByName("env-proof");
    await stub.operation("put","env-proof-key",[0,128,255]);
    try {
      const result=JSON.parse(await bindingEnvProbe({ROOMS:env.STORAGE},"namespace-rpc"));
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.value.persisted)).toEqual([0,128,255]);
    } finally { await stub.operation("delete","env-proof-key",[]); }
  });
  const bindingNames = [
    "ASSETS",
    "DB",
    "ROOMS",
    "STORAGE",
    "KV",
    "QUEUE",
    "BUCKET",
    "SERVICE",
    "WORKFLOW",
  ];
  it("requires every declared native binding and recovers with a complete configuration", async () => {
    const complete = Object.fromEntries(bindingNames.map((name) => [name, {}]));
    for (const name of bindingNames) {
      const incomplete = { ...complete };
      delete incomplete[name];
      const rejected = JSON.parse(await bindingEnvProbe(incomplete, "native"));
      expect(rejected.ok).toBe(false);
      expect(rejected.message).toContain(name);
      expect(JSON.parse(await bindingEnvProbe(complete, "native"))).toEqual({
        ok: true,
        value: { names: [...bindingNames].sort() },
      });
    }
  });
  describe("Typed environment boundaries through WASM", () => {
    it("preserves empty required values and distinguishes absent optional values", async () => {
      expect(
        await configuration({ REQUIRED_VAR: "", REQUIRED_SECRET: "" }),
      ).toEqual({
        ok: true,
        value: {
          requiredVar: "",
          requiredSecretLength: 0,
          optionalVar: null,
          optionalSecretLength: null,
        },
      });
      expect(
        await configuration({
          ...required,
          OPTIONAL_VAR: "",
          OPTIONAL_SECRET: "",
        }),
      ).toEqual({
        ok: true,
        value: {
          requiredVar: "configuration",
          requiredSecretLength: 13,
          optionalVar: "",
          optionalSecretLength: 0,
        },
      });
      const present = await configuration({
        ...required,
        OPTIONAL_VAR: "optional",
        OPTIONAL_SECRET: "hidden",
      });
      expect(present.value.optionalVar).toBe("optional");
      expect(present.value.optionalSecretLength).toBe(6);
    });
    for (const value of [null, undefined]) {
      it(`accepts optional ${String(value)} without coercing it`, async () => {
        const result = await configuration({
          ...required,
          OPTIONAL_VAR: value,
          OPTIONAL_SECRET: value,
        });
        expect(result.ok).toBe(true);
        expect(result.value.optionalVar).toBeNull();
        expect(result.value.optionalSecretLength).toBeNull();
      });
    }
    for (const name of ["REQUIRED_VAR", "REQUIRED_SECRET"] as const) {
      it(`reports missing ${name} and recovers`, async () => {
        const env: Partial<typeof required> = { ...required };
        delete env[name];
        const result = await configuration(env);
        expect(result.ok).toBe(false);
        expect(result.message).toContain(name);
        expect((await configuration(required)).ok).toBe(true);
      });
    }
    for (const name of [
      "REQUIRED_VAR",
      "REQUIRED_SECRET",
      "OPTIONAL_VAR",
      "OPTIONAL_SECRET",
    ]) {
      it(`rejects non-string ${name} without disclosing configuration`, async () => {
        const invalid: unknown[] = [
          1,
          false,
          [],
          { secret: "do-not-disclose" },
          new String("do-not-disclose"),
        ];
        if (name.startsWith("REQUIRED")) {
          invalid.push(null, undefined);
        }
        for (const value of invalid) {
          const result = await configuration({ ...required, [name]: value });
          expect(result.ok).toBe(false);
          expect(result.message).toContain(
            "Expected a string configuration binding",
          );
          expect(result.message).not.toContain("do-not-disclose");
          expect(result.message).not.toContain(required.REQUIRED_SECRET);
        }
        expect((await configuration(required)).ok).toBe(true);
      });
    }
    it("uses only enumerable own properties and evaluates getters once", async () => {
      expect((await configuration(Object.create(required))).ok).toBe(false);
      let reads = 0;
      const env = {
        ...required,
        get OPTIONAL_VAR() {
          reads += 1;
          return "once";
        },
      };
      Object.defineProperty(env, "OPTIONAL_SECRET", {
        value: "not-enumerated",
        enumerable: false,
      });
      const result = await configuration(env);
      expect(result.value.optionalVar).toBe("once");
      expect(result.value.optionalSecretLength).toBeNull();
      expect(reads).toBe(1);
    });
    it("keeps invalid environments and throwing property traps inside the reactor boundary", async () => {
      const unprintable = {
        toString() {
          throw new Error("do-not-disclose");
        },
      };
      const broken = [
        null,
        undefined,
        {
          get REQUIRED_SECRET() {
            throw unprintable;
          },
        },
        new Proxy(
          {},
          {
            ownKeys() {
              throw unprintable;
            },
          },
        ),
      ];
      for (const value of broken) {
        const result = await configuration(value);
        expect(result.ok).toBe(false);
        expect(result.message).toContain("Could not read Worker environment");
        expect(result.message).not.toContain("do-not-disclose");
        expect((await configuration(required)).ok).toBe(true);
      }
    });
    it("builds an empty binding set and checks required DO namespaces", async () => {
      expect(JSON.parse(await bindingEnvProbe({}, "empty"))).toEqual({
        ok: true,
        value: { bindings: 0, namespaces: 0 },
      });
      const missing = JSON.parse(await bindingEnvProbe({}, "namespace"));
      expect(missing.ok).toBe(false);
      expect(missing.message).toContain("ROOMS");
      expect(
        JSON.parse(await bindingEnvProbe({ ROOMS: {} }, "namespace")),
      ).toEqual({ ok: true, value: { names: ["ROOMS"] } });
    });
  });
}
