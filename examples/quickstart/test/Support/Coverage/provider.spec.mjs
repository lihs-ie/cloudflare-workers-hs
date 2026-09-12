import assert from "node:assert/strict";
import { test } from "node:test";
import module, { includeTestFiles } from "./provider.mjs";

test("includes authored specs while retaining explicit and dependency exclusions", async () => {
  const options = { exclude: ["**/*.spec.ts", "**/node_modules/**", "explicit.ts", "config.mts"] };
  const context = { config: { include: ["**/*.spec.ts"] } };
  let initialized;
  const original = {
    async initialize(input) { initialized = input; },
    resolveOptions() { return options; },
  };
  assert.equal(includeTestFiles(original), original);
  await original.initialize(context);
  assert.equal(initialized, context);
  assert.deepEqual(options.exclude, ["**/node_modules/**", "explicit.ts", "config.mts"]);
});

test("returns the existing Istanbul provider through the custom module contract", async () => {
  const provider = await module.getProvider();
  assert.equal(provider.name, "istanbul");
  assert.equal(typeof module.takeCoverage, "function");
  assert.equal(typeof module.startCoverage, "function");
});
