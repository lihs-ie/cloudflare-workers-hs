import { instrumentConfig } from "../../../../scripts/testing/Support/workerd_js.mjs";
import { verifyBuild } from "./build-manifest.mjs";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export async function startDev(options = {}) {
  verifyBuild();
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const state = await mkdtemp(path.join(tmpdir(), "static-assets-worker-"));
  const artifact = path.resolve(example, "../../artifacts/testing", `static-assets-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
  await mkdir(artifact, { recursive: true });
  const logPath = path.join(artifact, "wrangler.log");
  let logs = "";
  let failure;
  const coverage = await instrumentConfig(options.config ?? path.join(example, "wrangler.jsonc"));
  const child = spawn(process.execPath, [path.resolve(example, "../quickstart/node_modules/wrangler/bin/wrangler.js"), "dev", "--config", coverage.config, "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state, "--inspector-port", "0", ...(process.env.WASM_COVERAGE_ENDPOINT ? ["--define", `WASM_COVERAGE_ENDPOINT:${JSON.stringify(process.env.WASM_COVERAGE_ENDPOINT)}`] : [])], {
    cwd: example, detached: true,
    env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", error => { failure = error; });
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  async function close() {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      const forced = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 3000);
      await exited;
      clearTimeout(forced);
    }
    await writeFile(logPath, logs);
    await coverage.close();
    await rm(state, { recursive: true, force: true });
  }
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null) throw failure ?? new Error(`Wrangler exited ${child.exitCode}\n${logs}`);
      let response;
      try {
        // Let the first WASM invocation finish. Cancelling every second can
        // strand its suspended RTS and poison subsequent invocations.
        response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
        await response.arrayBuffer();
      } catch (error) {
        // Only connection refusal is an expected pre-listen startup condition.
        // A started request that hangs/fails must remain a visible failure.
        if (error?.cause?.code !== "ECONNREFUSED") {
          throw new Error(`Wrangler readiness request failed; logs: ${logPath}`, { cause: error });
        }
      }
      if (response) {
        if (!response.ok) {
          throw new Error(`Wrangler readiness returned ${response.status}; logs: ${logPath}`);
        }
        return { base, close, logPath, getLogs: () => logs };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`Wrangler readiness timeout; logs: ${logPath}\n${logs}`);
  } catch (error) { await close(); throw error; }
}
