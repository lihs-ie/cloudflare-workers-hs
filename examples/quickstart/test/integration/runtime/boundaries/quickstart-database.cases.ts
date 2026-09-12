import { expect, it } from "vitest";

export function registerQuickstartDatabaseCases(
  prepare: () => Promise<{ label: string; count: number }>,
) {
  it("executes the Quickstart prepared-query wrapper with bound values", async () => {
    expect(await prepare()).toEqual({ label: "prepared-value", count: 7 });
  });
}
