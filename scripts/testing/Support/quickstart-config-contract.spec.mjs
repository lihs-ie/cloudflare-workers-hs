import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, mock } from "node:test";
const example = fileURLToPath(new URL("../../../examples/quickstart/", import.meta.url));
for (const coverage of [false, true]) {
  test(`runtime Vitest configuration preserves collection contract: ${coverage}`, async () => {
    const saved = [process.env.WASM_COVERAGE, process.env.WASM_COVERAGE_ENDPOINT];
    if (coverage) { process.env.WASM_COVERAGE = "1"; process.env.WASM_COVERAGE_ENDPOINT = "http://collector.invalid"; }
    else { delete process.env.WASM_COVERAGE; delete process.env.WASM_COVERAGE_ENDPOINT; }
    let verified = 0;
    const migration = { fixture: true };
    const boundaries = [
      moduleBoundary(pathToFileURL(path.join(example, "node_modules/vitest/dist/config.js")), { namedExports: { defineConfig: (value) => value } }),
      moduleBoundary(pathToFileURL(path.join(example, "node_modules/@cloudflare/vitest-pool-workers/dist/pool/index.mjs")), { namedExports: {
        readD1Migrations: async (directory) => { assert.equal(directory, "./migrations"); return migration; },
        cloudflareTest: (config) => config,
      } }),
      moduleBoundary(pathToFileURL(path.join(example, "test/Support/Runtime/build-manifest.mts")), { namedExports: { verifyBuild: (target) => { assert.equal(target, "runtime-tests"); verified++; } } }),
    ];
    try {
      const { default: factory } = await import(`${pathToFileURL(path.join(example, "vitest.runtime.config.mts"))}?coverage=${coverage}`);
      const config = await factory();
      assert.equal(verified, 1);
      assert.equal(config.test.passWithNoTests, false);
      assert.equal(config.test.fileParallelism, false);
      assert.equal(config.test.retry, 0);
      assert.equal(config.test.env.WASM_COVERAGE_ENDPOINT, coverage ? "http://collector.invalid" : "");
      assert.deepEqual(config.test.setupFiles, coverage ? ["./test/Support/Runtime/coverage-setup.ts"] : []);
      assert.equal(config.plugins[0].miniflare.bindings.TEST_MIGRATIONS, migration);
      assert.equal(config.test.coverage.reportOnFailure, true);
      assert.equal(config.test.coverage.provider, "custom");
    } finally {
      for (const boundary of boundaries) { boundary.restore(); }
      for (const [index, name] of ["WASM_COVERAGE", "WASM_COVERAGE_ENDPOINT"].entries()) {
        if (saved[index] === undefined) { delete process.env[name]; } else { process.env[name] = saved[index]; }
      }
    }
  });
}

test("coverage inventory distinguishes execution, empty maps and missing measurements", async () => {
  const files = {
    worker: ["executed.ts", "zero.mts", "empty.mjs", "missing.ts", "types.d.ts", "generated-jsffi.mjs", "asset.txt"],
    test: ["nested"],
    "test/nested": ["case.ts"],
    scripts: [],
  };
  const reports = {
    [path.join(example, "worker/executed.ts")]: { s: { 0: 2, 1: 0 }, b: { 0: [1, 0] } },
    [path.join(example, "worker/zero.mts")]: { s: { 0: 0 }, b: {} },
    [path.join(example, "worker/empty.mjs")]: { s: {}, b: {} },
  };
  let written;
  const boundary = moduleBoundary("node:fs", { namedExports: {
    readFileSync: () => JSON.stringify(reports),
    readdirSync: (directory, options) => {
      if (!options) { return ["vitest.config.mts", "README.md"]; }
      const relative = path.relative(example, directory);
      return files[relative].map((name) => ({ name, isDirectory: () => name === "nested" }));
    },
    writeFileSync: (filename, value) => {
      assert.equal(filename, path.join(example, "test-artifacts/coverage/runtime/inventory.json"));
      written = JSON.parse(value);
    },
  } });
  try {
    await import(`${pathToFileURL(path.join(example, "test/Support/Runtime/coverage-inventory.mts"))}?inventory-contract`);
    assert.equal(written.wasmInternalCoverage, "unmeasured");
    assert.deepEqual(written.files.map(({ file, status }) => [file, status]), [
      ["test/nested/case.ts", "unmeasured"],
      ["vitest.config.mts", "unmeasured"],
      ["worker/empty.mjs", "no-instrumentation-points"],
      ["worker/executed.ts", "executed"],
      ["worker/missing.ts", "unmeasured"],
      ["worker/zero.mts", "unexecuted"],
    ]);
    assert.deepEqual(written.files.find(({ file }) => file === "worker/executed.ts").branches, { total: 2, covered: 1 });
    assert.deepEqual(written.files.find(({ file }) => file === "worker/executed.ts").statements, { total: 2, covered: 1 });
    assert.equal(written.files[0].statements, null);
  } finally {
    boundary.restore();
  }
});

for (const scenario of ["success", "snapshot-failure", "missing-endpoint", "upload-failure"]) {
  test(`coverage teardown reports ${scenario} without losing snapshot bytes`, async () => {
    let teardown;
    const uploaded = [];
    const previousEndpoint = process.env.WASM_COVERAGE_ENDPOINT;
    if (scenario === "missing-endpoint") { delete process.env.WASM_COVERAGE_ENDPOINT; }
    else { process.env.WASM_COVERAGE_ENDPOINT = "https://collector.invalid/teardown"; }
    const cloudflareURL = `data:text/javascript,export const SELF = {};#${scenario}`;
    const hooks = registerHooks({ resolve(specifier, context, next) {
      if (specifier === "cloudflare:test") { return { url: cloudflareURL, shortCircuit: true }; }
      return next(specifier, context);
    } });
    const boundaries = [
      moduleBoundary(pathToFileURL(path.join(example, "node_modules/vitest/dist/index.js")), { namedExports: { afterAll: (callback) => { teardown = callback; } } }),
      moduleBoundary(cloudflareURL, { namedExports: { SELF: { fetch: async (url) => {
        assert.equal(url, "https://coverage.invalid/__coverage");
        return new Response("exact snapshot\n", { status: scenario === "snapshot-failure" ? 503 : 200 });
      } } } }),
    ];
    const fetchMock = mock.method(globalThis, "fetch", async (url, options) => {
      uploaded.push([url, options]);
      return new Response("saved", { status: scenario === "upload-failure" ? 500 : 200 });
    });
    try {
      await import(`${pathToFileURL(path.join(example, "test/Support/Runtime/coverage-setup.ts"))}?teardown=${scenario}`);
      assert.equal(typeof teardown, "function");
      if (scenario === "success") {
        await teardown();
        assert.deepEqual(uploaded, [["https://collector.invalid/teardown", { method: "POST", body: "exact snapshot\n" }]]);
      } else {
        await assert.rejects(teardown(), scenario === "snapshot-failure" ? /snapshot failed: 503/ : scenario === "missing-endpoint" ? /wasm-coverage.py/ : /collection failed: 500/);
        assert.equal(uploaded.length, scenario === "upload-failure" ? 1 : 0);
      }
    } finally {
      fetchMock.mock.restore();
      for (const boundary of boundaries) { boundary.restore(); }
      hooks.deregister();
      if (previousEndpoint === undefined) { delete process.env.WASM_COVERAGE_ENDPOINT; }
      else { process.env.WASM_COVERAGE_ENDPOINT = previousEndpoint; }
    }
  });
}
