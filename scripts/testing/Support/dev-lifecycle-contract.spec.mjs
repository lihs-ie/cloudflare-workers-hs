import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as realSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test, mock } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let serial = 0;
for (const example of ["minimal", "realtime", "static-assets"]) {
  for (const scenario of ["healthy", "unhealthy", "early-exit", "spawn-error", "timeout", "fetch-error", "kill-error", "kill-forced", "kill-forced-race"]) {
    test(`${example}: ${scenario} closes process and releases state`, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dev-lifecycle-contract-"));
      const previousEndpoint = process.env.WASM_COVERAGE_ENDPOINT;
      const previousCoverageDirectory = process.env.WORKERD_JS_COVERAGE_DIRECTORY;
      if (scenario === "healthy") { process.env.WASM_COVERAGE_ENDPOINT = "http://127.0.0.1:1/contract"; } else { delete process.env.WASM_COVERAGE_ENDPOINT; }
      if (scenario === "kill-forced") { delete process.env.WORKERD_JS_COVERAGE_DIRECTORY; } else { process.env.WORKERD_JS_COVERAGE_DIRECTORY = directory; }
      const processes = [];
      const states = [];
      let coverageClosed = 0;
      let validated = 0;
      const boundaries = [
        moduleBoundary(pathToFileURL(path.join(root, "examples", example, "test/Support/build-manifest.mjs")), { namedExports: { verifyBuild: () => { validated++; } } }),
        moduleBoundary(pathToFileURL(path.join(root, "scripts/testing/Support/workerd_js.mjs")), { namedExports: { instrumentConfig: async (config) => ({ config, close: async () => { coverageClosed++; } }) } }),
        moduleBoundary("node:fs/promises", { namedExports: {
          mkdir: async () => {},
          mkdtemp: async () => { const state = await fs.mkdtemp(path.join(directory, "state-")); states.push(state); return state; },
          writeFile: (filename, contents) => fs.writeFile(path.join(directory, path.basename(filename)), contents),
          rm: fs.rm,
        } }),
        moduleBoundary("node:child_process", { namedExports: { spawn: (executable, args, options) => {
          assert.equal(executable, process.execPath);
          assert.equal(options.detached, true);
          assert.equal(options.env.WRANGLER_SEND_METRICS, "false");
          assert.equal(args.includes("--define"), scenario === "healthy");
          if (scenario.startsWith("kill-")) {
            const child = new EventEmitter();
            child.pid = 123456789; child.exitCode = null; child.signalCode = null;
            child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            processes.push(child);
            queueMicrotask(() => child.stdout.emit("data", "ready"));
            return child;
          }
          const port = Number(args[args.indexOf("--port") + 1]);
          const code = scenario === "early-exit" ? "process.stderr.write('early failure');process.exit(23)" : `
            const http = require('node:http');
            const server = http.createServer((request,response)=>{response.writeHead(${scenario === "unhealthy" ? 503 : 200});response.end('ok')});
            server.listen(${port},'127.0.0.1',()=>{process.stdout.write('ready');process.stderr.write('diagnostic')});
            process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
          `;
          const child = realSpawn(scenario === "spawn-error" ? path.join(directory, "missing-executable") : process.execPath, ["-e", code], options);
          processes.push(child);
          return child;
        } } }),
      ];
      let clock;
      let fetchMock;
      let killMock;
      let timerMock;
      if (scenario.startsWith("kill-")) {
        fetchMock = mock.method(globalThis, "fetch", async () => new Response("ok"));
        const timer = globalThis.setTimeout;
        // These modeled children only schedule the shutdown escalation deadline.
        timerMock = mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
          assert.equal(delay, 3000);
          return timer(callback, 1, ...args);
        });
        killMock = mock.method(process, "kill", (pid, signal) => {
          if (scenario !== "kill-error" && signal === "SIGTERM") { return true; }
          for (const child of processes) { child.signalCode = "SIGTERM"; queueMicrotask(() => child.emit("exit", null)); }
          if (scenario !== "kill-forced") { throw new Error("signal denied while process exits independently"); }
          return true;
        });
      }
      if (scenario === "fetch-error") { fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("fetch contract failure"); }); }
      try {
        const api = await import(`${pathToFileURL(path.join(root, "examples", example, "test/Support/dev.mjs"))}?contract=${serial++}`);
        if (scenario === "timeout") {
          let tick = 0;
          clock = mock.method(Date, "now", () => tick++ * 70000);
        }
        if ((scenario === "healthy" || scenario.startsWith("kill-"))) {
          const running = await api.startDev();
          assert.equal((await fetch(`${running.base}/health`)).status, 200);
          if (running.logs) { assert.match(running.logs(), /ready/); }
          if (running.getLogs) { assert.match(running.getLogs(), /ready/); }
          await running.close();
          assert.match(await fs.readFile(path.join(directory, "wrangler.log"), "utf8"), /ready/);
        } else {
          await assert.rejects(api.startDev(), scenario === "unhealthy" ? /503/ : scenario === "early-exit" ? /23/ : scenario === "timeout" ? /timeout/ : scenario === "fetch-error" ? /fetch contract failure|readiness request failed/ : /ENOENT/);
        }
        assert.equal(validated, 1);
        assert.equal(coverageClosed, 1);
        for (const child of processes) {
          assert.ok(child.pid === undefined || child.exitCode !== null || child.signalCode !== null);
        }
        for (const state of states) {
          await assert.rejects(fs.access(state), /ENOENT/);
        }
      } finally {
        timerMock?.mock.restore();
        killMock?.mock.restore();
        fetchMock?.mock.restore();
        clock?.mock.restore();
        for (const child of processes) {
          if (child.pid && child.exitCode === null && child.signalCode === null) {
            process.kill(-child.pid, "SIGKILL");
          }
        }
        for (const boundary of boundaries) {
          boundary.restore();
        }
        if (previousEndpoint === undefined) { delete process.env.WASM_COVERAGE_ENDPOINT; } else { process.env.WASM_COVERAGE_ENDPOINT = previousEndpoint; }
        if (previousCoverageDirectory === undefined) { delete process.env.WORKERD_JS_COVERAGE_DIRECTORY; } else { process.env.WORKERD_JS_COVERAGE_DIRECTORY = previousCoverageDirectory; }
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
}
