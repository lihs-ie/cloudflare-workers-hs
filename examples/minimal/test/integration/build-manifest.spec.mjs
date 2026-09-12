import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { verifyBuild } from "../Support/build-manifest.mjs";

// Mutate only the generated proof, restore exactly even if the check fails.
// The runner executes integration files with --test-concurrency=1.
test("rejects stale inputs and mismatched WASM artifacts", () => {
  const path = new URL("../../worker/build.json", import.meta.url);
  const original = readFileSync(path);
  verifyBuild();
  try {
    const stale = JSON.parse(original);
    stale.sources["src/Minimal/API.hs"] = "stale";
    writeFileSync(path, JSON.stringify(stale));
    assert.throws(verifyBuild, /WASM is stale/);
    const modified = JSON.parse(original);
    modified.artifacts["worker/minimal-worker.wasm"] = "modified";
    writeFileSync(path, JSON.stringify(modified));
    assert.throws(verifyBuild, /digest mismatch/);
  } finally {
    writeFileSync(path, original);
  }
  verifyBuild();
});
