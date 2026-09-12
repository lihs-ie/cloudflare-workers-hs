import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import generator from "../../../worker/export-generation.js";
import { productionEnv, setupProduction, send } from "../../Support/Production/harness.js";

let fixture: Awaited<ReturnType<typeof setupProduction>>;
beforeEach(async () => { fixture = await setupProduction(); });
afterEach(() => vi.restoreAllMocks());
async function generate(identifier: string) {
  const batch = createMessageBatch("exports", [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { identifier } }]);
  const context = createExecutionContext();
  await generator.queue(batch, productionEnv, context);
  await getQueueResult(batch, context);
}

describe("production asynchronous CSV exports", () => {
  it("materializes a snapshot once, streams CSV, shares access and expires downloads", async () => {
    const url = crypto.randomUUID();
    await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,deleted_at,version) VALUES(?,?,?,?,2)")
      .bind(url, "https://example.com/", "2024-01-01T00:00:00Z", "2024-01-02T00:00:00Z").run();
    await productionEnv.DB.batch(Array.from({ length: 125 }, (_, index) => {
      const day = new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10);
      return productionEnv.DB.prepare("INSERT INTO daily_clicks(url,day,count) VALUES(?,?,?)").bind(url, day, 3);
    }));
    const headers = { "Cf-Access-Jwt-Assertion": await fixture.token(), "Content-Type": "application/json" };
    const response = await send("export", "/exports", { method: "POST", headers, body: JSON.stringify({ startDay: "2024-01-01", endDay: "2024-12-31" }) });
    expect(response.status).toBe(202);
    const { identifier } = await response.json() as { identifier: string };
    expect((await send("export", `/exports/${identifier}/download`, { headers })).status).toBe(409);
    await generate(identifier);
    const status = await send("export", `/exports/${identifier}`, { headers });
    expect(await status.json()).toMatchObject({ identifier, status: "complete" });
    const otherAdmin = { "Cf-Access-Jwt-Assertion": await fixture.token({ sub: "admin-two", email: "admin-two@example.test" }) };
    const download = await send("export", `/exports/${identifier}/download`, { headers: otherAdmin });
    expect(download.status).toBe(200);
    const csv = await download.text();
    const head = await send("export", `/exports/${identifier}/download`, { method: "HEAD", headers: otherAdmin });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(csv).toContain("url,day,count,snapshot_at");
    expect(csv).toContain(`"${url}","2024-01-01","3",`);
    expect(csv.trim().split(/\r?\n/)).toHaveLength(126);
    const before = await productionEnv.DB.prepare("SELECT expires_at,object_key FROM exports WHERE identifier=?").bind(identifier).first();
    const objectBefore = await productionEnv.EXPORTS.head(before!.object_key as string);
    await productionEnv.DB.prepare("UPDATE daily_clicks SET count=99 WHERE url=?").bind(url).run();
    await generate(identifier);
    expect(await (await send("export", `/exports/${identifier}/download`, { headers })).text()).toBe(csv);
    const after = await productionEnv.DB.prepare("SELECT expires_at,object_key FROM exports WHERE identifier=?").bind(identifier).first();
    expect(after).toEqual(before);
    const objectAfter = await productionEnv.EXPORTS.head(after!.object_key as string);
    expect(objectAfter?.etag).toBe(objectBefore?.etag);
    expect(objectAfter?.uploaded).toEqual(objectBefore?.uploaded);
    await productionEnv.DB.prepare("UPDATE exports SET expires_at=? WHERE identifier=?").bind("2000-01-01T00:00:00Z", identifier).run();
    expect((await send("export", `/exports/${identifier}/download`, { headers })).status).toBe(404);
  });
});

async function deliverGeneration(body: unknown, attempts: number) {
  const batch = createMessageBatch("exports", [{ id: crypto.randomUUID(), timestamp: new Date(), attempts, body }]);
  const context = createExecutionContext();
  await generator.queue(batch, productionEnv, context);
  return getQueueResult(batch, context);
}

