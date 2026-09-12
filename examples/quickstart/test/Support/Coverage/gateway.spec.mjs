import assert from "node:assert/strict";
import { test } from "node:test";
import gateway from "../Dev/gateway.ts";

test("gateway preserves request method, headers, body, query and response identity", async () => {
  const expected = new Response("delegated", { status: 207 });
  const request = new Request("https://dev.invalid/management/links?cursor=next", {
    method: "POST", headers: { "X-Trace": "request" }, body: "payload",
  });
  const response = await gateway.fetch(request, { management: { async fetch(forwarded) {
    assert.equal(forwarded.url, "https://dev.invalid/links?cursor=next");
    assert.equal(forwarded.method, "POST");
    assert.equal(forwarded.headers.get("X-Trace"), "request");
    assert.equal(await forwarded.text(), "payload");
    return expected;
  } } });
  assert.equal(response, expected);
});

test("gateway rejects unknown bindings and maps an app root to slash", async () => {
  assert.equal((await gateway.fetch(new Request("https://dev.invalid/unknown"), {})).status, 404);
  await gateway.fetch(new Request("https://dev.invalid/redirect"), { redirect: { async fetch(request) {
    assert.equal(request.url, "https://dev.invalid/");
    return new Response("root");
  } } });
});
