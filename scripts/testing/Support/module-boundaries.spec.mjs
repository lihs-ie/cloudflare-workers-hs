import { moduleBoundary } from "./module-boundaries.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// This uses native V8 ranges rather than a coverage percentage: query-dependent
// loader rewriting previously shifted offsets beyond the authored source.
test("dependency substitutions preserve authored V8 offsets across query lengths", () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "module-boundaries-")));
  try {
    const dependency = path.join(directory, "dependency.mjs");
    const consumer = path.join(directory, "consumer.mjs");
    const source = 'import value, { marker } from "./dependency.mjs";\nexport const result = [value, marker];\n';
    writeFileSync(dependency, 'export default "original"; export const marker = 0;\n');
    writeFileSync(consumer, source);
    const script = path.join(directory, "run.mjs");
    writeFileSync(script, `
      import assert from "node:assert/strict";
      import { moduleBoundary } from ${JSON.stringify(new URL("./module-boundaries.mjs", import.meta.url).href)};
      const first = moduleBoundary(${JSON.stringify(pathToFileURL(dependency).href)}, { defaultExport: "first", namedExports: { marker: 1 } });
      assert.deepEqual((await import(${JSON.stringify(pathToFileURL(consumer).href + "?short")})).result, ["first", 1]);
      first.restore();
      const second = moduleBoundary(${JSON.stringify(pathToFileURL(dependency).href)}, { defaultExport: "second", namedExports: { marker: 2 } });
      assert.deepEqual((await import(${JSON.stringify(pathToFileURL(consumer).href + "?much-longer-query")})).result, ["second", 2]);
      second.restore();
      assert.deepEqual((await import(${JSON.stringify(pathToFileURL(consumer).href + "?restored")})).result, ["original", 0]);
    `);
    const coverage = path.join(directory, "coverage");
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, NODE_V8_COVERAGE: coverage } });
    assert.equal(result.status, 0, result.stderr);
    const scripts = readdirSync(coverage).flatMap((filename) => JSON.parse(readFileSync(path.join(coverage, filename), "utf8")).result).filter(({ url }) => url.startsWith(pathToFileURL(consumer).href));
    assert.equal(scripts.length, 3);
    for (const script of scripts) {
      assert.equal(script.functions[0].ranges[0].startOffset, 0);
      assert.equal(script.functions[0].ranges[0].endOffset, source.length);
      assert.equal(script.functions[0].ranges[0].count, 1);
    }
    assert.equal(readFileSync(consumer, "utf8"), source);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("default and named substitutions restore the original dependency", async () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "module-boundary-values-")));
  const dependency = path.join(directory, "dependency.mjs");
  const url = pathToFileURL(dependency).href;
  writeFileSync(dependency, 'export default "original"; export const marker = "original marker";\n');
  const replacement = { value: "substituted" };
  const first = moduleBoundary(url, { defaultExport: replacement });
  try {
    const substituted = await import(url);
    assert.equal(substituted.default, replacement);
    assert.deepEqual(Object.keys(substituted), ["default"]);
  } finally {
    first.restore();
  }
  const second = moduleBoundary(url, { namedExports: { marker: 42 } });
  try {
    const substituted = await import(url);
    assert.equal(substituted.marker, 42);
    assert.equal(Object.hasOwn(substituted, "default"), false);
  } finally {
    second.restore();
  }
  const empty = moduleBoundary(url);
  try {
    assert.deepEqual(Object.keys(await import(url)), []);
  } finally {
    empty.restore();
  }
  try {
    const restored = await import(url);
    assert.equal(restored.default, "original");
    assert.equal(restored.marker, "original marker");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