async function seedExport() {
  const identifier = crypto.randomUUID();
  const key = `exports/${identifier}.csv`;
  await productionEnv.DB.prepare("INSERT INTO exports(identifier,start_day,end_day,requested_by,created_at,object_key) VALUES(?,?,?,?,?,?)")
    .bind(identifier, "2024-01-01", "2024-01-01", "test-administrator", "2024-01-01T00:00:00Z", key).run();
  return { identifier, key };
}

it("retries attempt three and durably fails attempt four after R2 failure", async () => {
  const logs = vi.spyOn(console, "log");
  const { identifier } = await seedExport();
  const put = vi.spyOn(productionEnv.EXPORTS, "put").mockRejectedValue(new Error("private-storage-payload"));
  const retry = await deliverGeneration({ identifier }, 3);
  expect(retry.retryMessages).toHaveLength(1);
  expect(await productionEnv.DB.prepare("SELECT status,last_error FROM exports WHERE identifier=?").bind(identifier).first())
    .toEqual({ status: "generating", last_error: null });
  const exhausted = await deliverGeneration({ identifier }, 4);
  expect(exhausted.retryMessages).toHaveLength(0);
  expect(exhausted.retryBatch.retry).toBe(false);
  expect(await productionEnv.DB.prepare("SELECT status,last_error FROM exports WHERE identifier=?").bind(identifier).first())
    .toEqual({ status: "failed", last_error: "Generation retries exhausted" });
  expect(put).toHaveBeenCalledTimes(2);
  expect(logs.mock.calls.flat()).toContain("queue_message_failed");
  expect(JSON.stringify(logs.mock.calls)).not.toContain("private-storage-payload");
});

it("retries malformed generation messages without touching storage", async () => {
  const put = vi.spyOn(productionEnv.EXPORTS, "put");
  for (const body of [null, {}, { identifier: 42 }, "invalid"]) {
    const result = await deliverGeneration(body, 4);
    expect(result.retryMessages).toHaveLength(1);
  }
  expect(put).not.toHaveBeenCalled();
});

it("acknowledges a vanished export without creating an R2 object", async () => {
  const put = vi.spyOn(productionEnv.EXPORTS, "put");
  const result = await deliverGeneration({ identifier: crypto.randomUUID() }, 1);
  expect(result.retryMessages).toHaveLength(0);
  expect(result.retryBatch.retry).toBe(false);
  expect(put).not.toHaveBeenCalled();
});

it("completes an interrupted upload from immutable existing object metadata", async () => {
  const { identifier, key } = await seedExport();
  await productionEnv.DB.prepare("UPDATE exports SET snapshot_at=?,status='generating' WHERE identifier=?")
    .bind("2024-01-01T00:00:00Z", identifier).run();
  const bytes = "url,day,count,snapshot_at\r\n";
  await productionEnv.EXPORTS.put(key, bytes);
  const before = await productionEnv.EXPORTS.head(key);
  const result = await deliverGeneration({ identifier }, 1);
  expect(result.retryMessages).toHaveLength(0);
  expect(await productionEnv.DB.prepare("SELECT status FROM exports WHERE identifier=?").bind(identifier).first())
    .toEqual({ status: "complete" });
  expect(await (await productionEnv.EXPORTS.get(key))?.text()).toBe(bytes);
  const after = await productionEnv.EXPORTS.head(key);
  expect(after?.etag).toBe(before?.etag);
  expect(after?.uploaded).toEqual(before?.uploaded);
});

it("retries a conditional put failure when the purported existing object is absent", async () => {
  const { identifier, key } = await seedExport();
  await productionEnv.EXPORTS.put(key, "existing-object");
  vi.spyOn(productionEnv.EXPORTS, "head").mockResolvedValue(null);
  const result = await deliverGeneration({ identifier }, 3);
  expect(result.retryMessages).toHaveLength(1);
  expect(await productionEnv.DB.prepare("SELECT status FROM exports WHERE identifier=?").bind(identifier).first())
    .toEqual({ status: "generating" });
});

