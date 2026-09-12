import assert from "node:assert/strict";
import { test } from "node:test";
import { exerciseExport, exerciseManagement } from "./http-contract.ts";

// Scripted transport checks the client-side verification protocol only. It does
// not substitute for the real Worker integration tests using these assertions.
function transport(steps) {
  let cursor = 0;
  return {
    send: async (application, pathname, init) => {
      const step = steps[cursor++];
      assert.ok(step, `Unexpected request: ${application} ${pathname}`);
      assert.equal(application, step.application ?? "export");
      assert.equal(pathname, step.path);
      if (step.inspect) {
        step.inspect(init);
      }
      return step.response;
    },
    verify: () => assert.equal(cursor, steps.length),
  };
}
const check = (condition, description) => assert.ok(condition, description);
const accepted = () => ({
  path: "/exports",
  response: Response.json({ identifier: "job" }, { status: 202 }),
});
const status = (state) => ({
  path: "/exports/job",
  response: Response.json({ status: state }),
});
const csv =
  "url,day,count,snapshot_at\nhttps://example.com,2026-09-12,1,2026-09-12T00:00:00Z\n";
const download = () => ({
  path: "/exports/job/download",
  response: new Response(csv),
});
const unauthorized = () => ({
  path: "/exports/job/download",
  response: new Response(null, { status: 401 }),
});

for (const range of [
  undefined,
  { startDay: "2026-09-01", endDay: "2026-09-02" },
]) {
  test(`export forwards ${range ? "explicit" : "UTC default"} range and polls before downloading`, async (t) => {
    const now = new Date("2026-09-12T23:30:00Z");
    t.mock.timers.enable({ apis: ["Date"], now });
    t.mock.method(globalThis, "setTimeout", (callback, delay) => {
      assert.equal(delay, 250);
      callback();
    });
    const request = accepted();
    request.inspect = (init) => {
      assert.equal(init.method, "POST");
      assert.equal(init.headers["Cf-Access-Jwt-Assertion"], "token");
      assert.deepEqual(
        JSON.parse(init.body),
        range ?? { startDay: "2026-09-12", endDay: "2026-09-12" },
      );
    };
    const fixture = transport([
      request,
      status("queued"),
      status("complete"),
      download(),
      unauthorized(),
    ]);
    assert.deepEqual(
      await exerciseExport(fixture.send, "token", check, range),
      { identifier: "job", csv },
    );
    fixture.verify();
  });
}

test("failed background job stops polling without requesting a download", async () => {
  const fixture = transport([accepted(), status("failed")]);
  await assert.rejects(
    exerciseExport(fixture.send, "token", check),
    /background generation does not fail/,
  );
  fixture.verify();
});

test("deadline exhaustion rejects rather than downloading unfinished output", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  t.mock.method(globalThis, "setTimeout", (callback) => {
    t.mock.timers.setTime(60_000);
    callback();
  });
  const fixture = transport([accepted(), status("running")]);
  await assert.rejects(
    exerciseExport(fixture.send, "token", check),
    /completes within60seconds/,
  );
  fixture.verify();
});

for (const [name, steps, message] of [
  [
    "rejected creation",
    [
      {
        path: "/exports",
        response: new Response("unavailable", { status: 503 }),
      },
    ],
    /expected202 got503: unavailable/,
  ],
  [
    "unreadable status",
    [
      accepted(),
      { path: "/exports/job", response: new Response(null, { status: 404 }) },
    ],
    /status is readable/,
  ],
  [
    "failed download",
    [
      accepted(),
      status("complete"),
      {
        path: "/exports/job/download",
        response: new Response(null, { status: 500 }),
      },
    ],
    /returns200 got500/,
  ],
  [
    "invalid CSV header",
    [
      accepted(),
      status("complete"),
      {
        path: "/exports/job/download",
        response: new Response("wrong,header\n"),
      },
    ],
    /documented header/,
  ],
  [
    "public download leak",
    [
      accepted(),
      status("complete"),
      download(),
      { path: "/exports/job/download", response: new Response(csv) },
    ],
    /requires Access authentication/,
  ],
]) {
  test(`export contract detects ${name}`, async () => {
    const fixture = transport(steps);
    await assert.rejects(exerciseExport(fixture.send, "token", check), message);
    fixture.verify();
  });
}

