import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, mock } from "node:test";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const example = path.join(root, "examples/quickstart");

test("quickstart manifest rejects stale compiler and model outputs without overwriting proof", async () => {
  const contents = new Map();
  const bundle = path.join(example, "test-artifacts/runtime-bundle");
  let outputs = ["harness.js", "module.wasm", "build-manifest.json"];
  const file = (name, directory = false) => ({ name, isDirectory: () => directory });
  const boundary = moduleBoundary("node:fs", { namedExports: {
    readFileSync: (filename) => contents.get(filename) ?? "fixture source",
    writeFileSync: (filename, data) => { contents.set(filename, data); },
    readdirSync: (directory) => directory === bundle ? outputs.map((name) => file(name)) : directory.endsWith("/nested") ? [file("leaf.ts")] : [file("input.ts"), file("types.d.ts"), file("nested", true), ...[".dev-test-a", "result.tix", "node_modules", ".wrangler", "dist-newstyle", "dist-newstyle-runtime", "test-artifacts", ".git", ".hpc"].map((name) => file(name))],
  } });
  try {
    const api = await import(pathToFileURL(path.join(example, "test/Support/Runtime/build-manifest.mts")));
    const inputs = api.buildInputs();
    assert.ok(Object.keys(inputs).length > 20);
    assert.ok(Object.keys(inputs).every((name) => !name.includes(".dev-test-") && !name.endsWith(".tix") && !name.includes("node_modules")));
    const snapshot = path.join(example, "snapshot.json");
    api.captureBuildInputs(snapshot);
    assert.deepEqual(JSON.parse(contents.get(snapshot)), inputs);
    api.writeBuild("runtime-tests", snapshot);
    api.verifyBuild("runtime-tests");
    const source = path.join(example, "package.json");
    contents.set(source, "changed");
    assert.throws(() => api.writeBuild("runtime-tests", snapshot), /changed during compilation/);
    assert.throws(() => api.verifyBuild("runtime-tests"), /Stale/);
    contents.delete(source);
    for (const suffix of [".wasm", "-jsffi.mjs"]) {
      const artifact = path.join(example, "worker/runtime-tests" + suffix);
      contents.set(artifact, "corrupt");
      assert.throws(() => api.verifyBuild("runtime-tests"), /Stale/);
      contents.delete(artifact);
    }
    api.writeBundle(bundle, inputs);
    api.verifyBundle(bundle);
    assert.ok(!Object.hasOwn(api.bundleFiles(bundle), "build-manifest.json"));
    const saved = contents.get(path.join(bundle, "build-manifest.json"));
    assert.throws(() => api.writeBundle(bundle, {}), /changed during bundling/);
    assert.equal(contents.get(path.join(bundle, "build-manifest.json")), saved);
    for (const missing of ["harness.js", "module.wasm"]) {
      outputs = ["harness.js", "module.wasm", "build-manifest.json"].filter((name) => name !== missing);
      assert.throws(() => api.writeBundle(bundle, inputs), /missing its JavaScript or WASM/);
    }
    outputs = ["harness.js", "module.wasm", "build-manifest.json"];
    contents.set(path.join(bundle, "harness.js"), "tampered");
    assert.throws(() => api.verifyBundle(bundle), /Stale or modified model bundle/);
    contents.delete(path.join(bundle, "harness.js"));
    contents.set(path.join(bundle, "build-manifest.json"), JSON.stringify({ inputs: {}, outputs: api.bundleFiles(bundle) }));
    assert.throws(() => api.verifyBundle(bundle), /Stale or modified model bundle/);
    contents.set(path.join(bundle, "build-manifest.json"), "bad JSON");
    assert.throws(() => api.verifyBundle(bundle), SyntaxError);
  } finally { boundary.restore(); }
});
