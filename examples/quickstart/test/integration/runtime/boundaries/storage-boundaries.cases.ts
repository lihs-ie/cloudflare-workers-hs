import { describe, expect, it } from "vitest";
import { queueOutcome, d1DecoderBoundaries, storageNativeProbe } from "../../../Support/Runtime/harness.js";

export function registerStorageBoundaryCases(): void {
  registerStorageNativeCases();
  describe("WASM storage rejection boundaries", () => {
    const rejections = [
      ["Invalid JSON payload", "QueueInvalidBodyRejection"],
      ["structured clone rejected", "QueueInvalidBodyRejection"],
      ["delay out of range", "QueueDelayOutOfRangeRejection"],
      ["batch count exceeds limit", "QueueBatchCountOutOfRangeRejection"],
      ["batch total bytes too large", "QueueBatchBytesTooLargeRejction"],
      ["message size exceeds 128 KiB", "QueueBodyTooLargeRejection"],
      ["service unavailable", "QueueOtherRejection"],
    ];
    for (const command of ["send", "batch"]) {
      for (const [message, kind] of rejections) {
        it(`${command} preserves ${kind} and recovers after native rejection`, async () => {
          let calls = 0;
          const operation = async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error(message);
            }
          };
          const producer = { send: operation, sendBatch: operation };
          const outcome = await queueOutcome(producer, command);
          expect(outcome).toContain(command === "batch" ? "QueueSendBatchFailed" : "QueueSendFailed");
          expect(outcome).toContain(kind);
          expect(outcome).toContain(message);
          expect(await queueOutcome(producer, command)).toBe("ok");
          expect(calls).toBe(2);
        });
      }
      it(`${command} catches synchronous native throws and remains usable`, async () => {
        const operation = () => { throw new Error("native sync failure"); };
        expect(await queueOutcome({ send: operation, sendBatch: operation }, command)).toContain("native sync failure");
        const success = async () => {};
        expect(await queueOutcome({ send: success, sendBatch: success }, command)).toBe("ok");
      });
    }
    it("decodes typed D1 failures, WASM Int boundaries and recovery", async () => {
      expect(await d1DecoderBoundaries()).toBe("ok");
    });
  });
}


