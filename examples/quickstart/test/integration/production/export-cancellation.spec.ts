import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import generator from "../../../worker/export-generation.js";
import { productionEnv, setupProduction } from "../../Support/Production/harness.js";

beforeEach(async () => { await setupProduction(); });
afterEach(() => { vi.restoreAllMocks(); });

for (const chunksToRead of [0, 1, 2]) {
  it(`releases the generation lease after cancelling an upload after ${chunksToRead} chunks`, async () => {
    const identifier = crypto.randomUUID();
    const url = crypto.randomUUID();
    const key = `exports/${identifier}.csv`;
    await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)")
      .bind(url, "https://example.com/", "2024-01-01T00:00:00Z").run();
    await productionEnv.DB.batch(Array.from({ length: 125 }, (_, index) => {
      const day = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
      return productionEnv.DB.prepare("INSERT INTO daily_clicks(url,day,count) VALUES(?,?,?)").bind(url, day, 3);
    }));
    await productionEnv.DB.prepare("INSERT INTO exports(identifier,start_day,end_day,requested_by,created_at,object_key) VALUES(?,?,?,?,?,?)")
      .bind(identifier, "2024-01-01", "2024-12-31", "cancellation-test", "2024-01-01T00:00:00Z", key).run();
    // Resume a specific prior materialization. Other scenarios may have left
    // statistics in the same date range; this export owns only these 125 rows.
    await productionEnv.DB.batch([
      productionEnv.DB.prepare("INSERT INTO export_rows(export,url,day,count) SELECT ?,url,day,count FROM daily_clicks WHERE url=?")
        .bind(identifier, url),
      productionEnv.DB.prepare("UPDATE exports SET snapshot_at=?,status='generating' WHERE identifier=?")
        .bind("2024-06-01T00:00:00Z", identifier),
    ]);
    // A previous attempt already published the immutable snapshot. The current
    // attempt must abandon its producer when the conditional upload loses.
    await productionEnv.EXPORTS.put(key, "previous-complete-snapshot");
    const original = await productionEnv.EXPORTS.head(key);
    const chunks: string[] = [];
    const originalPut = productionEnv.EXPORTS.put.bind(productionEnv.EXPORTS);
    const put = vi.spyOn(productionEnv.EXPORTS, "put").mockImplementation(async (objectKey, body, options) => {
      if (!(body instanceof ReadableStream)) {
        throw new Error("Expected a streaming export upload");
      }
      const reader = body.getReader();
      try {
        for (let index = 0; index < chunksToRead; index += 1) {
          const chunk = await reader.read();
          expect(chunk.done).toBe(false);
          chunks.push(new TextDecoder().decode(chunk.value));
        }
      } finally {
        reader.releaseLock();
      }
      // This controlled consumer has already removed bytes from the fixed-length
      // stream. Do not pass that shortened stream to native R2 with its original
      // length. Obtain the real conditional failure with an independent empty
      // body; application code must cancel the original producer after null.
      return originalPut(objectKey, "", options);
    });
    const batch = createMessageBatch("exports", [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { identifier } }]);
    const context = createExecutionContext();
    await generator.queue(batch, productionEnv, context);
    const result = await getQueueResult(batch, context);
    expect(result.retryMessages).toHaveLength(0);
    expect(result.retryBatch.retry).toBe(false);
    expect(put).toHaveBeenCalledTimes(1);
    expect(chunks).toHaveLength(chunksToRead);
    const received = chunks.join("");
    if (chunksToRead > 0) {
      expect(received.startsWith("url,day,count,snapshot_at\r\n")).toBe(true);
    }
    if (chunksToRead > 1) {
      // Native FixedLengthStream may split the application's 100-row write
      // into smaller transport chunks; validate bytes, not transport framing.
      expect(received.startsWith(`url,day,count,snapshot_at\r\n"${url}","2024-01-01","3",`)).toBe(true);
    }
    expect(await productionEnv.DB.prepare("SELECT status FROM exports WHERE identifier=?").bind(identifier).first())
      .toEqual({ status: "complete" });
    expect(await (await productionEnv.EXPORTS.get(key))?.text()).toBe("previous-complete-snapshot");
    expect((await productionEnv.EXPORTS.head(key))?.etag).toBe(original?.etag);
    // Reacquiring the same lease proves the cancellation path released it.
    const coordinator = productionEnv.COORDINATOR.get(productionEnv.COORDINATOR.idFromName("csv-exports"));
    const acquired = await coordinator.fetch("https://coordinator/acquire", {
      method: "POST", body: JSON.stringify({ export: identifier }),
    });
    expect(acquired.status).toBe(200);
    const lease = await acquired.json<{ token: string }>();
    expect((await coordinator.fetch("https://coordinator/release", {
      method: "POST", body: JSON.stringify({ export: identifier, token: lease.token }),
    })).status).toBe(204);
  });
}

it("abandons an untouched export stream when immediate bindings reject the conditional upload", async () => {
  const identifier = crypto.randomUUID();
  const key = `exports/${identifier}.csv`;
  await productionEnv.DB.prepare("INSERT INTO exports(identifier,start_day,end_day,requested_by,created_at,object_key,snapshot_at,status) VALUES(?,?,?,?,?,?,?,'generating')")
    .bind(identifier, "2024-01-01", "2024-01-01", "immediate-test", "2024-01-01T00:00:00Z", key, "2024-01-01T00:00:00Z").run();
  await productionEnv.EXPORTS.put(key, "previous-snapshot");
  const paths: string[] = [];
  const stub = productionEnv.COORDINATOR.getByName("csv-exports");
  vi.spyOn(stub, "fetch").mockImplementation((input, init) => {
    const path = new URL(new Request(input, init).url).pathname;
    paths.push(path);
    return Promise.resolve(path === "/acquire"
      ? Response.json({ export: identifier, token: "immediate-token", expiresAt: Date.now() + 300000 })
      : new Response(null, { status: path === "/release" ? 204 : 200 }));
  });
  vi.spyOn(productionEnv.COORDINATOR, "getByName").mockReturnValue(stub);
  let uploads = 0;
  // The R2 contract permits null for a conditional failure. Return it without
  // reading the stream or a network round-trip, the earliest public boundary.
  const bucket = new Proxy(productionEnv.EXPORTS, {
    get(target, property) {
      if (property === "put") {
        return (_key: string, body: ReadableStream<Uint8Array>, options: R2PutOptions) => {
          expect(body).toBeInstanceOf(ReadableStream);
          expect(options.onlyIf).toBeDefined();
          uploads += 1;
          return Promise.resolve(null);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const batch = createMessageBatch("exports", [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { identifier } }]);
  const context = createExecutionContext();
  await generator.queue(batch, { ...productionEnv, EXPORTS: bucket }, context);
  expect((await getQueueResult(batch, context)).retryMessages).toHaveLength(0);
  expect(uploads).toBe(1);
  expect(paths.at(-1)).toBe("/release");
  expect(await productionEnv.DB.prepare("SELECT status FROM exports WHERE identifier=?").bind(identifier).first()).toEqual({ status: "complete" });
  expect(await (await productionEnv.EXPORTS.get(key))?.text()).toBe("previous-snapshot");
});