test("management stops on the first unprotected endpoint", async () => {
  const fixture = transport([
    { application: "management", path: "/urls", response: new Response("[]") },
  ]);
  await assert.rejects(
    exerciseManagement(fixture.send, "token", check),
    /missing Access token is rejected/,
  );
  fixture.verify();
});

function protectedRoutes() {
  return ["management", "export", "recovery"].flatMap((application) => {
    const path =
      application === "management"
        ? "/urls"
        : application === "export"
          ? "/exports/missing"
          : "/events";
    return [path, "/unknown-route", path, path].map((route) => ({
      application,
      path: route,
      response: new Response(null, { status: 401 }),
    }));
  });
}

for (const identifier of [null, ""]) {
  test(`management rejects ${identifier === null ? "null" : "empty"} identifiers before attempting replay`, async () => {
    const fixture = transport([
      ...protectedRoutes(),
      {
        application: "management",
        path: "/urls",
        response: Response.json({ identifier, version: 1 }, { status: 201 }),
      },
    ]);
    await assert.rejects(
      exerciseManagement(fixture.send, "token", check),
      /returns its identifier/,
    );
    fixture.verify();
  });
}

for (const mismatch of ["status", "body"]) {
  test(`management detects idempotency replay ${mismatch} mismatch`, async () => {
    const body = {
      identifier: "example",
      version: 1,
      destination: "https://example.com/initial",
    };
    let key;
    const fixture = transport([
      ...protectedRoutes(),
      {
        application: "management",
        path: "/urls",
        response: Response.json(body, { status: 201 }),
        inspect: (init) => {
          key = init.headers["Idempotency-Key"];
          assert.equal(typeof key, "string");
        },
      },
      {
        application: "management",
        path: "/urls",
        response: Response.json(
          mismatch === "body" ? { ...body, version: 2 } : body,
          { status: mismatch === "status" ? 200 : 201 },
        ),
        inspect: (init) => {
          assert.equal(init.headers["Idempotency-Key"], key);
        },
      },
    ]);
    await assert.rejects(
      exerciseManagement(fixture.send, "token", check),
      /replay preserves initial status and body/,
    );
    fixture.verify();
  });
}

test("management completes creation, idempotency, concurrent updates and deletion", async () => {
  const created = {
    identifier: "url-one",
    version: 1,
    destination: "https://example.com/initial",
  };
  const initialBody = JSON.stringify(created);
  let writes = 0;
  let updates = 0;
  let redirects = 0;
  let deletions = 0;
  const send = async (application, path, init = {}) => {
    if (
      !init.headers ||
      init.headers["Cf-Access-Jwt-Assertion"] === "invalid"
    ) {
      if (application !== "redirect") {
        return new Response(null, { status: 401 });
      }
    }
    if (application === "redirect") {
      redirects += 1;
      if (redirects > 2) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location:
            redirects === 1 ? created.destination : "https://example.com/one",
        },
      });
    }
    if (init.method === "POST") {
      writes += 1;
      return writes === 3
        ? new Response(null, { status: 409 })
        : new Response(initialBody, { status: 201 });
    }
    if (init.method === "PUT") {
      updates += 1;
      return updates === 1
        ? Response.json({ destination: "https://example.com/one", version: 2 })
        : new Response(null, { status: 409 });
    }
    if (init.method === "DELETE") {
      deletions += 1;
      return new Response(null, { status: deletions === 1 ? 409 : 204 });
    }
    return Response.json(created);
  };
  assert.deepEqual(await exerciseManagement(send, "token", check), created);
  assert.equal(writes, 4);
  assert.equal(updates, 2);
  assert.equal(deletions, 2);
  assert.equal(redirects, 4);
});