function registerStorageNativeCases(): void {
  describe("native-shaped storage contracts", () => {
    for (const command of ["legacy-send", "legacy-batch", "public-send", "public-batch", "json", "clone-v8"]) {
      it(`forwards ${command} once through the native producer`, async () => {
        const observed: unknown[] = [];
        const operation = async (body: unknown) => { observed.push(body); };
        expect(await queueOutcome({ send: operation, sendBatch: operation }, command)).toBe("ok");
        expect(observed).toHaveLength(1);
        if (command === "json") {
          expect(observed[0]).toEqual({ value: 1 });
        }
      });
    }
    for (const command of ["invalid-json", "invalid-json-batch"]) {
      it(`rejects ${command} before calling the producer and recovers`, async () => {
        let calls = 0;
        const operation = async () => { calls += 1; };
        const producer = { send: operation, sendBatch: operation };
        expect(await queueOutcome(producer, command)).toContain("QueueInvalidBodyRejection");
        expect(calls).toBe(0);
        expect(await queueOutcome(producer, "json")).toBe("ok");
        expect(calls).toBe(1);
      });
    }
    const meta = { duration: 1 };
    const databaseFixture = (success: boolean, rows: unknown[], batchCount = 2) => {
      const statement = { bind: (..._values: unknown[]) => statement,
        all: async () => ({ success, results: rows, meta }),
        first: async () => rows[0] ?? null,
        run: async () => ({ success, meta }),
      };
      return { prepare: (_sql: string) => statement,
        batch: async (_statements: unknown[]) => Array.from({ length: batchCount }, () => ({ success, meta })),
      };
    };
    it("distinguishes unsuccessful query, execute, and batch native responses", async () => {
      for (const command of ["d1-query", "d1-execute", "d1-batch"]) {
        expect(await storageNativeProbe(databaseFixture(false, []), command)).toContain("D1UnsuccessfulResult");
        expect(await storageNativeProbe(databaseFixture(true, [{ value: 42 }]), command)).not.toContain("D1UnsuccessfulResult");
      }
      expect(await storageNativeProbe(databaseFixture(true, [], 1), "d1-batch")).toContain("D1UnsuccessfulResult");
    });
    it("reports typed row failures and preserves first-row absence", async () => {
      expect(await storageNativeProbe(databaseFixture(true, [{ value: 1 }, { value: null }]), "d1-query")).toContain('D1RowDecodeFailed 2 (D1UnexpectedNull "value")');
      expect(await storageNativeProbe(databaseFixture(true, [{ value: null }]), "d1-first")).toContain('D1RowDecodeFailed 1 (D1UnexpectedNull "value")');
      expect(await storageNativeProbe(databaseFixture(true, []), "d1-first")).toBe("Nothing");
      expect(await storageNativeProbe(databaseFixture(true, [{ value: 42 }]), "d1-first")).toBe("Just 42");
    });
    it("checks Queue byte/count/delay boundaries in WASM without native calls", async () => {
      expect(await storageNativeProbe({}, "queue-validation")).toBe("ok");
    });
    it("checks D1 compositional decoders, wrong types, and preflight validation in WASM", async () => {
      expect(await storageNativeProbe({}, "d1-combinators")).toBe("ok");
    });
    it("rejects invalid R2 ranges before touching the bucket", async () => {
      let calls = 0;
      const result = await storageNativeProbe({ get: async () => { calls += 1; return null; } }, "r2-range-invalid");
      expect(result.split("R2GetFailed")).toHaveLength(6);
      expect(result).toContain("negative");
      expect(result).toContain("largest integer");
      expect(calls).toBe(0);
    });
    it("validates alarm writes before the native call and forwards deletion", async () => {
      const calls: unknown[] = [];
      const storage = { setAlarm: async (time: number) => { calls.push(time); }, deleteAlarm: async () => { calls.push("delete"); } };
      expect(await storageNativeProbe(storage, "alarm-set-negative")).toContain("must not be negative");
      expect(await storageNativeProbe(storage, "alarm-set-unsafe")).toContain("safe integer range");
      expect(calls).toEqual([]);
      expect(await storageNativeProbe(storage, "alarm-set")).toBe("ok");
      expect(await storageNativeProbe(storage, "alarm-delete")).toBe("ok");
      expect(calls).toEqual([123, "delete"]);
    });
    for (const command of ["r2-delete", "r2-delete-many"]) {
      it(`retains ${command} failure and succeeds on retry`, async () => {
        const calls: unknown[] = [];
        const bucket = { delete: async (key: unknown) => { calls.push(key); if (calls.length === 1) { throw Error("delete rejected"); } } };
        expect(await storageNativeProbe(bucket, command)).toContain("R2DeleteFailed");
        expect(await storageNativeProbe(bucket, command)).toBe("ok");
        expect(calls[1]).toEqual(command === "r2-delete" ? "key" : ["first", "second"]);
      });
    }
    it("preserves DO write/transaction failures and invalid stored byte values", async () => {
      for (const command of ["do-put", "do-transaction"]) {
        const failed = { put: async () => { throw Error("storage write failed"); }, transaction: async () => { throw Error("storage write failed"); } };
        expect(await storageNativeProbe(failed, command)).toContain("storage write failed");
        const success = { put: async () => {}, transaction: async (action: (txn: { put: () => Promise<void> }) => Promise<void>) => action({ put: async () => {} }) };
        expect(await storageNativeProbe(success, command)).toBe(command === "do-put" ? "ok" : "Right ()");
      }
      expect(await storageNativeProbe({ list: async () => new Map([["key", { invalid: true }]]) }, "do-list")).toContain("DurableObjectStorageFailed");
      expect(await storageNativeProbe({ list: async () => new Map([["key", new Uint8Array([97])]]) }, "do-list")).toBe('[("key","a")]');
    });
    it("preserves R2 put/create/upload/list rejection and recovers on a later call", async () => {
      for (const command of ["r2-put", "r2-create", "r2-upload", "r2-list"]) {
        const failure = async () => { throw Error("R2 operation failed"); };
        const bucket = { put: failure, createMultipartUpload: failure, list: failure, resumeMultipartUpload: () => ({ key: "key", uploadId: "upload", uploadPart: failure }) };
        expect(await storageNativeProbe(bucket, command)).toContain("R2 operation failed");
      }
      expect(await storageNativeProbe({ put: async () => null }, "r2-put")).toBe("R2PutPreconditionFailed");
      const listed = await storageNativeProbe({ list: async () => ({ objects: [], truncated: true, cursor: "next", delimitedPrefixes: ["folder/"] }) }, "r2-list");
      expect(listed).toContain('r2ListResultCursor = Just "next"');
      expect(listed).toContain('"folder/"');
    });
    const objectMeta = { key: "key", version: "version", size: 3, etag: "etag", httpEtag: '"etag"', checksums: {}, uploaded: new Date(123), storageClass: "Standard" };
    it("restores multipart completion after rejection and rejects upload after completion", async () => {
      let calls = 0;
      const upload = { key: "key", uploadId: "upload", complete: async () => {
        calls += 1;
        if (calls === 1) { throw Error("completion rejected"); }
        return objectMeta;
      }, uploadPart: async () => { throw Error("must not reach native upload"); } };
      const result = await storageNativeProbe({ resumeMultipartUpload: () => upload }, "r2-complete-retry");
      expect(result).toContain("completion rejected");
      expect(result).toContain('Right "version"');
      expect(result).toContain("R2MultipartTerminal");
      expect(calls).toBe(2);
    });
    it("decodes R2 absent objects, conditional metadata and its body-reader escape hatch", async () => {
      expect(await storageNativeProbe({ get: async () => null }, "r2-get-body")).toBe("missing");
      expect(await storageNativeProbe({ get: async () => objectMeta }, "r2-get-body")).toBe("precondition:version:Nothing");
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("abc")); controller.close(); } });
      expect(await storageNativeProbe({ get: async () => ({ ...objectMeta, body }) }, "r2-get-body")).toBe('Right "abc"');
    });
    it("retains head failure, missing result, unknown range and optional HTTP metadata", async () => {
      expect(await storageNativeProbe({ head: async () => { throw Error("head rejected"); } }, "r2-head")).toContain("R2HeadFailed");
      expect(await storageNativeProbe({ head: async () => null }, "r2-head")).toBe("Nothing");
      const result = await storageNativeProbe({ head: async () => ({ ...objectMeta, range: {}, httpMetadata: { contentType: "text/plain", cacheExpiry: new Date(456) }, customMetadata: { purpose: "test" } }) }, "r2-head");
      expect(result).toContain("r2ObjectMetaRange = Nothing");
      expect(result).toContain('r2HttpMetadataContentType = Just "text/plain"');
      expect(result).toContain("r2HttpMetadataCacheExpiry = Just 456");
    });
    it("observes R2 absent metadata, cursor, encryption checksum and future storage class", async () => {
      const result = await storageNativeProbe({ head: async () => ({ ...objectMeta, httpMetadata: {}, ssecKeyMd5: "checksum", storageClass: "FutureClass" }) }, "r2-head");
      expect(result).toContain("r2HttpMetadataCacheExpiry = Nothing");
      expect(result).toContain('r2ObjectMetaSsecKeyMd5 = Just "checksum"');
      expect(result).toContain('R2OtherStorageClass "FutureClass"');
      expect(await storageNativeProbe({ list: async () => ({ objects: [], truncated: false, delimitedPrefixes: [] }) }, "r2-list")).toContain("r2ListResultCursor = Nothing");
      const options: unknown[] = [];
      await storageNativeProbe({ put: async (_key: string, _body: unknown, value: unknown) => { options.push(value); return null; } }, "r2-put-other-class");
      expect(options).toEqual([expect.objectContaining({ storageClass: "FutureClass" })]);
      expect(await storageNativeProbe({}, "r2-large-batch")).toContain("at most 1000 keys");
    });
    for (const [command, method, value, expected] of [
      ["r2-body-array", "arrayBuffer", new Uint8Array([97]).buffer, '"a"'],
      ["r2-body-bytes", "bytes", new Uint8Array([97]), '"a"'],
      ["r2-body-text", "text", "text", "text"],
      ["r2-body-json", "json", { value: 1 }, '{"value":1}'],
      ["r2-body-blob", "blob", new Blob(["a"]), "blob"],
    ] as const) {
      it(`preserves ${method} rejection and reads a fresh object afterwards`, async () => {
        const make = (operation: () => Promise<unknown>) => ({ get: async () => ({ ...objectMeta, body: new ReadableStream(), [method]: operation }) });
        expect(await storageNativeProbe(make(async () => { throw Error("body rejected"); }), command)).toContain("R2GetFailed");
        expect(await storageNativeProbe(make(async () => value), command)).toBe(expected);
      });
    }
    for (const [range, expected] of [
      [{ offset: 1, length: 2 }, "R2RangeOffsetLength 1 2"],
      [{ offset: 1 }, "R2RangeOffset 1"],
      [{ length: 2 }, "R2RangeLength 2"],
      [{ suffix: 2 }, "R2RangeSuffix 2"],
    ]) {
      it(`decodes native R2 ${expected} and omitted metadata`, async () => {
        const result = await storageNativeProbe({ head: async () => ({ ...objectMeta, range }) }, "r2-head");
        expect(result).toContain(String(expected));
        expect(result).toContain('r2ObjectMetaVersion = "version"');
        expect(result).toContain("r2HttpMetadataContentType = Nothing");
      });
    }
    it("restores multipart ownership after an abort failure and consumes it after success", async () => {
      let calls = 0;
      const upload = { key: "key", uploadId: "upload", abort: async () => {
        calls += 1;
        if (calls === 1) { throw new Error("abort failed"); }
      } };
      const result = await storageNativeProbe({ resumeMultipartUpload: () => upload }, "r2-abort-retry");
      expect(result).toContain('R2MultipartFailed "Error: abort failed"');
      expect(result).toContain("Right ()");
      expect(result).toContain("R2MultipartTerminal");
      expect(calls).toBe(2);
    });
  });
}
