import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import generator from "../../../worker/export-generation.js";
import { productionEnv, setupProduction } from "../../Support/Production/harness.js";

beforeEach(async () => {
  await setupProduction();
});
afterEach(() => vi.restoreAllMocks());

async function seedExport() {
  const identifier = crypto.randomUUID();
  const key = `exports/${identifier}.csv`;
  await productionEnv.DB.prepare(
    "INSERT INTO exports(identifier,start_day,end_day,requested_by,created_at,object_key) VALUES(?,?,?,?,?,?)",
  )
    .bind(identifier, "2024-01-01", "2024-01-01", "lease-test", "2024-01-01T00:00:00Z", key)
    .run();
  return { identifier, key };
}

async function deliver(identifier: string) {
  const batch = createMessageBatch("exports", [
    { id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: { identifier } },
  ]);
  const context = createExecutionContext();
  await generator.queue(batch, productionEnv, context);
  return getQueueResult(batch, context);
}

function interceptLease(respond: (pathname: string) => Promise<Response>) {
  const stub = productionEnv.COORDINATOR.get(
    productionEnv.COORDINATOR.idFromName("csv-exports"),
  );
  const fetch = vi.spyOn(stub, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    return respond(new URL(request.url).pathname);
  });
  vi.spyOn(productionEnv.COORDINATOR, "getByName").mockReturnValue(stub);
  return fetch;
}

async function status(identifier: string) {
  return productionEnv.DB.prepare("SELECT status,last_error FROM exports WHERE identifier=?")
    .bind(identifier)
    .first();
}

function lease(identifier: string) {
  return Response.json({ export: identifier, token: "test-fence", expiresAt: Date.now() + 300000 });
}

describe("production outgoing coordinator failures", () => {
  it.each([
    ["malformed JSON", () => new Response("not-json")],
    ["missing lease token", () => Response.json({ export: "missing-token", expiresAt: 1 })],
    ["oversized response", () => new Response(" ".repeat(4097))],
    ["response read rejection", () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private-read-failure"));
      },
    }))],
    ["rejected status", () => new Response("unavailable", { status: 503 })],
  ])("retries %s before materializing or uploading", async (_label, response) => {
    const { identifier, key } = await seedExport();
    const paths: string[] = [];
    interceptLease(async (path) => {
      paths.push(path);
      return response();
    });
    const result = await deliver(identifier);
    expect(result.retryMessages).toHaveLength(1);
    expect(paths).toEqual(["/acquire"]);
    expect(await status(identifier)).toEqual({ status: "pending", last_error: null });
    expect(await productionEnv.EXPORTS.head(key)).toBeNull();
  });

  it.each(["/acquire", "/renew"])("retries transport failure at %s without publishing", async (failurePath) => {
    const { identifier, key } = await seedExport();
    const paths: string[] = [];
    interceptLease(async (path) => {
      paths.push(path);
      if (path === failurePath) {
        throw new Error("private-transport-failure");
      }
      if (path === "/acquire") {
        return lease(identifier);
      }
      return new Response(null, { status: 204 });
    });
    expect((await deliver(identifier)).retryMessages).toHaveLength(1);
    expect(paths).toEqual(failurePath === "/acquire" ? ["/acquire"] : ["/acquire", "/renew", "/release"]);
    expect(await status(identifier)).toEqual({
      status: failurePath === "/acquire" ? "pending" : "generating",
      last_error: null,
    });
    expect(await productionEnv.EXPORTS.head(key)).toBeNull();
  });

  it.each([409, 503])("handles release status %s after successful publication", async (releaseStatus) => {
    const { identifier, key } = await seedExport();
    const paths: string[] = [];
    interceptLease(async (path) => {
      paths.push(path);
      if (path === "/acquire") {
        return lease(identifier);
      }
      return new Response(null, { status: path === "/release" ? releaseStatus : 200 });
    });
    const result = await deliver(identifier);
    expect(result.retryMessages).toHaveLength(releaseStatus === 409 ? 0 : 1);
    expect(paths.at(-1)).toBe("/release");
    expect(await status(identifier)).toEqual({ status: "complete", last_error: null });
    const object = await productionEnv.EXPORTS.get(key);
    expect(await object?.text()).toBe("url,day,count,snapshot_at\r\n");
    const before = await productionEnv.EXPORTS.head(key);
    // A retried delivery must keep the successful publication immutable even
    // though bracket cleanup failed on the first delivery.
    await deliver(identifier);
    expect(await productionEnv.EXPORTS.head(key)).toEqual(before);
  });

  it("still releases after upload failure and retries when release also fails", async () => {
    const { identifier, key } = await seedExport();
    const paths: string[] = [];
    interceptLease(async (path) => {
      paths.push(path);
      if (path === "/release") {
        throw new Error("private-release-failure");
      }
      return path === "/acquire" ? lease(identifier) : new Response(null, { status: 200 });
    });
    vi.spyOn(productionEnv.EXPORTS, "put").mockRejectedValue(new Error("private-upload-failure"));
    expect((await deliver(identifier)).retryMessages).toHaveLength(1);
    expect(paths.at(-1)).toBe("/release");
    expect(await status(identifier)).toEqual({ status: "generating", last_error: null });
    expect(await productionEnv.EXPORTS.head(key)).toBeNull();
  });
});

it.each([4096, 4097])("enforces the lease response byte limit for valid JSON at %s bytes", async (byteLength) => {
  const { identifier, key } = await seedExport();
  await productionEnv.DB.prepare("UPDATE exports SET snapshot_at=? WHERE identifier=?")
    .bind("2024-01-01T00:00:00Z", identifier).run();
  const payload = JSON.stringify({ export: identifier, token: "bounded-token", expiresAt: Date.now() + 300000 });
  const padded = payload + " ".repeat(byteLength - new TextEncoder().encode(payload).byteLength);
  expect(new TextEncoder().encode(padded)).toHaveLength(byteLength);
  let usePadded = true;
  interceptLease(async (path) => {
    if (path === "/acquire") {
      return new Response(usePadded ? padded : payload, { headers: { "Content-Type": "application/json" } });
    }
    return new Response(null, { status: path === "/release" ? 204 : 200 });
  });
  const result = await deliver(identifier);
  expect(result.retryMessages).toHaveLength(byteLength > 4096 ? 1 : 0);
  expect(await status(identifier)).toEqual({ status: byteLength > 4096 ? "pending" : "complete", last_error: null });
  if (byteLength > 4096) {
    expect(await productionEnv.EXPORTS.head(key)).toBeNull();
    usePadded = false;
    expect((await deliver(identifier)).retryMessages).toHaveLength(0);
    expect(await status(identifier)).toEqual({ status: "complete", last_error: null });
  }
  expect(await (await productionEnv.EXPORTS.get(key))?.text()).toBe("url,day,count,snapshot_at\r\n");
});
