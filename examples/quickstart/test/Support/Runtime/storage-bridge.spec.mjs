import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Run the actual CLI with a fake Miniflare boundary; no Worker is started.
const bridge = fileURLToPath(new URL("./storage-bridge.mjs", import.meta.url));
const preload = `
import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync(process.env.BRIDGE_EVENTS, value + '\\n');
globalThis.setTimeout = callback => { record('timer-start'); if (process.env.BRIDGE_CASE === 'timeout') { callback(); } return 17; };
globalThis.clearTimeout = timer => { record('timer-clear:' + timer); };
const runtime = \`
import { appendFileSync } from 'node:fs';
const record = value => appendFileSync(process.env.BRIDGE_EVENTS, value + '\\\\n');
export class Log {}
export const LogLevel = { NONE: 0 };
export class Miniflare {
  constructor(options) { record('construct'); if (process.env.BRIDGE_CASE === 'stdio') {
    if (options.scriptPath !== process.env.RUNTIME_MODEL_BUNDLE) { throw new Error('bundle override ignored'); }
    const stream = { pipe(destination, config) { if (destination !== process.stderr || config.end !== false) { throw new Error('stdio forwarding invalid'); } record('pipe'); } };
    options.handleRuntimeStdio(stream, stream);
  } if (process.env.BRIDGE_CASE === 'construct') { throw new Error('constructor failure'); } }
  async dispatchFetch(url, init) {
    record('dispatch');
    if (process.env.BRIDGE_CASE === 'dispatch') { throw new Error('dispatch failure'); }
    if (process.env.BRIDGE_CASE === 'json') { return new Response('not JSON'); }
    if (process.env.BRIDGE_CASE === 'http') { return new Response('failure detail', { status: 503 }); }
    return Response.json(JSON.parse(init.body));
  }
  async dispose() { record('dispose'); if (process.env.BRIDGE_CASE === 'dispose') { throw new Error('dispose failure'); } }
}
\`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'miniflare') { return { url: 'data:text/javascript,' + encodeURIComponent(runtime), shortCircuit: true }; }
  if (specifier === './build-manifest.mts') { return { url: 'data:text/javascript,export function verifyBundle() {}', shortCircuit: true }; }
  return next(specifier, context);
}});
`;

for (const scenario of [
  "construct",
  "dispose",
  "dispatch",
  "http",
  "json",
  "success",
]) {
  test(`storage bridge clears its deadline after ${scenario}`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "storage-bridge-contract-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const loader = join(directory, "preload.mjs");
    const events = join(directory, "events.txt");
    writeFileSync(loader, preload);
    const result = spawnSync(process.execPath, ["--import", loader, bridge], {
      input: '[{"command":"get","key":"sample","bytes":[]}]',
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, BRIDGE_CASE: scenario, BRIDGE_EVENTS: events },
    });
    assert.equal(result.error, undefined);
    const recorded = readFileSync(events, "utf8").trim().split("\n");
    assert.deepEqual(
      recorded,
      scenario === "construct"
        ? ["timer-start", "construct", "timer-clear:17"]
        : ["timer-start", "construct", "dispatch", "dispose", "timer-clear:17"],
    );
    assert.equal(result.status, scenario === "success" ? 0 : 1);
    if (scenario === "success") {
      assert.deepEqual(JSON.parse(result.stdout), [
        { command: "get", key: "sample", bytes: [] },
      ]);
    } else {
      const messages = {
        construct: "constructor failure",
        dispose: "dispose failure",
        dispatch: "dispatch failure",
        http: "Model harness returned 503: failure detail",
        json: "SyntaxError",
      };
      assert.ok(result.stderr.includes(messages[scenario]), result.stderr);
    }
  });
}

for (const scenario of ["invalid-input", "timeout", "stdio"]) {
  test(`storage bridge handles ${scenario} at its process boundary`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "storage-bridge-boundary-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const loader = join(directory, "preload.mjs");
    const events = join(directory, "events.txt");
    writeFileSync(loader, preload);
    writeFileSync(events, "");
    const result = spawnSync(process.execPath, ["--import", loader, bridge], {
      input: scenario === "invalid-input" ? "invalid JSON" : "[]",
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        BRIDGE_CASE: scenario,
        BRIDGE_EVENTS: events,
        RUNTIME_MODEL_BUNDLE: join(directory, "custom-harness.js"),
      },
    });
    assert.equal(result.error, undefined);
    const recorded = readFileSync(events, "utf8").trim();
    if (scenario === "invalid-input") {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /SyntaxError/);
      assert.equal(recorded, "");
    } else if (scenario === "timeout") {
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Storage model runtime exceeded 60 seconds/);
      assert.equal(recorded, "timer-start");
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), []);
      assert.deepEqual(recorded.split("\n"), [
        "timer-start",
        "construct",
        "pipe",
        "pipe",
        "dispatch",
        "dispose",
        "timer-clear:17",
      ]);
    }
  });
}
