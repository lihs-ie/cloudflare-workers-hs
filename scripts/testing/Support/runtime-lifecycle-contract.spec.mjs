import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { spawn as realSpawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, mock } from "node:test";
const root = fileURLToPath(new URL("../../../", import.meta.url));
for (const example of ["workflows", "library-examples"]) {
  for (const scenario of ["healthy", "migration-failure", "unhealthy", "early-exit", "spawn-error", "cleanup-error", "coverage-success", "coverage-http-error", "coverage-shape-error", "coverage-upload-error", "compatibility-fallback", "startup-cleanup-error", "timeout", "state-failure", "log-close-error", "log-copy-error", "kill-error", "probe-close-error", "kill-forced", "kill-forced-race", "state-create-error", "log-open-error", "migration-timeout", "port-error"]) {
    if ((scenario === "port-error" && example !== "workflows") || (scenario === "migration-timeout" && example !== "workflows") || (scenario === "probe-close-error" && example !== "library-examples") || (scenario === "state-failure" && example !== "workflows") || (scenario === "compatibility-fallback" && example !== "workflows") || (example === "workflows" && ["coverage-http-error", "coverage-shape-error", "coverage-upload-error"].includes(scenario))) { continue; }
    test(`${example} runtime: ${scenario} preserves cleanup and diagnostic contract`, async () => {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-contract-"));
      const states = [];
      const processes = [];
      const closures = [];
      const env = [process.env.WASM_COVERAGE_ENDPOINT, process.env.WORKERD_JS_COVERAGE_ENDPOINT];
      delete process.env.WASM_COVERAGE_ENDPOINT;
      delete process.env.WORKERD_JS_COVERAGE_ENDPOINT;
      if (scenario.startsWith("coverage-")) {
        process.env.WASM_COVERAGE_ENDPOINT = "https://collector.invalid/snapshot";
        process.env.WORKERD_JS_COVERAGE_ENDPOINT = "https://collector.invalid/js";
      }
      const uploads = [];
      let clock;
      let killMock;
      let timerMock;
      let netMock;
      if (scenario.startsWith("kill-") || scenario === "migration-timeout") {
        const timer = globalThis.setTimeout;
        // Modeled child processes schedule migration or shutdown deadlines only.
        timerMock = mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
          assert.ok([3000, 60000].includes(delay), `Unexpected modeled child deadline: ${delay}`);
          return timer(callback, 1, ...args);
        });
        killMock = mock.method(process, "kill", (pid, signal) => {
          if (scenario.startsWith("kill-forced") && signal === "SIGTERM") { return true; }
          for (const child of processes) { child.signalCode = "SIGTERM"; queueMicrotask(() => child.emit("exit", null)); }
          if (["kill-error", "kill-forced-race"].includes(scenario)) { const error = new Error("kill denied"); error.code = "EPERM"; throw error; }
          return true;
        });
      }
      if (["probe-close-error", "port-error"].includes(scenario)) {
        const createServer = net.createServer;
        netMock = mock.method(net, "createServer", (...args) => {
          const server = createServer(...args);
          if (scenario === "port-error") { server.listen = () => { queueMicrotask(() => server.emit("error", new Error("port reservation failed"))); return server; }; return server; }
          const close = server.close.bind(server);
          let first = true;
          server.close = (...parameters) => { if (first) { first = false; throw new Error("probe close failed"); } return close(...parameters); };
          return server;
        });
      }
      const originalFetch = globalThis.fetch;
      const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
        if (url === "https://collector.invalid/snapshot") {
          uploads.push(options.body);
          return new Response("saved", { status: scenario === "coverage-upload-error" ? 500 : 200 });
        }
        if (String(url).endsWith("/__fixture/coverage")) {
          return Response.json(scenario === "coverage-shape-error" ? ["one"] : ["first", "second", "third"], { status: scenario === "coverage-http-error" ? 503 : 200 });
        }
        if (scenario.startsWith("kill-")) { return new Response("ok"); }
        return originalFetch(url, options);
      });
      const map = (filename) => filename.startsWith(temp) ? filename : path.join(temp, path.basename(filename));
      const boundaries = [
        moduleBoundary(pathToFileURL(path.join(root, "examples", example, "test/Support/build-manifest.mjs")), { namedExports: { verifyBuild: () => {} } }),
        moduleBoundary(pathToFileURL(path.join(root, "scripts/testing/Support/workerd_js.mjs")), { namedExports: { instrumentConfig: async (config) => ({ config, close: async () => { closures.push("coverage"); if (["cleanup-error", "startup-cleanup-error"].includes(scenario)) { throw new Error("coverage close failed"); } } }) } }),
        moduleBoundary("node:fs/promises", { namedExports: {
          mkdtemp: async () => { if (scenario === "state-create-error") { throw new Error("state creation failed"); } const state = await fs.mkdtemp(path.join(temp, "state-")); states.push(state); return state; },
          open: async (...args) => { if (scenario === "log-open-error") { throw new Error("log open failed"); } const file = await fs.open(...args); return scenario === "log-close-error" ? { fd: file.fd, close: async () => { await file.close(); throw new Error("log close denied"); } } : file; },
          readFile: (filename, options) => filename.endsWith(".jsonc") ? Promise.resolve("{}") : fs.readFile(map(filename), options),
          writeFile: (filename, contents) => fs.writeFile(map(filename), contents),
          mkdir: async () => {},
          copyFile: (source, destination) => { if (scenario === "log-copy-error") { throw new Error("copy denied"); } return fs.copyFile(map(source), path.join(temp, "saved-" + path.basename(destination))); },
          rm: (filename, options) => fs.rm(map(filename), options),
        } }),
        moduleBoundary("node:child_process", { namedExports: {
          spawnSync: () => ({ status: scenario === "migration-failure" ? 7 : 0, stderr: "migration stderr", stdout: "migration stdout" }),
          spawn: (command, args, options) => {
            const migration = args[0] === "d1";
            if (scenario.startsWith("kill-") || scenario === "migration-timeout") {
              const child = new EventEmitter();
              child.pid = 123456789; child.exitCode = null; child.signalCode = null;
              processes.push(child);
              if (migration && scenario !== "migration-timeout") { queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0); }); }
              return child;
            }
            const port = Number(args[args.indexOf("--port") + 1]);
            const code = migration ? `process.exit(${scenario === "migration-failure" ? 7 : 0})` : scenario === "early-exit" ? "process.exit(23)" : `
              const http=require('node:http');
              if (${scenario === 'compatibility-fallback'}) { process.stderr.write('falling back to compatibility date'); }
              const server=http.createServer((req,res)=>{res.writeHead(${["unhealthy", "startup-cleanup-error", "state-failure"].includes(scenario) ? 503 : 200});res.end('ok')});
              server.listen(${port},'127.0.0.1');
              process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
            `;
            const child = realSpawn(!migration && scenario === "spawn-error" ? path.join(temp, "missing-command") : process.execPath, ["-e", code], options);
            processes.push(child);
            return child;
          },
        } }),
      ];
      if (example === "library-examples") {
        boundaries.push(moduleBoundary(pathToFileURL(path.join(root, "examples/library-examples/test/Support/socket-fixtures.mjs")), { namedExports: {
          certificate: "unused-certificate", startSocketFixtures: async () => ({ variables: {}, close: async () => { closures.push("socket"); } }),
        } }));
        boundaries.push(moduleBoundary(pathToFileURL(path.join(root, "examples/library-examples/test/Support/client-http-fixture.mjs")), { namedExports: {
          startClientHttpFixture: async () => ({ origin: "http://fixture.invalid", close: async () => { closures.push("http"); } }),
        } }));
      }
      try {
        const api = await import(`${pathToFileURL(path.join(root, "examples", example, "test/Support/dev-runtime.mjs"))}?scenario=${scenario}`);
        if (scenario === "timeout") { let tick = 0; clock = mock.method(example === "workflows" ? performance : Date, "now", () => tick++ * 100000); }
        const options = {};
        if (scenario === "state-failure") { options.state = await fs.mkdtemp(path.join(temp, "retained-")); }
        if (["healthy", "cleanup-error", "log-close-error", "log-copy-error", "kill-error", "kill-forced", "kill-forced-race"].includes(scenario) || scenario.startsWith("coverage-")) {
          const runtime = await api.startRuntime();
          if (["cleanup-error", "log-close-error", "log-copy-error", "kill-error"].includes(scenario) || (example === "library-examples" && ["coverage-http-error", "coverage-shape-error", "coverage-upload-error"].includes(scenario))) {
            await assert.rejects(runtime.close(), AggregateError);
            if (runtime.dispose) { await assert.rejects(runtime.dispose(), AggregateError); }
          } else {
            await runtime.close();
            await runtime.close();
            if (runtime.dispose) {
              await fs.access(runtime.state);
              await runtime.dispose();
              await runtime.dispose();
            }
          }
        } else {
          await assert.rejects(api.startRuntime(options), scenario === "port-error" ? /port reservation failed/ : scenario === "state-create-error" ? /state creation failed/ : scenario === "log-open-error" ? /log open failed/ : scenario === "migration-timeout" ? /migration timed out/ : scenario === "probe-close-error" ? /probe close failed/ : scenario === "timeout" ? /timeout/ : scenario === "state-failure" ? /503/ : scenario === "migration-failure" ? /migration failed/i : scenario === "unhealthy" ? /503/ : scenario === "early-exit" ? /23/ : scenario === "compatibility-fallback" ? /compatibility fallback/ : scenario === "startup-cleanup-error" ? /startup and cleanup failed/ : /ENOENT/);
        }
        if (example === "library-examples" && scenario === "coverage-success") { assert.deepEqual(uploads, ["first", "second", "third"]); }
        for (const state of states) { await assert.rejects(fs.access(state), /ENOENT/); }
        if (scenario === "state-failure") { await fs.access(options.state); }
        for (const child of processes) { assert.ok(!child.pid || child.exitCode !== null || child.signalCode !== null); }
        if (example === "library-examples" && !["state-create-error", "log-open-error"].includes(scenario)) {
          assert.equal(closures.filter((value) => value === "socket").length, 1);
          assert.equal(closures.filter((value) => value === "http").length, 1);
        }
      } finally {
        timerMock?.mock.restore();
        killMock?.mock.restore();
        netMock?.mock.restore();
        clock?.mock.restore();
        fetchMock.mock.restore();
        for (const child of processes) {
          if (child.pid && child.exitCode === null && child.signalCode === null) { process.kill(-child.pid, "SIGKILL"); }
        }
        for (const boundary of boundaries) { boundary.restore(); }
        for (const [index, name] of ["WASM_COVERAGE_ENDPOINT", "WORKERD_JS_COVERAGE_ENDPOINT"].entries()) {
          if (env[index] === undefined) { delete process.env[name]; } else { process.env[name] = env[index]; }
        }
        await fs.rm(temp, { recursive: true, force: true });
      }
    });
  }
}