it("keeps completed output immutable when a stale fourth attempt cannot acquire a lease", async () => {
  const { identifier, key } = await seedExport();
  await productionEnv.EXPORTS.put(key, "completed-snapshot");
  await productionEnv.DB.prepare("UPDATE exports SET status='complete',snapshot_at=?,completed_at=?,expires_at=? WHERE identifier=?")
    .bind("2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", "2099-01-01T00:00:00Z", identifier).run();
  const before = await productionEnv.DB.prepare("SELECT * FROM exports WHERE identifier=?").bind(identifier).first();
  const coordinator = productionEnv.COORDINATOR.getByName("csv-exports");
  vi.spyOn(coordinator, "fetch").mockRejectedValue(new Error("private-coordinator-payload"));
  vi.spyOn(productionEnv.COORDINATOR, "getByName").mockReturnValue(coordinator);
  const result = await deliverGeneration({ identifier }, 4);
  expect(result.retryMessages).toHaveLength(0);
  expect(result.retryBatch.retry).toBe(false);
  expect(await productionEnv.DB.prepare("SELECT * FROM exports WHERE identifier=?").bind(identifier).first()).toEqual(before);
  expect(await (await productionEnv.EXPORTS.get(key))?.text()).toBe("completed-snapshot");
});

it("returns 404 for a completed export whose object has disappeared", async () => {
  const { identifier } = await seedExport();
  await productionEnv.DB.prepare("UPDATE exports SET status='complete',expires_at=? WHERE identifier=?")
    .bind("2099-01-01T00:00:00Z", identifier).run();
  const headers = { "Cf-Access-Jwt-Assertion": await fixture.token() };
  expect((await send("export", `/exports/${identifier}/download`, { headers })).status).toBe(404);
  expect((await send("export", `/exports/${identifier}`, { headers })).status).toBe(200);
});

it("validates inclusive UTC range boundaries before persisting export requests", async () => {
  const headers = { "Cf-Access-Jwt-Assertion": await fixture.token(), "Content-Type": "application/json" };
  const count = async () => productionEnv.DB.prepare("SELECT COUNT(*) AS n FROM exports").first<number>("n");
  const before = await count();
  for (const [startDay, endDay] of [["2024-02-01", "2024-01-31"], ["2024-01-01", "2025-01-01"]]) {
    const response = await send("export", "/exports", { method: "POST", headers, body: JSON.stringify({ startDay, endDay }) });
    expect(response.status).toBe(400);
    await response.body?.cancel();
  }
  expect(await count()).toBe(before);
  for (const [startDay, endDay] of [["2024-01-01", "2024-01-01"], ["2024-01-01", "2024-12-31"]]) {
    const response = await send("export", "/exports", { method: "POST", headers, body: JSON.stringify({ startDay, endDay }) });
    expect(response.status).toBe(202);
    await response.body?.cancel();
  }
  expect(await count()).toBe((before ?? 0) + 2);
});

it("retains a pending outbox entry when initial export queue delivery fails", async () => {
  vi.spyOn(productionEnv.EXPORT_QUEUE, "send").mockRejectedValue(new Error("private-queue-payload"));
  const headers = { "Cf-Access-Jwt-Assertion": await fixture.token(), "Content-Type": "application/json" };
  const response = await send("export", "/exports", { method: "POST", headers, body: JSON.stringify({ startDay: "2024-01-01", endDay: "2024-01-01" }) });
  expect(response.status).toBe(202);
  const { identifier } = await response.json() as { identifier: string };
  expect(await productionEnv.DB.prepare("SELECT status,last_error FROM exports WHERE identifier=?").bind(identifier).first())
    .toEqual({ status: "pending", last_error: "Initial queue delivery failed; pending retry" });
});
