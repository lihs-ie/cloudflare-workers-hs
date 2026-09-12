import { describe, expect, it } from "vitest";
import { storageErrorProbe } from "../../../Support/Runtime/harness.js";

export function registerStorageErrorCases(): void {
  it("executes a statement through public selectors and observes validated decoder composition", async () => {
    const seen: unknown[] = [];
    const database = { prepare(sql: string) {
      seen.push(sql);
      return { bind(...values: number[]) {
        seen.push(values);
        return { first: () => ({ value: values[0] }) };
      } };
    } };
    expect(await storageErrorProbe(database, "d1-selectors")).toBe('Just [("value",D1Real 1.25)]');
    expect(seen).toEqual(["SELECT ? AS value", [1.25]]);
    expect(await storageErrorProbe({}, "d1-composition")).toBe('D1ColumnTypeMismatch "a" D1IntegerType D1TextType');
    for (const cacheStatus of ["HIT", undefined]) {
      expect(await storageErrorProbe({ list: () => ({ keys: [], list_complete: true, cacheStatus }) }, "kv-cache-status")).toBe(cacheStatus ?? "missing");
    }
  });
  describe("public storage exception classification and recovery", () => {
    for (const operation of ["all", "first", "run", "batch", "exec"]) {
      for (const [message, expected] of [
        ["UNIQUE constraint failed", "D1ConstraintViolation"],
        ["syntax error near SELECT", "D1SyntaxError"],
        ["SQLITE_ERROR malformed query", "D1SyntaxError"],
        ["database unavailable", "D1UnknownError"],
      ]) {
        it(`D1 ${operation} classifies ${message} and recovers`, async () => {
          let calls = 0;
          const native = () => {
            calls += 1;
            if (calls === 1) {
              throw new Error(message);
            }
            if (operation === "first") {
              return { value: 1.25 };
            }
            if (operation === "exec") {
              return { count: 1, duration: 0.5 };
            }
            const result = { success: true, results: [{ value: 1.25 }], meta: { duration: 0.5 } };
            return operation === "batch" ? [result] : result;
          };
          const handle = { [operation]: native };
          const rejected = await storageErrorProbe(handle, `d1-${operation}`);
          expect(rejected).toContain(expected);
          expect(rejected).toContain(message);
          const recovered = await storageErrorProbe(handle, `d1-${operation}`);
          if (operation === "first") {
            expect(recovered).toBe('Just [("value",D1Real 1.25)]');
          } else if (operation === "exec") {
            expect(recovered).toBe("D1ExecResult {d1ExecResultCount = 1, d1ExecResultDuration = 0.5}");
          } else {
            const metadata = "D1Meta {d1MetaDuration = 0.5, d1MetaChanges = Nothing, d1MetaLastRowID = Nothing, d1MetaRowsRead = Nothing, d1MetaRowsWritten = Nothing}";
            const runResult = `D1RunResult {d1RunResultSuccess = True, d1RunResultMeta = ${metadata}}`;
            if (operation === "all") {
              expect(recovered).toBe(`D1Result {d1ResultResults = [[("value",D1Real 1.25)]], d1ResultSuccess = True, d1ResultMeta = ${metadata}}`);
            } else if (operation === "batch") {
              expect(recovered).toBe(`[${runResult}]`);
            } else {
              expect(recovered).toBe(runResult);
            }
          }
          expect(calls).toBe(2);
        });
      }
    }
    for (const operation of ["prepare", "bind"]) {
      for (const unprintable of [false, true]) {
        it(`catches synchronous D1 ${operation} failure (unprintable=${unprintable}) and recovers`, async () => {
          let calls = 0;
          const handle = {
            [operation]: () => {
              calls += 1;
              if (calls === 1) {
                if (unprintable) {
                  throw { toString() { throw new Error("conversion failed"); } };
                }
                throw new Error("native D1 failure");
              }
              return { first: () => ({ value: 1.25 }) };
            },
          };
          const command = operation === "prepare" ? "d1-prepare" : "d1-real";
          const failure = await storageErrorProbe(handle, command);
          expect(failure).toContain(unprintable ? `D1 ${operation} failed with an unprintable error` : "native D1 failure");
          expect(await storageErrorProbe(handle, command)).toBe('Just [("value",D1Real 1.25)]');
          expect(calls).toBe(2);
        });
      }
    }
    it("D1 binds fractional values and rejects unsafe integers before native binding", async () => {
      const observed: number[][] = [];
      const handle = {
        bind(...values: number[]) {
          observed.push(values);
          return { first: async () => ({ value: values[0] }) };
        },
      };
      expect(await storageErrorProbe(handle, "d1-real")).toContain("D1Real 1.25");
      for (const command of ["d1-unsafe-low", "d1-unsafe-high"]) {
        expect(await storageErrorProbe(handle, command)).toContain("outside the JavaScript safe integer range");
      }
      expect(observed).toEqual([[1.25]]);
    });
    for (const [command, method, expected] of [
      ["kv-get", "get", "KVGetFailed"],
      ["kv-metadata", "getWithMetadata", "KVGetWithMetadataFailed"],
      ["kv-many", "get", "KVBulkGetFailed"],
      ["kv-many-metadata", "getWithMetadata", "KVBulkGetFailed"],
      ["kv-put", "put", "KVPutFailed"],
      ["kv-delete", "delete", "KVDeleteFailed"],
      ["kv-list", "list", "KVListFailed"],
    ]) {
      it(`${command} converts native failure and observes recovered metadata`, async () => {
        let calls = 0;
        const handle = {
          [method]: async () => {
            calls += 1;
            if (calls === 1) {
              throw new Error("storage offline");
            }
            switch (command) {
              case "kv-get": return "value";
              case "kv-metadata": return { value: "value", metadata: { version: 2 }, cacheStatus: "HIT" };
              case "kv-many": return new Map([["key", "value"], ["missing", null]]);
              case "kv-many-metadata": return new Map([["key", { value: "value", metadata: { version: 2 }, cacheStatus: "HIT" }], ["missing", null]]);
              case "kv-list": return { keys: [{ name: "key", expiration: 123, metadata: { version: 2 } }, { name: "plain" }], list_complete: false, cursor: "next", cacheStatus: "HIT" };
              default: return undefined;
            }
          },
        };
        expect(await storageErrorProbe(handle, command)).toContain(expected);
        const recovered = await storageErrorProbe(handle, command);
        if (["kv-metadata", "kv-many-metadata", "kv-list"].includes(command)) {
          expect(recovered).toContain("HIT");
        } else if (["kv-put", "kv-delete"].includes(command)) {
          expect(recovered).toBe("ok");
        } else {
          expect(recovered).toContain("value");
        }
        expect(calls).toBe(2);
      });
    }
    it("validates D1 nonnumeric parameters and serializes low-level KV JSON", async () => {
      expect(await storageErrorProbe({}, "d1-validate")).toBe("ok");
      const observed: unknown[] = [];
      const handle = { put: async (_key: string, value: unknown) => { observed.push(value); } };
      expect(await storageErrorProbe(handle, "kv-ffi-json")).toBe("ok");
      expect(observed).toEqual([{ version: 2 }]);
    });
    it("rejects an empty SQL plan whose JSON encoding exceeds the limit before native work", async () => {
      let calls = 0;
      const handle = { transactionSync: () => { calls += 1; } };
      expect(await storageErrorProbe(handle, "sql-empty-limit")).toContain("SQL input exceeds byte limit");
      expect(calls).toBe(0);
      expect(await storageErrorProbe({}, "sql-value-shape")).toContain("Left");
      expect(await storageErrorProbe({}, "sql-result-shape")).toContain("Left");
    });
    it("accepts unspecified cache TTL", async () => {
      expect(await storageErrorProbe({}, "kv-default-ttl")).toBe("True");
    });
  });
}
