import { it, expect } from "vitest";

// The root harness provides the actual WASM export, native DB, and migrations.
export function registerQuickstartManagementBoundaries(
  setup: () => Promise<{
    database: D1Database;
    send: (mode: number, request: Request) => Promise<Response>;
  }>,
) {
  for (const scenario of ["recover", "exhaust", "constraint"] as const) {
    it(`management native D1 identifier collision contract: ${scenario}`, async () => {
      const { database, send } = await setup();
      await database
        .prepare(
          "INSERT INTO urls(identifier,destination,created_at,version) VALUES('collision','https://example.com/','2026-01-01T00:00:00Z',1)",
        )
        .run();
      if (scenario === "constraint") {
        await database.exec(
          "CREATE TRIGGER reject_new_url BEFORE INSERT ON urls BEGIN SELECT RAISE(ABORT, 'other constraint'); END;",
        );
      }
      try {
        const response = await send(
          scenario === "exhaust" ? 1 : 0,
          new Request("https://boundary/urls", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "boundary-key",
            },
            body: JSON.stringify({
              destination: "https://example.net/",
              expiresAt: null,
            }),
          }),
        );
        expect(response.status).toBe(scenario === "recover" ? 201 : 500);
        if (scenario === "recover") {
          expect(
            ((await response.json()) as { identifier: string }).identifier,
          ).toBe("fresh-1");
        } else {
          await response.body?.cancel();
        }
        expect(
          (await database.prepare("SELECT COUNT(*) AS n FROM urls").first())?.n,
        ).toBe(scenario === "recover" ? 2 : 1);
        expect(
          (
            await database
              .prepare("SELECT COUNT(*) AS n FROM admin_idempotency")
              .first()
          )?.n,
        ).toBe(scenario === "recover" ? 1 : 0);
      } finally {
        if (scenario === "constraint") {
          await database.exec("DROP TRIGGER reject_new_url;");
        }
      }
    });
  }
  it("rejects a creation whose persisted receipt disappears", async () => {
    const { database, send } = await setup();
    await database.exec(
      "CREATE TRIGGER disappear_receipt AFTER INSERT ON admin_idempotency BEGIN DELETE FROM admin_idempotency WHERE admin=NEW.admin AND key=NEW.key; END;",
    );
    try {
      const response = await send(
        0,
        new Request("https://boundary/urls", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "lost",
          },
          body: JSON.stringify({
            destination: "https://example.net/",
            expiresAt: null,
          }),
        }),
      );
      expect(response.status).toBe(500);
      expect(
        (await database.prepare("SELECT COUNT(*) AS n FROM urls").first())?.n,
      ).toBe(0);
    } finally {
      await database.exec("DROP TRIGGER disappear_receipt;");
    }
  });
  it("rejects malformed stored URL dates and recovers after repair", async () => {
    const { database, send } = await setup();
    await database
      .prepare(
        "INSERT INTO urls(identifier,destination,created_at,version) VALUES('broken','https://example.com/','invalid-date',1)",
      )
      .run();
    const rejected = await send(0, new Request("https://boundary/urls/broken"));
    expect(rejected.status).toBe(500);
    expect(await rejected.text()).toBe("Internal Server Error");
    await database
      .prepare(
        "UPDATE urls SET created_at='2026-01-01T00:00:00Z' WHERE identifier='broken'",
      )
      .run();
    expect(
      (await send(0, new Request("https://boundary/urls/broken"))).status,
    ).toBe(200);
  });

  it("rejects a malformed stored idempotency response instead of creating a duplicate", async () => {
    const { database, send } = await setup();
    const body = JSON.stringify({
      destination: "https://example.net/",
      expiresAt: null,
    });
    const request = () =>
      new Request("https://boundary/urls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "corrupt-replay",
        },
        body,
      });
    expect((await send(0, request())).status).toBe(201);
    const stored = await database
      .prepare(
        "SELECT response_body FROM admin_idempotency WHERE key='corrupt-replay'",
      )
      .first<{ response_body: string }>();
    if (!stored) {
      throw new Error("Expected stored creation receipt");
    }
    await database
      .prepare(
        "UPDATE admin_idempotency SET response_body='not-json' WHERE key='corrupt-replay'",
      )
      .run();
    const rejected = await send(0, request());
    expect(rejected.status).toBe(500);
    expect(await rejected.text()).toBe("Internal Server Error");
    await database
      .prepare(
        "UPDATE admin_idempotency SET response_body=? WHERE key='corrupt-replay'",
      )
      .bind(stored.response_body)
      .run();
    expect((await send(0, request())).status).toBe(201);
    expect(
      (await database.prepare("SELECT COUNT(*) AS n FROM urls").first())?.n,
    ).toBe(1);
  });
}
