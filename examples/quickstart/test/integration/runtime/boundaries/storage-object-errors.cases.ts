import { describe, expect, it } from "vitest";
import { storageObjectErrors } from "../../../Support/Runtime/harness.js";

export function registerStorageObjectErrorCases(): void {
  describe("public Durable Object wrapper error recovery", () => {
    const identifier = "a".repeat(64);
    it("observes an identifier produced from a name and restored from storage", async () => {
      const observed: string[] = [];
      const namespace = {
        idFromName(name: string) { observed.push(name); return { toString: () => identifier }; },
        idFromString(value: string) { observed.push(value); return { toString: () => identifier }; },
      };
      expect(await storageObjectErrors(namespace, "name")).toBe(identifier);
      expect(await storageObjectErrors(namespace, "restore")).toBe(identifier);
      expect(observed).toEqual(["named-object", "stored-identifier"]);
      expect(await storageObjectErrors({ idFromString() { throw Error("bad identifier"); } }, "restore"))
        .toContain("DurableObjectInvalidIDString");
    });
    it("preserves RPC classification and observes a successful return payload", async () => {
      expect(await storageObjectErrors({ echo: async () => { throw Error("RPC unavailable"); } }, "rpc"))
        .toContain("DurableObjectRPCFailed");
      expect(await storageObjectErrors({ echo: async (arg: string) => `${arg}:returned` }, "rpc"))
        .toBe("argument:returned");
    });
    for (const [command, method, returned, expected] of [
      ["get", "get", new Uint8Array([97, 98, 99]), 'Just "abc"'],
      ["put", "put", undefined, "()"],
      ["delete", "delete", true, "True"],
      ["list", "list", new Map([["prefix-key", new Uint8Array([97])]]), '[("prefix-key","a")]'],
      ["set-alarm", "setAlarm", undefined, "()"],
      ["delete-alarm", "deleteAlarm", undefined, "()"],
    ] as const) {
      it(`${command} converts native failures to DurableObjectStorageFailed and recovers`, async () => {
        let calls = 0;
        const args: unknown[][] = [];
        const storage = { [method]: async (...values: unknown[]) => {
          calls += 1;
          args.push(values);
          if (calls === 1) { throw Error(`${command} unavailable`); }
          return returned;
        } };
        const failed = await storageObjectErrors(storage, command);
        expect(failed).toContain("DurableObjectStorageFailed");
        expect(failed).toContain(`${command} unavailable`);
        expect(await storageObjectErrors(storage, command)).toBe(expected);
        expect(calls).toBe(2);
        if (command === "list") {
          expect(args[1]).toEqual([{ prefix: "prefix", reverse: true, limit: 2 }]);
        }
        if (command === "set-alarm") { expect(args[1]).toEqual([123]); }
      });
    }
    it("observes transaction deletion and retains typed transaction failure", async () => {
      expect(await storageObjectErrors({ transaction: async () => { throw Error("transaction unavailable"); } }, "transaction"))
        .toContain("Left (DurableObjectStorageFailed");
      const keys: string[] = [];
      const txn = { delete: async (key: string) => { keys.push(key); return true; } };
      expect(await storageObjectErrors({ transaction: async (action: (value: typeof txn) => Promise<unknown>) => action(txn) }, "transaction"))
        .toBe("Right ()");
      expect(keys).toEqual(["key"]);
    });
    it("retains request query parameters and rejects body read failures before native fetch", async () => {
      const urls: string[] = [];
      const stub = { fetch: async (request: Request) => { urls.push(request.url); return new Response("ok", { status: 201 }); } };
      expect(await storageObjectErrors(stub, "fetch-exceeded")).toContain("exceeded the doFetch probe byte limit");
      expect(await storageObjectErrors(stub, "fetch-stalled")).toContain("body stream stalled");
      expect(urls).toEqual([]);
      expect(await storageObjectErrors(stub, "fetch-query")).toBe("Status {statusCode = 201}");
      expect(urls).toEqual(["https://do-internal.invalid/object?key=value"]);
    });
    it("decodes InfrequentAccess storage class as its documented constructor", async () => {
      const meta = { key: "key", version: "version", size: 0, etag: "etag", httpEtag: '"etag"',
        checksums: {}, uploaded: new Date(123), storageClass: "InfrequentAccess" };
      expect(await storageObjectErrors({ head: async () => meta }, "head"))
        .toContain("r2ObjectMetaStorageClass = R2InfrequentAccess");
    });
  });
}
