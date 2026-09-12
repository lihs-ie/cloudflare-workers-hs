import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import maintenance from "../../../worker/maintenance.js";
import {
  productionEnv,
  setupProduction,
} from "../../Support/Production/harness.js";

beforeEach(setupProduction);
afterEach(() => vi.restoreAllMocks());

describe("production scheduled retention", () => {
  it("deletes expired bookkeeping and CSV while retaining URL tombstones and daily totals", async () => {
    const identifier = crypto.randomUUID();
    const expiry = "2000-01-01T00:00:00Z";
    await productionEnv.DB.batch([
      productionEnv.DB.prepare(
        "INSERT INTO urls(identifier,destination,created_at,deleted_at,version) VALUES(?,?,?,?,2)",
      ).bind(identifier, "https://example.com/", expiry, expiry),
      productionEnv.DB.prepare(
        "INSERT INTO admin_idempotency(admin,key,request_json,response_status,response_body,created_at,expires_at) VALUES('admin',?,'{}',201,'{}',?,?)",
      ).bind(identifier, expiry, expiry),
      productionEnv.DB.prepare(
        "INSERT INTO click_events(identifier,url,occurred_at,expires_at) VALUES(?,?,?,?)",
      ).bind(identifier, identifier, expiry, expiry),
      productionEnv.DB.prepare(
        "INSERT INTO failed_events(identifier,url,occurred_at,payload,expires_at) VALUES(?,?,?,'{}',?)",
      ).bind(identifier, identifier, expiry, expiry),
      productionEnv.DB.prepare(
        "INSERT INTO exports(identifier,start_day,end_day,status,requested_by,created_at,expires_at,object_key) VALUES(?,'2000-01-01','2000-01-01','complete','admin',?,?,?)",
      ).bind(identifier, expiry, expiry, `exports/${identifier}.csv`),
    ]);
    await productionEnv.EXPORTS.put(`exports/${identifier}.csv`, "expired CSV");
    const context = createExecutionContext();
    await maintenance.scheduled(
      createScheduledController(),
      productionEnv,
      context,
    );
    await waitOnExecutionContext(context);
    for (const table of [
      "admin_idempotency",
      "click_events",
      "failed_events",
      "exports",
    ]) {
      expect(
        (
          await productionEnv.DB.prepare(
            `SELECT COUNT(*) AS total FROM ${table}`,
          ).first()
        )?.total,
        table,
      ).toBe(0);
    }
    expect(
      await productionEnv.EXPORTS.head(`exports/${identifier}.csv`),
    ).toBeNull();
    expect(
      (
        await productionEnv.DB.prepare(
          "SELECT deleted_at FROM urls WHERE identifier=?",
        )
          .bind(identifier)
          .first()
      )?.deleted_at,
    ).toBe(expiry);
    expect(
      (
        await productionEnv.DB.prepare(
          "SELECT count FROM daily_clicks WHERE url=?",
        )
          .bind(identifier)
          .first()
      )?.count,
    ).toBe(1);
  });
});

async function schedule(overrides: Record<string, unknown> = {}) {
  const context = createExecutionContext();
  await maintenance.scheduled(
    createScheduledController(),
    { ...productionEnv, ...overrides },
    context,
  );
  await waitOnExecutionContext(context);
}
async function seedExports(
  count: number,
  status: string,
  expiresAt: string | null,
) {
  const identifiers = Array.from(
    { length: count },
    (_, index) => `batch-${String(index).padStart(3, "0")}`,
  );
  await productionEnv.DB.batch(
    identifiers.map((identifier) =>
      productionEnv.DB.prepare(
        "INSERT INTO exports(identifier,start_day,end_day,status,requested_by,created_at,expires_at,object_key) VALUES(?,'2000-01-01','2000-01-01',?,'admin','2000-01-01T00:00:00Z',?,?)",
      ).bind(identifier, status, expiresAt, `exports/${identifier}.csv`),
    ),
  );
  return identifiers;
}

describe("production maintenance recovery and bounded work", () => {
  it("cleans more than 100 expired exports over successive invocations", async () => {
    await seedExports(125, "complete", "2000-01-01T00:00:00Z");
    await schedule();
    expect(
      (
        await productionEnv.DB.prepare(
          "SELECT COUNT(*) AS total FROM exports",
        ).first()
      )?.total,
    ).toBe(25);
    await schedule();
    expect(
      (
        await productionEnv.DB.prepare(
          "SELECT COUNT(*) AS total FROM exports",
        ).first()
      )?.total,
    ).toBe(0);
  });
  it("retains the database record when R2 deletion fails and resumes on the next invocation", async () => {
    const identifiers = await seedExports(
      3,
      "complete",
      "2000-01-01T00:00:00Z",
    );
    for (const identifier of identifiers)
      await productionEnv.EXPORTS.put(`exports/${identifier}.csv`, "CSV");
    let attempts = 0;
    const bucket = new Proxy(productionEnv.EXPORTS, {
      get(target, key) {
        if (key === "delete") {
          return async (object: string) => {
            if (++attempts === 2) {
              throw new Error("Injected R2 deletion outage");
            }
            return target.delete(object);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(schedule({ EXPORTS: bucket })).rejects.toThrow();
    expect(
      (
        await productionEnv.DB.prepare(
          "SELECT COUNT(*) AS total FROM exports",
        ).first()
      )?.total,
    ).toBe(2);
    await schedule();
    expect(
      (
        await productionEnv.DB.prepare(
          "SELECT COUNT(*) AS total FROM exports",
        ).first()
      )?.total,
    ).toBe(0);
    for (const identifier of identifiers)
      expect(
        await productionEnv.EXPORTS.head(`exports/${identifier}.csv`),
      ).toBeNull();
  });
  it("rotates a backlog larger than 100 and re-enqueues requests after a send failure", async () => {
    const identifiers = await seedExports(125, "pending", null);
    const delivered: string[] = [];
    let failNext = true;
    const queue = {
      send: async (body: { identifier: string }) => {
        if (failNext) {
          failNext = false;
          throw new Error("Injected Queue send outage");
        }
        delivered.push(body.identifier);
        return productionEnv.EXPORT_QUEUE.send(body);
      },
    };
    await expect(schedule({ EXPORT_QUEUE: queue })).rejects.toThrow();
    await schedule({ EXPORT_QUEUE: queue });
    await schedule({ EXPORT_QUEUE: queue });
    expect(new Set(delivered)).toEqual(new Set(identifiers));
    expect(
      (
        await productionEnv.DB.prepare(
          "SELECT COUNT(*) AS total FROM exports WHERE status='pending'",
        ).first()
      )?.total,
    ).toBe(125);
  });
});
