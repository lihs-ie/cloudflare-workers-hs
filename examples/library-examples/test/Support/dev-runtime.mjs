import { fetchReadiness } from "../../../../scripts/testing/Support/readiness.mjs";
import { instrumentConfig } from "../../../../scripts/testing/Support/workerd_js.mjs";
import { startClientHttpFixture } from "./client-http-fixture.mjs";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, open, readFile, writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuild } from "./build-manifest.mjs";
import { startSocketFixtures, certificate } from "./socket-fixtures.mjs";
import net from "node:net";
export const directory = fileURLToPath(new URL("../../", import.meta.url));
export async function startRuntime() {
  verifyBuild();
  let state, log, fixtures, clientHttpFixture, probe, dev, spawnError, base;
  const configs = [];
  const coverageConfigs = [];
  const evidence = resolve(directory, "../../artifacts/testing", `library-runtime-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${process.pid}`);
  let closing;
  const close = (verify = true) => {
    if (closing) return closing;
    closing = (async () => {
      const errors = [];
      const attempt = async (action) => { try { await action(); } catch (error) { errors.push(error); } };
      if (verify && process.env.WASM_COVERAGE_ENDPOINT && base) {
        await attempt(async () => {
          const response = await fetch(`${base}/__fixture/coverage`, { signal: AbortSignal.timeout(10000) });
          if (!response.ok) {
            throw new Error(`WASM coverage snapshot failed: ${response.status}`);
          }
          const snapshots = await response.json();
          if (!Array.isArray(snapshots) || snapshots.length !== 3 || snapshots.some(value => typeof value !== "string")) {
            throw new Error("Expected three reactor coverage snapshots");
          }
          for (const body of snapshots) {
            const saved = await fetch(process.env.WASM_COVERAGE_ENDPOINT, { method: "POST", body, signal: AbortSignal.timeout(10000) });
            if (!saved.ok) {
              throw new Error(`WASM coverage upload failed: ${saved.status}`);
            }
          }
        });
      }
      await attempt(async () => {
        if (!dev?.pid) return;
        const running = dev.exitCode === null && dev.signalCode === null;
        const exited = running ? new Promise(resolve => dev.once("exit", resolve)) : Promise.resolve();
        try { process.kill(-dev.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        const killer = setTimeout(() => { try { process.kill(-dev.pid, "SIGKILL"); } catch {} }, 3000);
        await exited;
        clearTimeout(killer);
      });
      if (probe?.listening) await attempt(() => new Promise(resolve => probe.close(resolve)));
      if (fixtures) await attempt(() => fixtures.close());
      if (clientHttpFixture) await attempt(() => clientHttpFixture.close());
      if (log) {
        await attempt(() => log.close());
        await attempt(async () => {
          await mkdir(evidence, { recursive: true });
          await copyFile(join(state, "wrangler.log"), join(evidence, "wrangler.log"));
        });
      }
      for (const coverage of coverageConfigs) { await attempt(() => coverage.close()); }
      for (const config of configs) await attempt(() => rm(config, { force: true }));
      if (state) await attempt(() => rm(state, { recursive: true, force: true }));
      if (verify) await attempt(async () => verifyBuild());
      if (errors.length) throw new AggregateError(errors, "Runtime cleanup failed");
    })();
    return closing;
  };
  async function writeConfig(base, label, transform) {
    const configPath = join(directory, `.dev-test-${label}-${process.pid}-${Date.now()}.json`);
    configs.push(configPath);
    const config = JSON.parse(await readFile(join(directory, base), "utf8"));
    transform(config);
    await writeFile(configPath, JSON.stringify(config));
    const coverage = await instrumentConfig(configPath);
    coverageConfigs.push(coverage);
    return coverage.config;
  }
  try {
    state = await mkdtemp(join(tmpdir(), "library-examples-"));
    log = await open(join(state, "wrangler.log"), "w");
    fixtures = await startSocketFixtures();
    clientHttpFixture = await startClientHttpFixture();
    const primaryPath = await writeConfig("test/Support/wrangler.jsonc", "primary", config => {
      config.main = "test/Support/entry.ts";
      config.vars = { ...config.vars, ...fixtures.variables, CLIENT_ORIGIN: clientHttpFixture.origin };
    });
    const guidePath = await writeConfig("wrangler.guide.jsonc", "guide", config => {
      config.main = "test/Support/entry.ts";
      config.vars = { ...config.vars, EXAMPLE_MODE: "fixture", ...fixtures.variables, CLIENT_ORIGIN: clientHttpFixture.origin };
    });
    const tailPath = await writeConfig("wrangler.tail.jsonc", "tail", config => { config.main = "test/Support/tail-entry.ts"; });
    const jobsPath = await writeConfig("wrangler.jobs.jsonc", "jobs", config => {});
    const migration = spawnSync("../quickstart/node_modules/.bin/wrangler", ["d1", "migrations", "apply", "library-jobs", "--local", "--config", primaryPath, "--persist-to", state], { cwd: directory, encoding: "utf8", env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } });
    if (migration.status !== 0) { throw new Error(`D1 migration failed: ${migration.stderr} ${migration.stdout}`); }
    probe = net.createServer();
    await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    dev = spawn("../quickstart/node_modules/.bin/wrangler", ["dev", "--local", "--config", primaryPath, "--config", guidePath, "--config", tailPath, "--config", jobsPath, "--port", String(port), "--inspector-port", "0", "--persist-to", state], { cwd: directory, detached: true, stdio: ["ignore", log.fd, log.fd], env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, WRANGLER_SEND_METRICS: "false", CI: "true" } });
    dev.on("error", error => { spawnError = error; });
    base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (dev.exitCode !== null || dev.signalCode !== null) throw new Error(`wrangler exited ${dev.exitCode}/${dev.signalCode}; ${evidence}/wrangler.log`);
      try {
        const response = await fetchReadiness(`${base}/health`, deadline);
        if (!response.ok) { throw new Error(`Wrangler readiness returned ${response.status}; ${evidence}/wrangler.log`); }
        return { base, close: () => close(), state, evidence, clientHttpFixture };
      } catch (error) {
        if (error?.cause?.code !== "ECONNREFUSED") { throw error; }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`wrangler readiness timeout; ${evidence}/wrangler.log`);
  } catch (error) {
    try { await close(false); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Runtime startup and cleanup failed"); }
    throw error;
  }
}
