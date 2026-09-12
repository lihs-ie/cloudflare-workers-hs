import { it, expect } from "vitest";

export function registerQuickstartLeaseBoundaries(
  probe: (namespace: unknown, mode: number) => Promise<string>,
) {
  for (const scenario of [
    "success",
    "release-conflict",
    "acquire-failure",
    "invalid-json",
    "oversized",
    "renew-failure",
    "release-failure",
    "transport-failure",
    "action-failure",
  ] as const) {
    it(`Haskell coordinator lease transport and cleanup: ${scenario}`, async () => {
      const calls: string[] = [];
      const namespace = {
        getByName(name: string) {
          expect(name).toBe("csv-exports");
          return {
            async fetch(request: Request) {
              const path = new URL(request.url).pathname;
              calls.push(path);
              const payload = (await request.json()) as {
                export: string;
                token?: string;
              };
              expect(payload.export).toBe("boundary-export");
              if (scenario === "transport-failure") {
                throw new Error("transport_failed");
              }
              if (path === "/acquire") {
                if (scenario === "acquire-failure") {
                  return new Response("busy", { status: 409 });
                }
                if (scenario === "invalid-json") {
                  return new Response("not-json");
                }
                if (scenario === "oversized") {
                  return new Response("x".repeat(4097));
                }
                return Response.json({
                  export: "boundary-export",
                  token: "lease-token",
                  expiresAt: 9999999999999,
                });
              }
              expect(payload.token).toBe("lease-token");
              if (path === "/renew") {
                return new Response(null, {
                  status: scenario === "renew-failure" ? 409 : 200,
                });
              }
              return new Response(null, {
                status:
                  scenario === "release-failure"
                    ? 500
                    : scenario === "release-conflict"
                      ? 409
                      : 204,
              });
            },
          };
        },
      };
      const result = JSON.parse(
        await probe(namespace, scenario === "action-failure" ? 1 : 0),
      ) as { ok: boolean; ran: boolean; error: string };
      const acquired = ![
        "acquire-failure",
        "invalid-json",
        "oversized",
        "transport-failure",
      ].includes(scenario);
      expect(result.ran).toBe(acquired);
      expect(result.ok).toBe(
        ["success", "release-conflict"].includes(scenario),
      );
      expect(calls).toEqual(
        !acquired
          ? ["/acquire"]
          : scenario === "action-failure"
            ? ["/acquire", "/release"]
            : ["/acquire", "/renew", "/release"],
      );
      if (scenario === "action-failure") {
        expect(result.error).toContain("action_failed");
      }
    });
  }
}
