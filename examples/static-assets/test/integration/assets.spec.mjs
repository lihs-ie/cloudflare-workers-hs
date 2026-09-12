import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startDev } from "../Support/dev.mjs";
let worker;
before(async () => { worker = await startDev(); }, { timeout: 90000 });
after(async () => { await worker?.close(); });
const request = (path, options) => fetch(`${worker.base}${path}`, { ...options, signal: AbortSignal.timeout(10000) });

test("bundled HTML, JS and CSS are streamed through the Haskell Assets binding", async () => {
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /text\/html/);
  assert.match(await home.text(), /APIの状態を確認/);
  const js = await request("/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.match(await js.text(), /\/api\/health/);
  const css = await request("/style.css");
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /text\/css/);
  assert.match(await css.text(), /focus-visible/);
});
test("NamedRoutes API wins over same-path assets and reserves the API namespace", async () => {
  const response = await request("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", runtime: "Haskell/WASM" });
  const unknown = await request("/api/missing");
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: { status: 404, message: "Not Found" } });
  const wrongMethod = await request("/api/health", { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, HEAD");
  await wrongMethod.arrayBuffer();
});
test("asset HEAD and conditional GET preserve native headers and empty bodies", async () => {
  const original = await request("/style.css?version=1");
  const etag = original.headers.get("etag");
  const body = await original.text();
  assert.ok(etag);
  const head = await request("/style.css", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("etag"), etag);
  assert.equal(await head.text(), "");
  const unchanged = await request("/style.css", { headers: { "If-None-Match": etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(await unchanged.text(), "");
  const changed = await request("/style.css", { headers: { "If-None-Match": '"not-the-current-etag"' } });
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), body);
});
test("missing files remain 404 rather than returning the application shell", async () => {
  const missing = await request("/not-a-file.txt");
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
});

test("reserved API paths preserve content negotiation failures", async () => {
  for (const method of ["GET", "HEAD"]) {
    const response = await request("/api/%68ealth", { method, headers: { Accept: "text/plain" } });
    assert.equal(response.status, 406, `${method} /api/%68ealth; logs: ${worker.logPath}\n${worker.getLogs()}`);
    assert.equal(await response.text(), method === "HEAD" ? "" : "Not Acceptable");
  }
  const trailing = await request("/api/health/");
  assert.equal(trailing.status, 200);
  assert.deepEqual(await trailing.json(), { status: "ok", runtime: "Haskell/WASM" });
});

test("namespace selection uses decoded segments and exact boundaries", async () => {
  const outside = await request("/apiary.txt?version=1");
  assert.equal(outside.status, 200, `/apiary.txt; logs: ${worker.logPath}\n${worker.getLogs()}`);
  assert.match(await outside.text(), /Segment boundaries/);
  for (const path of ["/%61pi/missing", "/api/missing", "/api"]) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { status: 404, message: "Not Found" } });
  }
});


test("concurrent asset streams preserve independent response bodies", async () => {
  const paths = ["/", "/app.js", "/style.css"];
  const expected = await Promise.all(paths.map(async (path) => {
    const response = await request(path);
    assert.equal(response.status, 200);
    return response.text();
  }));
  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    const selected = index % paths.length;
    const response = await request(paths[selected]);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), expected[selected]);
  }));
});
