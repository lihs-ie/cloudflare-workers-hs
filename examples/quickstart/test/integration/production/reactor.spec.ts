import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupProduction,
  send,
  productionEnv,
} from "../../Support/Production/harness.js";
import { exerciseManagement } from "../../Support/Production/http-contract.js";

let fixture: Awaited<ReturnType<typeof setupProduction>>;
beforeEach(async () => {
  fixture = await setupProduction();
  await productionEnv.DB.batch(
    [
      "export_rows",
      "exports",
      "failed_events",
      "daily_clicks",
      "click_events",
      "admin_idempotency",
      "urls",
    ].map((table) => productionEnv.DB.prepare(`DELETE FROM ${table}`)),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("production WASM application boundaries", () => {
  it("serves an unknown public route as 404", async () => {
    expect((await send("redirect", "/missing")).status).toBe(404);
  });
  it("verifies Access JWT and preserves CRUD, idempotency and optimistic concurrency contracts", async () => {
    await exerciseManagement(
      send,
      await fixture.token(),
      (condition, description) => expect(condition, description).toBe(true),
    );
  });
  it.each([
    { exp: 1 },
    { aud: ["wrong-audience"] },
    { iss: "https://wrong.cloudflareaccess.com" },
    { nbf: 4102444800 },
  ])("rejects signed but invalid claims: %j", async (claims) => {
    const response = await send("management", "/urls", {
      headers: { "Cf-Access-Jwt-Assertion": await fixture.token(claims) },
    });
    expect(response.status).toBe(401);
  });
  it("rejects unsigned destination schemes, credentials and local hosts", async () => {
    const token = await fixture.token();
    for (const destination of [
      "javascript:alert(1)",
      "https://user:password@example.com/",
      "http://localhost/",
      "http://127.0.0.1/",
    ]) {
      const response = await send("management", "/urls", {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": token,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ destination, expiresAt: null }),
      });
      expect(response.status, destination).toBe(400);
    }
  });
  it("requires an idempotency key and a bounded UTC statistics range", async () => {
    const headers = {
      "Cf-Access-Jwt-Assertion": await fixture.token(),
      "Content-Type": "application/json",
    };
    expect(
      (
        await send("management", "/urls", {
          method: "POST",
          headers,
          body: JSON.stringify({
            destination: "https://example.com/",
            expiresAt: null,
          }),
        })
      ).status,
    ).toBe(400);
    for (const query of [
      "",
      "?start=2024-01-01",
      "?start=2024-01-01&end=2025-01-01",
      "?start=2024-02-01&end=2024-01-01",
    ]) {
      expect(
        (await send("management", `/stats${query}`, { headers })).status,
        query,
      ).toBe(400);
    }
    expect(
      (
        await send("management", "/stats?start=2024-01-01&end=2024-12-31", {
          headers,
        })
      ).status,
    ).toBe(200);
  });
  it("scopes idempotency per administrator and replaces expired keys without reusing URL codes", async () => {
    const key = crypto.randomUUID();
    const payload = JSON.stringify({
      destination: "https://example.com/",
      expiresAt: null,
    });
    const create = async (token: string) => {
      const response = await send("management", "/urls", {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": token,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: payload,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { identifier: string };
    };
    const one = await fixture.token();
    const two = await fixture.token({
      sub: "admin-two",
      email: "admin-two@example.test",
    });
    const first = await create(one);
    expect((await create(two)).identifier).not.toBe(first.identifier);
    await productionEnv.DB.prepare(
      "UPDATE admin_idempotency SET expires_at='2000-01-01T00:00:00Z' WHERE key=?",
    )
      .bind(key)
      .run();
    expect((await create(one)).identifier).not.toBe(first.identifier);
    await productionEnv.DB.prepare(
      "UPDATE urls SET expires_at='2000-01-01T00:00:00Z' WHERE identifier=?",
    )
      .bind(first.identifier)
      .run();
    expect((await send("redirect", `/r/${first.identifier}`)).status).toBe(404);
  });

  it("paginates URL and statistics lists without repeating cursors", async () => {
    const headers = { "Cf-Access-Jwt-Assertion": await fixture.token() };
    for (const identifier of ["page-a", "page-b", "page-c"]) {
      await productionEnv.DB.prepare(
        "INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)",
      )
        .bind(identifier, "https://example.com/", "2026-01-01T00:00:00Z")
        .run();
      await productionEnv.DB.prepare(
        "INSERT INTO daily_clicks(url,day,count) VALUES(?,?,?)",
      )
        .bind(identifier, "2026-01-01", 2)
        .run();
    }
    const first = (await (
      await send("management", "/urls?limit=2", { headers })
    ).json()) as { items: { identifier: string }[]; next: string };
    expect(first.items.map((item) => item.identifier)).toEqual([
      "page-a",
      "page-b",
    ]);
    expect(first.next).toBe("page-b");
    const last = (await (
      await send("management", `/urls?limit=2&after=${first.next}`, { headers })
    ).json()) as { items: { identifier: string }[]; next: null };
    expect(last.items.map((item) => item.identifier)).toEqual(["page-c"]);
    expect(last.next).toBeNull();
    expect(
      await (await send("management", "/urls?after=zzzz", { headers })).json(),
    ).toEqual({ items: [], next: null });
    const all = (await (
      await send("management", "/urls", { headers })
    ).json()) as { items: unknown[] };
    expect(all.items).toHaveLength(3);
    const stats = (await (
      await send(
        "management",
        "/stats?start=2026-01-01&end=2026-01-01&limit=2",
        { headers },
      )
    ).json()) as { items: unknown[]; next: string };
    expect(stats.items).toHaveLength(2);
    expect(stats.next).toBe("page-b/2026-01-01");
    const tail = (await (
      await send(
        "management",
        `/stats?start=2026-01-01&end=2026-01-01&after=${encodeURIComponent(stats.next)}&limit=2`,
        { headers },
      )
    ).json()) as { items: unknown[]; next: null };
    expect(tail.items).toHaveLength(1);
    expect(tail.next).toBeNull();
    for (const limit of [0, -1, 101])
      for (const base of [
        "/urls?",
        "/stats?start=2026-01-01&end=2026-01-01&",
      ]) {
        expect(
          (await send("management", `${base}limit=${limit}`, { headers }))
            .status,
        ).toBe(400);
      }
  });
  it("rejects empty and oversized idempotency keys before inserting data", async () => {
    for (const key of ["", "x".repeat(257)]) {
      const response = await send("management", "/urls", {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await fixture.token(),
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({
          destination: "https://example.com/",
          expiresAt: null,
        }),
      });
      expect(response.status).toBe(400);
    }
    expect(
      (await productionEnv.DB.prepare("SELECT COUNT(*) AS n FROM urls").first())
        ?.n,
    ).toBe(0);
  });

  it("validates management mutation versions and distinguishes missing resources", async () => {
    const headers = {
      "Cf-Access-Jwt-Assertion": await fixture.token(),
      "Content-Type": "application/json",
    };
    for (const suffix of ["", "?version=0", "?version=-1"]) {
      expect(
        (
          await send("management", `/urls/missing${suffix}`, {
            method: "DELETE",
            headers,
          })
        ).status,
      ).toBe(400);
    }
    expect(
      (
        await send("management", "/urls/missing?version=1", {
          method: "DELETE",
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send("management", "/urls/missing", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            destination: "https://example.com/",
            expiresAt: null,
            version: 1,
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await send("management", "/urls/missing", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            destination: "javascript:bad",
            expiresAt: null,
            version: 1,
          }),
        })
      ).status,
    ).toBe(400);
  });
  it("preserves optional timestamps in management views after deletion", async () => {
    const headers = {"Cf-Access-Jwt-Assertion":await fixture.token(),"Content-Type":"application/json","Idempotency-Key":"k".repeat(256)};
    const created=await send("management","/urls",{method:"POST",headers,body:JSON.stringify({destination:"https://example.com/",expiresAt:"2099-01-01T00:00:00Z"})});
    expect(created.status).toBe(201);
    const value=await created.json() as {identifier:string};
    expect((await send("management",`/urls/${value.identifier}?version=1`,{method:"DELETE",headers})).status).toBe(204);
    const fetched=await (await send("management",`/urls/${value.identifier}`,{headers})).json() as {expiresAt:string;deletedAt:string;version:number};
    expect(fetched.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(typeof fetched.deletedAt).toBe("string");
    expect(Number.isFinite(Date.parse(fetched.deletedAt))).toBe(true);
    expect(fetched.version).toBe(2);
  });

});

it("routes authenticated unknown paths and methods only after Access verification", async () => {
  const headers = { "Cf-Access-Jwt-Assertion": await fixture.token() };
  for (const application of ["management", "export", "recovery"] as const) {
    const path = application === "management" ? "/urls" : application === "export" ? "/exports/missing" : "/events";
    const unknown = await send(application, "/unknown-route", { headers });
    expect(unknown.status, application).toBe(404);
    await unknown.body?.cancel();
    const method = await send(application, path, { method: "OPTIONS", headers });
    expect(method.status, application).toBe(405);
    await method.body?.cancel();
  }
});

it("preserves redirects when deferred click publication fails", async () => {
  const logs = vi.spyOn(console, "log");
  const identifier = crypto.randomUUID();
  await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)")
    .bind(identifier, "https://example.com/destination", "2024-01-01T00:00:00Z").run();
  const publish = vi.spyOn(productionEnv.CLICKS, "send").mockRejectedValue(new Error("private-click-queue-payload"));
  const response = await send("redirect", `/r/${identifier}`);
  expect(response.status).toBe(302);
  expect(response.headers.get("Location")).toBe("https://example.com/destination");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(publish).toHaveBeenCalledOnce();
  expect(logs.mock.calls.flat()).toContain("click_event_send_failed");
  expect(JSON.stringify(logs.mock.calls)).not.toContain("private-click-queue-payload");
});

it("sanitizes production database errors and accepts the next healthy request", async () => {
  const logs = vi.spyOn(console, "log");
  const headers = { "Cf-Access-Jwt-Assertion": await fixture.token() };
  const prepare = vi.spyOn(productionEnv.DB, "prepare").mockImplementation(() => {
    throw new Error("private-database-payload");
  });
  const response = await send("management", "/urls", { headers });
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private-database-payload");
  expect(logs.mock.calls.flat()).toContain("application_request_failed");
  expect(JSON.stringify(logs.mock.calls)).not.toContain("private-database-payload");
  prepare.mockRestore();
  expect((await send("management", "/urls", { headers })).status).toBe(200);
});

it("validates update expiration against the application clock before changing the URL", async () => {
  const identifier = crypto.randomUUID();
  await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)")
    .bind(identifier, "https://example.com/original", "2024-01-01T00:00:00Z").run();
  const headers = { "Cf-Access-Jwt-Assertion": await fixture.token(), "Content-Type": "application/json" };
  const update = (expiresAt: string) => send("management", `/urls/${identifier}`, {
    method: "PUT", headers,
    body: JSON.stringify({ destination: "https://example.com/updated", expiresAt, version: 1 }),
  });
  const rejected = await update("2000-01-01T00:00:00Z");
  expect(rejected.status).toBe(400);
  await rejected.body?.cancel();
  expect(await productionEnv.DB.prepare("SELECT destination,expires_at,version FROM urls WHERE identifier=?").bind(identifier).first())
    .toEqual({ destination: "https://example.com/original", expires_at: null, version: 1 });
  const accepted = await update("2099-01-01T00:00:00Z");
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ identifier, destination: "https://example.com/updated", expiresAt: "2099-01-01T00:00:00Z", version: 2 });
});

it("rejects a malformed D1 update result containing multiple rows", async () => {
  const identifier = crypto.randomUUID();
  await productionEnv.DB.prepare("INSERT INTO urls(identifier,destination,created_at,version) VALUES(?,?,?,1)")
    .bind(identifier, "https://example.com/original", "2024-01-01T00:00:00Z").run();
  const stored = await productionEnv.DB.prepare("SELECT * FROM urls WHERE identifier=?").bind(identifier).all();
  expect(stored.results).toHaveLength(1);
  const row = stored.results[0];
  if (row === undefined) {
    throw new Error("Expected the seeded URL row");
  }
  const faultyStatement = productionEnv.DB.prepare("SELECT 1");
  vi.spyOn(faultyStatement, "bind").mockReturnValue(faultyStatement);
  vi.spyOn(faultyStatement, "all").mockResolvedValue({ ...stored, results: [row, row] });
  const prepareOriginal = productionEnv.DB.prepare.bind(productionEnv.DB);
  const prepare = vi.spyOn(productionEnv.DB, "prepare").mockImplementation((sql) => {
    if (sql.startsWith("UPDATE urls SET destination=")) {
      return faultyStatement;
    }
    return prepareOriginal(sql);
  });
  const headers = { "Cf-Access-Jwt-Assertion": await fixture.token(), "Content-Type": "application/json" };
  const rejected = await send("management", `/urls/${identifier}`, {
    method: "PUT", headers,
    body: JSON.stringify({ destination: "https://example.com/updated", expiresAt: null, version: 1 }),
  });
  expect(rejected.status).toBe(500);
  expect(await rejected.text()).not.toContain("https://example.com/original");
  prepare.mockRestore();
  const recovered = await send("management", `/urls/${identifier}`, { headers });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ identifier, destination: "https://example.com/original", version: 1 });
});
