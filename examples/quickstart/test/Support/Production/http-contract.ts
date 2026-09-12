/** Shared assertions for workerd and real `wrangler dev` processes. */
export type Application = "redirect" | "management" | "export" | "recovery";
export type Send = (application: Application, pathname: string, init?: RequestInit) => Promise<Response>;
export type Check = (condition: boolean, description: string) => void;

export async function exerciseManagement(send: Send, token: string, check: Check) {
  const headers = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" };
  for (const application of ["management", "export", "recovery"] as const) {
    const route = application === "management" ? "/urls" : application === "export" ? "/exports/missing" : "/events";
    check((await send(application, route)).status === 401, `${application}: missing Access token is rejected`);
    check((await send(application, "/unknown-route")).status === 401, `${application}: unknown routes remain protected`);
    check((await send(application, route, { method: "OPTIONS" })).status === 401, `${application}: unsupported methods remain protected`);
    check((await send(application, route, { headers: { "Cf-Access-Jwt-Assertion": "invalid" } })).status === 401, `${application}: malformed Access token is rejected`);
  }
  const payload = { destination: "https://example.com/initial", expiresAt: null };
  const key = crypto.randomUUID();
  const create = () => send("management", "/urls", { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify(payload) });
  const initial = await create();
  const initialBody = await initial.text();
  check(initial.status === 201, `URL creation returns 201, received ${initial.status}: ${initialBody}`);
  const created = JSON.parse(initialBody) as { identifier: string; version: number; destination: string };
  check(typeof created.identifier === "string" && created.identifier.length > 0, "URL creation returns its identifier");
  const repeated = await create();
  check(repeated.status === initial.status && await repeated.text() === initialBody, "Idempotency replay preserves initial status and body");
  const conflict = await send("management", "/urls", { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ ...payload, destination: "https://example.com/other" }) });
  check(conflict.status === 409, "Idempotency key with changed payload conflicts");
  const location = `/r/${encodeURIComponent(created.identifier)}`;
  const redirect = await send("redirect", location);
  check(redirect.status === 302 && redirect.headers.get("Location") === payload.destination, "Public redirect returns original destination");
  const get = await send("management", `/urls/${created.identifier}`, { headers });
  check(get.status === 200, "Administrator can read created URL");
  const updates = await Promise.all(["one", "two"].map((suffix) => send("management", `/urls/${created.identifier}`, {
    method: "PUT", headers, body: JSON.stringify({ destination: `https://example.com/${suffix}`, expiresAt: null, version: created.version }),
  })));
  check(updates.filter((response) => response.status === 200).length === 1 && updates.filter((response) => response.status === 409).length === 1, "Concurrent updates at the same version have exactly one winner");
  const winner = await updates.find((response) => response.status === 200)!.json() as { destination: string; version: number };
  const changed = await send("redirect", location);
  check(changed.status === 302 && changed.headers.get("Location") === winner.destination, "Completed edit immediately changes redirect");
  const staleDelete = await send("management", `/urls/${created.identifier}?version=${created.version}`, { method: "DELETE", headers });
  check(staleDelete.status === 409, "Stale deletion cannot remove edited URL");
  const deletion = await send("management", `/urls/${created.identifier}?version=${winner.version}`, { method: "DELETE", headers });
  check(deletion.status === 204, `Current-version deletion returns 204, got ${deletion.status}`);
  check((await send("redirect", location)).status === 404, "Completed deletion immediately disables redirect");
  const afterDelete = await create();
  check(afterDelete.status === initial.status && await afterDelete.text() === initialBody, "Creation replay after deletion preserves original result");
  check((await send("redirect", "/r/nonexistent")).status === 404, "Unknown code is 404");
  return created;
}

/** Background consumers must run in the caller's environment. */
export async function exerciseExport(send: Send, token: string, check: Check, range?: { startDay: string; endDay: string }) {
  const headers = { "Cf-Access-Jwt-Assertion": token, "Content-Type": "application/json" };
  const day = new Date().toISOString().slice(0, 10);
  const accepted = await send("export", "/exports", { method: "POST", headers, body: JSON.stringify(range ?? { startDay: day, endDay: day }) });
  const acceptedBody = await accepted.text();
  check(accepted.status === 202, `CSV export accepted: expected202 got${accepted.status}: ${acceptedBody}`);
  const { identifier } = JSON.parse(acceptedBody) as { identifier: string };
  const deadline = Date.now() + 60000;
  let complete = false;
  while (Date.now() < deadline) {
    const status = await send("export", `/exports/${identifier}`, { headers });
    check(status.status === 200, "CSV export status is readable");
    const result = await status.json() as { status: string };
    if (result.status === "complete") { complete = true; break; }
    check(result.status !== "failed", "CSV background generation does not fail");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check(complete, "CSV Queue consumer completes within60seconds");
  const download = await send("export", `/exports/${identifier}/download`, { headers });
  check(download.status === 200, `Completed CSV download returns200 got${download.status}`);
  const csv = await download.text();
  check(csv.startsWith("url,day,count,snapshot_at"), "CSV stream has documented header");
  check((await send("export", `/exports/${identifier}/download`)).status === 401, "CSV download requires Access authentication");
  return { identifier, csv };
}
