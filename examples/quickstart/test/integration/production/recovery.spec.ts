import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import ingest from "../../../worker/recovery-ingest.js";
import { productionEnv, setupProduction, send } from "../../Support/Production/harness.js";

let fixture: Awaited<ReturnType<typeof setupProduction>>;
beforeEach(async () => { fixture = await setupProduction(); });
afterEach(() => vi.restoreAllMocks());

describe("production failed-event recovery", () => {
  it("persists dead letters before acknowledgement and requeues the original event", async () => {
    const url = crypto.randomUUID();
    await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)")
      .bind(url, "https://example.com/", "2020-01-01T00:00:00Z").run();
    const occurred = new Date(Date.now() - 60000);
    occurred.setUTCMilliseconds(650);
    const event = { identifier: crypto.randomUUID(), url, occurredAt: occurred.toISOString() };
    const batch = createMessageBatch("dead-letters", [{ id: "delivery-one", timestamp: new Date(), attempts: 1, body: event }]);
    const context = createExecutionContext();
    await ingest.queue(batch, productionEnv, context);
    const result = await getQueueResult(batch, context);
    expect(result.retryBatch.retry).toBe(false);
    expect(result.retryMessages).toHaveLength(0);
    const row = await productionEnv.DB.prepare("SELECT payload,status FROM failed_events WHERE identifier=?").bind(event.identifier).first();
    const persisted = JSON.parse(row?.payload as string) as typeof event;
    expect({ ...persisted, occurredAt: new Date(persisted.occurredAt).toISOString() }).toEqual(event);
    const headers = { "Cf-Access-Jwt-Assertion": await fixture.token() };
    const listing = await send("recovery", "/events", { headers });
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual(expect.arrayContaining([expect.objectContaining({ identifier: event.identifier, url })]));
    const replay = await send("recovery", `/events/${event.identifier}/replay`, { method: "POST", headers });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ identifier: event.identifier, status: "requeued" });
    const replayed = JSON.parse((await productionEnv.DB.prepare("SELECT payload FROM failed_events WHERE identifier=?").bind(event.identifier).first())?.payload as string) as typeof event;
    expect({ ...replayed, occurredAt: new Date(replayed.occurredAt).toISOString() }).toEqual(event);
    expect(replayed).toEqual(persisted);
    await productionEnv.DB.prepare("UPDATE failed_events SET expires_at='2000-01-01T00:00:00Z' WHERE identifier=?").bind(event.identifier).run();
    expect((await send("recovery", `/events/${event.identifier}/replay`, { method: "POST", headers })).status).toBe(404);
  });
});


describe("recovery ingestion boundaries", () => {
  it("persists expired dead letters and honors a nonempty listing cursor", async () => {
    const prefix = crypto.randomUUID();
    const url = crypto.randomUUID();
    await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)")
      .bind(url, "https://example.com/", "2020-01-01T00:00:00Z").run();
    const recent = { identifier: `${prefix}-a`, url, occurredAt: new Date(Date.now() - 60000).toISOString() };
    const later = { ...recent, identifier: `${prefix}-b` };
    const expired = { ...recent, identifier: `${prefix}-expired`, occurredAt: new Date(Date.now() - 31 * 86400000).toISOString() };
    const batch = createMessageBatch("dead-letters", [recent, later, expired].map((body) => ({ id: body.identifier, timestamp: new Date(), attempts: 1, body })));
    const context = createExecutionContext();
    await ingest.queue(batch, productionEnv, context);
    const result = await getQueueResult(batch, context);
    expect(result.retryMessages).toHaveLength(0);
    expect(result.retryBatch.retry).toBe(false);
    const rows = await productionEnv.DB.prepare("SELECT identifier,status FROM failed_events WHERE identifier IN (?,?,?) ORDER BY identifier")
      .bind(recent.identifier, later.identifier, expired.identifier).all();
    expect(rows.results).toEqual([
      { identifier: recent.identifier, status: "failed" },
      { identifier: later.identifier, status: "failed" },
      { identifier: expired.identifier, status: "expired" },
    ]);
    const headers = { "Cf-Access-Jwt-Assertion": await fixture.token() };
    const listing = await send("recovery", `/events?after=${encodeURIComponent(recent.identifier)}`, { headers });
    expect(listing.status).toBe(200);
    const body = await listing.json();
    expect(body).toEqual(expect.arrayContaining([expect.objectContaining({ identifier: later.identifier })]));
    expect(body).not.toEqual(expect.arrayContaining([expect.objectContaining({ identifier: recent.identifier })]));
    expect(body).not.toEqual(expect.arrayContaining([expect.objectContaining({ identifier: expired.identifier })]));
  });

  it("retries malformed dead letters without storing a fabricated event", async () => {
    const identifier = crypto.randomUUID();
    const batch = createMessageBatch("dead-letters", [{ id: identifier, timestamp: new Date(), attempts: 1, body: { identifier, url: "missing", occurredAt: "invalid-date" } }]);
    const context = createExecutionContext();
    await ingest.queue(batch, productionEnv, context);
    const result = await getQueueResult(batch, context);
    expect(result.retryMessages).toEqual([expect.objectContaining({ msgId: identifier })]);
    expect(await productionEnv.DB.prepare("SELECT identifier FROM failed_events WHERE identifier=?").bind(identifier).first()).toBeNull();
  });
});
