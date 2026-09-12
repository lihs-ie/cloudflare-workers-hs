import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import aggregation from "../../../worker/aggregation.js";
import { productionEnv, setupProduction } from "../../Support/Production/harness.js";

beforeEach(setupProduction);
afterEach(() => vi.restoreAllMocks());

async function deliver(events: unknown[]) {
  const batch = createMessageBatch("clicks", events.map((body) => ({ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body })));
  const context = createExecutionContext();
  await aggregation.queue(batch, productionEnv, context);
  return getQueueResult(batch, context);
}
async function seedURL(identifier: string) {
  await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)")
    .bind(identifier, "https://example.com/", "2020-01-01T00:00:00Z").run();
}

describe("production click aggregation", () => {
  it("deduplicates event identifiers and uses occurrence UTC day across midnight", async () => {
    const url = crypto.randomUUID();
    await seedURL(url);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const before = new Date(today.getTime() - 1000);
    const events = [
      { identifier: crypto.randomUUID(), url, occurredAt: before.toISOString() },
      { identifier: crypto.randomUUID(), url, occurredAt: today.toISOString() },
    ];
    await deliver(events);
    await deliver(events);
    const rows = await productionEnv.DB.prepare("SELECT day,count FROM daily_clicks WHERE url=? ORDER BY day").bind(url).all();
    expect(rows.results).toEqual([{ day: before.toISOString().slice(0, 10), count: 1 }, { day: today.toISOString().slice(0, 10), count: 1 }]);
  });
  it("counts a delayed click after URL deletion but excludes events older than 30 days", async () => {
    const url = crypto.randomUUID();
    await seedURL(url);
    const occurredAt = new Date(Date.now() - 60000).toISOString();
    await productionEnv.DB.prepare("UPDATE urls SET deleted_at=?,version=2 WHERE identifier=?").bind(new Date().toISOString(), url).run();
    await deliver([
      { identifier: crypto.randomUUID(), url, occurredAt },
      { identifier: crypto.randomUUID(), url, occurredAt: new Date(Date.now() - 31 * 86400000).toISOString() },
    ]);
    const row = await productionEnv.DB.prepare("SELECT SUM(count) AS total FROM daily_clicks WHERE url=?").bind(url).first();
    expect(row?.total).toBe(1);
  });
});


describe("aggregation delivery boundaries", () => {
  it("isolates malformed messages and still commits a valid neighboring event", async () => {
    const url = crypto.randomUUID();
    await seedURL(url);
    const identifier = crypto.randomUUID();
    const result = await deliver([
      { identifier: crypto.randomUUID(), url, occurredAt: "not-a-date" },
      { identifier, url, occurredAt: new Date(Date.now() - 60000).toISOString() },
    ]);
    expect(result.retryMessages).toHaveLength(1);
    expect(result.retryBatch.retry).toBe(false);
    const event = await productionEnv.DB.prepare("SELECT identifier FROM click_events WHERE identifier=?").bind(identifier).first();
    expect(event).toEqual({ identifier });
    const total = await productionEnv.DB.prepare("SELECT SUM(count) AS total FROM daily_clicks WHERE url=?").bind(url).first();
    expect(total?.total).toBe(1);
  });

  it("acknowledges an unknown URL without inventing click counts", async () => {
    const url = crypto.randomUUID();
    const identifier = crypto.randomUUID();
    const result = await deliver([{ identifier, url, occurredAt: new Date(Date.now() - 60000).toISOString() }]);
    expect(result.retryMessages).toHaveLength(0);
    expect(result.retryBatch.retry).toBe(false);
    expect(await productionEnv.DB.prepare("SELECT identifier FROM click_events WHERE identifier=?").bind(identifier).first()).toBeNull();
    expect(await productionEnv.DB.prepare("SELECT url FROM daily_clicks WHERE url=?").bind(url).first()).toBeNull();
  });
});
