import { describe, expect, it } from "vitest";
import { sqlProbe } from "../../../Support/Runtime/harness.js";

export function registerSQLCases(): void {
  const fixture = (rows: unknown[][] = [[1.5, "text", null]]) => ({
    transactionSync: (action: () => unknown) => action(),
    sql: { exec: () => ({ columnNames: ["value"], rowsRead: rows.length, rowsWritten: 0, raw: () => rows }) },
  });
  describe("WASM DO SQL bounds and recovery", () => {
    for (const command of ["rows-negative", "rows-upper", "bytes-zero", "bytes-upper", "statements-zero", "statements-upper"]) {
      it(`rejects ${command} before native transaction`, async () => {
        expect(await sqlProbe({}, command)).toContain("Invalid SQL result limits");
      });
    }
    for (const command of ["statement-limit", "empty-sql", "long-sql", "parameter-count", "nan", "infinite", "unsafe-integer"]) {
      it(`rejects ${command} before SQL serialization`, async () => {
        expect(await sqlProbe({}, command)).toContain("Invalid SQL statement or parameter");
      });
    }
    it("rejects oversized serialized input before accessing storage", async () => {
      expect(await sqlProbe({}, "input-bytes")).toContain("SQL input exceeds byte limit");
    });
    it("decodes blob, null, text and numeric result cells", async () => {
      const result = await sqlProbe(fixture([[new Uint8Array([0, 255]).buffer, null, "text", 1.5]]), "blob-input");
      expect(result).toContain("SQLBlob");
      expect(result).toContain("SQLNull");
      expect(result).toContain('SQLText "text"');
      expect(result).toContain("SQLNumber 1.5");
      expect(await sqlProbe({}, "json-unknown")).toContain("Unknown SQL value tag");
    });
    it("limits output rows and bytes and accepts subsequent valid output", async () => {
      expect(await sqlProbe(fixture([[1]]), "output-rows")).toContain("SQL output exceeds row limit");
      expect(await sqlProbe(fixture([["x".repeat(100)]]), "output-bytes")).toContain("SQL output exceeds byte limit");
      expect(await sqlProbe(fixture(), "execute")).toContain("rowsRead = 1");
    });
    it("contains transaction and cursor exceptions including unprintable errors", async () => {
      const broken = { toString() { throw Error("secondary failure"); } };
      expect(await sqlProbe({ transactionSync: () => { throw broken; } }, "execute")).toContain("SQL operation failed with an unprintable error");
      expect(await sqlProbe({ transactionSync: (action: () => unknown) => action(), sql: { exec: () => { throw Error("SQL exec rejected"); } } }, "execute")).toContain("SQL exec rejected");
      expect(await sqlProbe(fixture(), "execute")).toContain("SQLResult");
    });
    it("rejects malformed transaction results and unexpected single-result counts", async () => {
      expect(await sqlProbe({ transactionSync: () => ({ wrong: "shape" }) }, "execute")).toContain("SQLError");
      expect(await sqlProbe({ transactionSync: () => [] }, "execute")).toContain("Unexpected SQL result count");
      expect(await sqlProbe(fixture(), "execute")).toContain("SQLResult");
    });
  });
}
