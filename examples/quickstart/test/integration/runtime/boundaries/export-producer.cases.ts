import { expect, it } from "vitest";

export function registerExportProducerCases(probe: (mode: string) => Promise<string>): void {
  it("stops before reading snapshot pages when the header emitter is cancelled", async () => {
    expect(JSON.parse(await probe("header-cancel"))).toEqual({
      completed: true, error: "", writes: ["url,day,count,snapshot_at\r\n"],
      reads: [], events: ["emit"],
    });
  });
  it("does not advance the snapshot cursor after a cancelled data page", async () => {
    expect(JSON.parse(await probe("page-cancel"))).toEqual({
      completed: true, error: "",
      writes: ["url,day,count,snapshot_at\r\n", "row-a\r\nrow-b\r\n"],
      reads: [["", ""]], events: ["emit", "read", "emit"],
    });
  });
  it("advances using the final accepted row and completes after an empty page", async () => {
    expect(JSON.parse(await probe("complete"))).toEqual({
      completed: true, error: "",
      writes: ["url,day,count,snapshot_at\r\n", "row-a\r\nrow-b\r\n"],
      reads: [["", ""], ["b", "2026-09-02"]],
      events: ["emit", "read", "emit", "read"],
    });
  });
  it("propagates snapshot read failure without emitting data or reading another page", async () => {
    expect(JSON.parse(await probe("reader-failure"))).toEqual({
      completed: false, error: "user error (snapshot read failed)",
      writes: ["url,day,count,snapshot_at\r\n"], reads: [["", ""]],
      events: ["emit", "read"],
    });
  });
}
