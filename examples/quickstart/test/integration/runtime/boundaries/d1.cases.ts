import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { lookupD1 } from "../../../Support/Runtime/harness.js";

export function registerD1Cases(): void {
  describe("real WASM D1 first", () => {
    it("returns the selected row and Nothing for an absent row", async () => {
      const database = env.RUNTIME_DB;
      await database.exec(
        "CREATE TABLE IF NOT EXISTS runtime_d1_lookup (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      await database
        .prepare("INSERT OR REPLACE INTO runtime_d1_lookup VALUES (?, ?)")
        .bind("present", "selected-value")
        .run();
      expect(await lookupD1(database, "present")).toBe("selected-value");
      expect(await lookupD1(database, "missing")).toBe("absent");
    });
  });
}
