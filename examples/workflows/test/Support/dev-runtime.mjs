import { fetchReadiness } from "../../../../scripts/testing/Support/readiness.mjs";
import { instrumentConfig } from "../../../../scripts/testing/Support/workerd_js.mjs";
import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, mkdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { verifyBuild } from "./build-manifest.mjs";
export const directory = fileURLToPath(new URL("../../", import.meta.url));
async function reservePort() {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    return server.address().port;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}
async function stop(child) {
  if (!child.pid) return;
  const running = child.exitCode === null && child.signalCode === null;
  const exited = running ? new Promise(resolve => child.once("exit", resolve)) : Promise.resolve();
  try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const killer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
  try { await exited; } finally { clearTimeout(killer); }
}
export async function startRuntime(options = {}) {
  verifyBuild();
  let state = options.state, log, logPath;
  const children = [];
  let coverage;
  const evidence = resolve(directory, "../../artifacts/testing", `workflow-runtime-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`);
  const environment = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" };
  const wrangler = "../quickstart/node_modules/.bin/wrangler";
  let closing, disposing;
  // close intentionally preserves the persisted state for process-restart tests.
  const close = () => closing ??= (async () => {
    const failures = [];
    for (const child of children) { try { await stop(child); } catch (error) { failures.push(error); } }
    if (log) {
      try { await log.close(); } catch (error) { failures.push(error); }
      try { await mkdir(evidence, { recursive: true }); await copyFile(logPath, join(evidence, "wrangler.log")); } catch (error) { failures.push(error); }
    }
    if (coverage) { try { await coverage.close(); } catch (error) { failures.push(error); } }
    if (failures.length) throw new AggregateError(failures, "Workflow runtime cleanup failed");
  })();
  const dispose = () => disposing ??= (async () => {
    try { await close(); } finally { if (state) await rm(state, { recursive: true, force: true }); }
  })();
  function launch(args) {
    if (args[0] === "dev" && process.env.WASM_COVERAGE_ENDPOINT) {
      args = [...args, "--define", `WASM_COVERAGE_ENDPOINT:${JSON.stringify(process.env.WASM_COVERAGE_ENDPOINT)}`];
    }
    const child = spawn(wrangler, args, { cwd: directory, detached: true, stdio: ["ignore", log.fd, log.fd], env: environment });
    const record = { child, error: undefined };
    child.on("error", error => { record.error = error; });
    children.push(child);
    return record;
  }
  try {
    state ??= await mkdtemp(join(tmpdir(), "haskell-workflows-"));
    const port = options.port ?? await reservePort();
    logPath = join(state, "wrangler.log");
    log = await open(logPath, "a");
    if (!options.state) {
      const { child } = launch(["d1", "execute", "AUDIT", "--local", "--config", "wrangler.jsonc", "--persist-to", state, "--file", "migrations/0001_audit.sql"]);
      let timer;
      const code = await new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
        timer = setTimeout(() => reject(new Error(`migration timed out; ${evidence}/wrangler.log`)), 60000);
      }).finally(() => clearTimeout(timer));
      if (code !== 0) throw new Error(`migration failed ${code}; ${evidence}/wrangler.log`);
    }
    coverage = await instrumentConfig(join(directory, "wrangler.jsonc"), "test/Support/entry.ts");
    const dev = launch(["dev", ...(process.env.WORKERD_JS_COVERAGE_ENDPOINT ? [] : ["test/Support/entry.ts"]), "--local", "--config", coverage.config, "--port", String(port), "--inspector-port", "0", "--persist-to", state]);
    const base = `http://127.0.0.1:${port}`;
    const deadline = performance.now() + 90000;
    while (performance.now() < deadline) {
      if (dev.error) throw dev.error;
      if (dev.child.exitCode !== null || dev.child.signalCode !== null) throw new Error(`wrangler exited ${dev.child.exitCode}/${dev.child.signalCode}; ${evidence}/wrangler.log`);
      try {
        const response = await fetchReadiness(`${base}/health`, deadline, { now: () => performance.now() });
        if (!response.ok) { throw new Error(`Wrangler readiness returned ${response.status}; ${logPath}`); }
        const logs = await readFile(logPath, "utf8");
        if (/falling back to|latest compatibility date supported/i.test(logs)) throw new Error(`compatibility fallback detected; ${evidence}/wrangler.log`);
        return { base, close, dispose, state, port, logPath, evidence };
      } catch (error) { if (error?.cause?.code !== "ECONNREFUSED") { throw error; } }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`wrangler readiness timeout; ${evidence}/wrangler.log`);
  } catch (error) {
    try { await (options.state ? close() : dispose()); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Workflow startup and cleanup failed"); }
    throw error;
  }
}
