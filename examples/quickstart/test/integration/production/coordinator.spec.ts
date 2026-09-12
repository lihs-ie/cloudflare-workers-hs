import { describe, expect, it } from "vitest";
import {
  env,
  evictDurableObject,
  runInDurableObject,
  runDurableObjectAlarm,
} from "cloudflare:test";
import type { ExportCoordinator } from "../../../worker/export-coordinator.js";

const namespace = env.COORDINATOR;
type Lease = { export: string; token: string; expiresAt: number };
function call(
  stub: DurableObjectStub<ExportCoordinator>,
  path: string,
  body: object,
) {
  return stub.fetch(`https://coordinator${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("production Durable Object export leases", () => {
  it("persists capacity across eviction and fences concurrent and obsolete tokens", async () => {
    const stub = namespace.get(namespace.newUniqueId());
    const candidates = await Promise.all(
      ["one", "two", "three"].map((value) =>
        call(stub, "/acquire", { export: value }),
      ),
    );
    expect(candidates.map((response) => response.status).sort()).toEqual([
      200, 200, 409,
    ]);
    const bodies = await Promise.all(
      candidates.map((response) => response.json()),
    );
    const lease = bodies[
      candidates.findIndex((response) => response.status === 200)
    ] as Lease;
    await evictDurableObject(stub);
    expect((await call(stub, "/acquire", { export: "four" })).status).toBe(409);
    expect(
      (
        await call(stub, "/release", {
          export: lease.export,
          token: "obsolete",
        })
      ).status,
    ).toBe(409);
    expect(
      (await call(stub, "/renew", { export: lease.export, token: lease.token }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(stub, "/release", {
          export: lease.export,
          token: lease.token,
        })
      ).status,
    ).toBe(204);
    const replacement = (await (
      await call(stub, "/acquire", { export: lease.export })
    ).json()) as Lease;
    expect(replacement.token).not.toBe(lease.token);
    expect(
      (await call(stub, "/renew", { export: lease.export, token: lease.token }))
        .status,
    ).toBe(409);
    expect(
      (
        await call(stub, "/release", {
          export: lease.export,
          token: lease.token,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(stub, "/renew", {
          export: replacement.export,
          token: replacement.token,
        })
      ).status,
    ).toBe(200);
  });

  it("Alarm removes only expired persistent leases and reschedules the surviving lease", async () => {
    const stub = namespace.get(namespace.newUniqueId());
    const expired = (await (
      await call(stub, "/acquire", { export: "expired" })
    ).json()) as Lease;
    const live = (await (
      await call(stub, "/acquire", { export: "live" })
    ).json()) as Lease;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(
        "leases",
        new TextEncoder().encode(
          JSON.stringify([{ ...expired, expiresAt: Date.now() - 1 }, live]),
        ),
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const stored = await runInDurableObject(stub, async (_instance, state) => ({
      leases: JSON.parse(
        new TextDecoder().decode(await state.storage.get<Uint8Array>("leases")),
      ) as Lease[],
      alarm: await state.storage.getAlarm(),
    }));
    expect(stored.leases).toEqual([live]);
    expect(stored.alarm).toBe(live.expiresAt);
    expect((await call(stub, "/acquire", { export: "new" })).status).toBe(200);
    expect(
      (
        await call(stub, "/release", {
          export: expired.export,
          token: expired.token,
        })
      ).status,
    ).toBe(409);
  });
});

it("rejects malformed coordinator commands without allocating leases", async () => {
  const stub = namespace.get(namespace.newUniqueId());
  expect((await stub.fetch("https://coordinator/acquire")).status).toBe(405);
  for (const [path, body] of [
    ["/acquire", "not-json"],
    ["/acquire", "{}"],
    ["/acquire", JSON.stringify({ export: "" })],
    ["/acquire", JSON.stringify({ export: "x".repeat(257) })],
    ["/unknown", JSON.stringify({ export: "one" })],
    ["/renew", JSON.stringify({ export: "one" })],
    ["/release", JSON.stringify({ export: "one" })],
    ["/acquire", "x".repeat(4097)],
  ]) {
    const response = await stub.fetch(`https://coordinator${path}`, {
      method: "POST",
      body,
    });
    expect(response.status, `${path} ${body.slice(0, 30)}`).toBe(400);
    await response.body?.cancel();
  }
  const acquired = await call(stub, "/acquire", { export: "x".repeat(256) });
  expect(acquired.status).toBe(200);
  const lease = (await acquired.json()) as Lease;
  expect(
    (await call(stub, "/release", { export: lease.export, token: lease.token }))
      .status,
  ).toBe(204);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
    const stored = await state.storage.get<Uint8Array>("leases");
    expect(JSON.parse(new TextDecoder().decode(stored))).toEqual([]);
  });
});

it("rejects corrupt durable lease state and recovers after explicit repair", async () => {
  const stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("leases", new TextEncoder().encode("not-json"));
  });
  const rejected = await call(stub, "/acquire", { export: "repairable" });
  expect(rejected.status).toBe(500);
  expect(await rejected.text()).toBe("Internal Server Error");
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("leases", new TextEncoder().encode("[]"));
  });
  expect((await call(stub, "/acquire", { export: "repairable" })).status).toBe(
    200,
  );
});

it("rejects a POST without a body and release of an unknown lease", async () => {
  const stub=namespace.get(namespace.newUniqueId());
  expect((await stub.fetch("https://coordinator/acquire",{method:"POST"})).status).toBe(400);
  expect((await call(stub,"/release",{export:"missing",token:"missing"})).status).toBe(409);
  await runInDurableObject(stub,async (_instance,state)=>{
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
