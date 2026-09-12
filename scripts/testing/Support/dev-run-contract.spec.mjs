import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, mock } from "node:test";

const entry = new URL("../../../examples/quickstart/test/Support/Dev/run.mts", import.meta.url);
let serial = 0;
for (const scenario of ["success", "connection-retry", "aggregation-retry", "readiness-timeout", "invalid-config", "migration-failure", "spawn-error", "early-exit", "readiness-failure", "configured-http-failure", "configured-shape-failure", "stats-failure", "wrong-count", "missing-csv", "worker-exit", "worker-signal", "missing-pid", "jwks-listen-error", "port-listen-error", "build-error", "fixture-error", "read-error", "write-error", "mkdir-error", "state-error", "remove-error", "evidence-error", "readiness-error", "configured-primitive", "configured-missing", "aggregation-timeout", "recovery-status", "recovery-shape", "replay-status", "sigterm", "sigint", "kill-fallback", "kill-race", "kill-missing", "execute-timeout"]) {
  test(`quickstart dev command: ${scenario} records outcome and cleans resources`, async () => {
    const successful = ["success", "connection-retry", "aggregation-retry", "sigterm", "sigint", "kill-fallback", "kill-race", "kill-missing"].includes(scenario);
    const controls = [];
    let readinessCalls = 0;
    const children = [];
    const files = new Map();
    const removed = [];
    let jwksHandler;
    let validations = 0;
    let fixtureNumber = 0;
    let configured = 0;
    let identityCalls = 0;
    let closed = 0;
    let statsCalls = 0;
    const exits = [];
    const kills = [];
    let aggregationClock = false;
    let serverNumber = 0;
    const realTimeout = globalThis.setTimeout;
    const timers = new Set();
    const oldExit = process.exitCode;
    const oldEndpoint = process.env.WASM_COVERAGE_ENDPOINT;
    if (scenario === "success") { process.env.WASM_COVERAGE_ENDPOINT = "http://coverage.test"; }
    else { delete process.env.WASM_COVERAGE_ENDPOINT; }
    const moduleMock = (specifier, namedExports) => controls.push(moduleBoundary(specifier, { namedExports }));
    const server = () => { const number = serverNumber++; return Object.assign(new EventEmitter(), {
      listening: false,
      listen(_port, _host, callback) {
        if ((scenario === "jwks-listen-error" && number === 0) || (scenario === "port-listen-error" && number === 1)) { queueMicrotask(() => this.emit("error", new Error("listen contract failure"))); return; }
        this.listening = true; queueMicrotask(callback);
      },
      address() { return { port: 4321 }; },
      close(callback) { this.listening = false; closed++; queueMicrotask(callback); },
    }); };
    moduleMock("node:net", { createServer: server });
    moduleMock("node:http", { createServer: (handler) => { jwksHandler = handler; return server(); } });
    moduleMock("node:fs/promises", {
      mkdir: async () => { if (scenario === "mkdir-error") { throw new Error("mkdir failure"); } }, mkdtemp: async () => { if (scenario === "state-error") { throw new Error("state failure"); } return "/contract/state"; },
      readFile: async () => { if (scenario === "read-error") { throw new Error("read failure"); } return scenario === "invalid-config" ? "{" : '{"name":"contract-worker","build":{"command":"never"}}'; },
      writeFile: async (filename, content) => { if (scenario === "write-error" && filename.includes(".dev-test-")) { throw new Error("write failure"); }
        if (scenario === "evidence-error" && filename.endsWith("results.json")) { throw new Error("evidence failure"); }
        files.set(filename, content); },
      rm: async (filename) => { removed.push(filename); if (scenario === "remove-error") { throw new Error("remove failure"); } },
    });
    moduleMock(new URL("../Runtime/build-manifest.mts", entry), { verifyBuild: () => { validations++; if (scenario === "build-error") { throw new Error("build failure"); } } });
    moduleMock(new URL("../Production/auth.ts", entry), {
      accessTeam: "contract-team", accessAudience: "contract-audience",
      createAccessFixture: async () => { if (scenario === "fixture-error") { throw new Error("fixture failure"); } const number = fixtureNumber++; return { jwks: { keys: [{ kid: String(number) }] }, token: async (claims = {}) => JSON.stringify({ number, ...claims }) }; },
    });
    moduleMock(new URL("../Production/http-contract.ts", entry), {
      exerciseManagement: async () => { aggregationClock = scenario === "aggregation-timeout"; return { identifier: "retained-url" }; },
      exerciseExport: async () => ({ csv: scenario === "missing-csv" ? "" : "retained-url" }),
    });
    moduleMock(new URL("../../../../../scripts/testing/Support/readiness.mjs", entry), {
      fetchReadiness: async () => {
        readinessCalls++; if (scenario === "readiness-error") { throw new Error("readiness failure"); }
        if (scenario === "connection-retry" && readinessCalls === 1) {
          throw new Error("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
        }
        return new Response("", { status: scenario === "readiness-failure" ? 503 : 404 });
      },
    });
    moduleMock("node:child_process", { spawn: (_command, args, options) => {
      assert.equal(options.detached, true);
      assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
      assert.deepEqual(args.slice(0, 2), ["exec", "wrangler"]);
      const child = Object.assign(new EventEmitter(), { pid: 800000 + children.length, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
      children.push(child);
      queueMicrotask(() => {
        child.stdout.emit("data", "contract stdout"); child.stderr.emit("data", "contract stderr");
        if (args[2] === "d1") {
          if (scenario === "execute-timeout") { return; }
          if (scenario === "spawn-error") { child.emit("error", new Error("spawn contract failure")); }
          else { child.exitCode = scenario === "migration-failure" ? 7 : 0; child.emit("exit", child.exitCode); }
        } else if (scenario === "early-exit") { child.exitCode = 9; child.emit("exit", 9); }
      });
      if (args[2] === "dev" && scenario === "early-exit") { child.exitCode = 9; }
      if (args[2] === "dev" && scenario === "missing-pid") { child.pid = undefined; }
      return child;
    } });
    controls.push(mock.method(process, "kill", (pid, signal) => {
      const child = children.find((candidate) => candidate.pid === -pid);
      assert.ok(child); kills.push(signal);
      if (["kill-fallback", "kill-race"].includes(scenario) && signal === "SIGTERM") { return true; }
      if (scenario === "kill-race" && signal === "SIGKILL") { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); throw new Error("ESRCH"); }
      if (scenario === "kill-missing") { child.exitCode = 0; throw new Error("ESRCH"); }
      child.signalCode = signal; queueMicrotask(() => child.emit("exit", null)); return true;
    }));
    controls.push(mock.method(process, "exit", (code) => { exits.push(code); }));
    controls.push(mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
      const timer = realTimeout(callback, delay === 1100 || delay === 250 || (delay === 60000 && scenario === "execute-timeout") || (delay === 3000 && ["kill-fallback", "kill-race"].includes(scenario)) ? 1 : delay, ...args);
      timers.add(timer); return timer;
    }));
    let tick = 0;
    controls.push(mock.method(Date, "now", () => aggregationClock ? tick++ * 40000 : Date.prototype.getTime.call(new Date())));
    const requestJWKS = () => jwksHandler({}, { writeHead() {}, end() {} });
    controls.push(mock.method(globalThis, "fetch", async (url, init) => {
      if (url.includes("unknown-access-cache-probe")) {
        identityCalls++;
        if ([1, 3, 4, 6].includes(identityCalls)) { requestJWKS(); }
        return new Response(scenario === "success" ? "identity response" : null, { status: identityCalls === 4 ? 401 : 404 });
      }
      if (url.includes("__access/configured")) {
        configured++;
        if (scenario === "configured-http-failure") { return new Response(null, { status: 500 }); }
        if (scenario === "configured-primitive") { return Response.json(3); }
        if (scenario === "configured-missing") { return Response.json({}); }
        if (scenario === "configured-shape-failure") { return Response.json(null); }
        const input = JSON.parse(init.body);
        if (configured <= 2) { requestJWKS(); }
        const claims = JSON.parse(input.token);
        const rejected = input.skew < 0 || input.ttl === 0 || (claims.iss && !input.issuer) || (claims.nbf && input.skew === 0);
        return Response.json({ identity: rejected ? "rejected" : "admin-one@example.test" });
      }
      if (url.includes("/stats?")) {
        statsCalls++;
        if (scenario === "stats-failure") { return new Response("stats failed", { status: 500 }); }
        return Response.json({ items: [{ url: "retained-url", count: scenario === "wrong-count" ? 3 : scenario === "aggregation-retry" && statsCalls === 1 ? 0 : 2 }, { url: "other", count: 99 }] });
      }
      if (url.endsWith("/replay")) {
        if (scenario === "worker-exit") { children.at(-1).exitCode = 12; }
        if (scenario === "worker-signal") { children.at(-1).signalCode = "SIGTERM"; }
        return new Response(null, { status: scenario === "replay-status" ? 500 : 404 });
      }
      if (scenario === "recovery-status") { return new Response(null, { status: 503 }); }
      return Response.json(scenario === "recovery-shape" ? {} : []);
    }));
    const signalsBefore = new Map(["SIGTERM", "SIGINT"].map((signal) => [signal, process.listeners(signal)]));
    controls.push(mock.method(console, "log", () => {}));
    controls.push(mock.method(console, "error", () => {}));
    try {
      if (scenario === "readiness-timeout") {
        let tick = 0;
        controls.push(mock.method(Date, "now", () => tick++ * 70000));
      }
      if (["mkdir-error", "state-error", "remove-error", "evidence-error"].includes(scenario)) {
        await assert.rejects(import(`${entry}?contract=${serial++}`), new RegExp(scenario.split("-")[0] + " failure"));
        return;
      }
      await import(`${entry}?contract=${serial++}`);
      if (scenario === "sigterm" || scenario === "sigint") {
        const signal = scenario === "sigterm" ? "SIGTERM" : "SIGINT";
        const added = process.listeners(signal).find((listener) => !signalsBefore.get(signal).includes(listener));
        assert.ok(added); added();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(exits, [scenario === "sigterm" ? 143 : 130]);
      }
      if (scenario === "kill-fallback") { assert.ok(kills.includes("SIGKILL")); }
      if (scenario === "kill-missing") { assert.ok(kills.includes("SIGTERM")); }
      const resultFile = [...files.keys()].find((filename) => filename.endsWith("results.json"));
      assert.ok(resultFile);
      const report = JSON.parse(files.get(resultFile));
      assert.equal(report.complete, successful);
      assert.equal(process.exitCode, successful ? 0 : 1);
      assert.ok(removed.includes("/contract/state"));
      for (const filename of files.keys()) {
        if (filename.includes(".dev-test-")) { assert.ok(removed.includes(filename)); }
      }
      assert.ok(children.every((child) => !child.pid || child.exitCode !== null || child.signalCode !== null));
      assert.equal(validations, successful ? 4 : scenario === "build-error" ? 1 : 2);
      if (successful) {
        assert.equal(readinessCalls, scenario === "connection-retry" ? 2 : 1);
        assert.equal(statsCalls, scenario === "aggregation-retry" ? 2 : 1); assert.equal(closed, 3);
        assert.ok(report.results.filter((result) => result.status === "passed").length >= 18);
        const config = JSON.parse([...files.entries()].find(([filename]) => filename.includes(".dev-test-") && !filename.includes("/Dev/"))[1]);
        assert.equal(config.build, undefined);
        if (scenario === "success") { assert.equal(config.define.WASM_COVERAGE_ENDPOINT, '"http://coverage.test"'); }
      } else {
        const expected = {
          "readiness-timeout": "Wrangler readiness timed out",
          "invalid-config": "Invalid config", "migration-failure": "Wrangler command failed (7)",
          "spawn-error": "spawn contract failure", "early-exit": "Wrangler exited before ready",
          "readiness-failure": "received 503", "configured-http-failure": "Configured Access fixture failed: 500",
          "configured-shape-failure": "Missing Access identity", "stats-failure": "Stats HTTP 500: stats failed",
          "wrong-count": "received 3", "missing-csv": "CSV includes retained clicks",
          "worker-exit": "Wrangler exited during HTTP tests", "worker-signal": "Wrangler exited during HTTP tests",
          "missing-pid": "Wrangler exited before ready", "jwks-listen-error": "listen contract failure", "port-listen-error": "listen contract failure",
          "build-error": "build failure", "fixture-error": "fixture failure", "read-error": "read failure", "write-error": "write failure",
          "readiness-error": "readiness failure", "configured-primitive": "Missing Access identity", "configured-missing": "Missing Access identity",
          "aggregation-timeout": "received 0", "recovery-status": "Recovery lists failed events", "recovery-shape": "Recovery lists failed events",
          "replay-status": "Recovery rejects replay", "execute-timeout": "Wrangler command failed (null)",
        }[scenario];
        assert.ok(report.results.some((result) => result.error?.includes(expected)), JSON.stringify(report));
      }
    } finally {
      for (const [signal, listeners] of signalsBefore) {
        for (const listener of process.listeners(signal)) { if (!listeners.includes(listener)) { process.removeListener(signal, listener); } }
      }
      for (const timer of timers) { clearTimeout(timer); }
      for (const control of controls.reverse()) { if (control.restore) { control.restore(); } else { control.mock.restore(); } }
      process.exitCode = oldExit;
      if (oldEndpoint === undefined) { delete process.env.WASM_COVERAGE_ENDPOINT; } else { process.env.WASM_COVERAGE_ENDPOINT = oldEndpoint; }
    }
  });
}
