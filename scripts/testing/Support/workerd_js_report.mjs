import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createCoverageMap } = createRequire(require.resolve("istanbul-lib-source-maps"))("istanbul-lib-coverage");
const { createSourceMapStore } = require("istanbul-lib-source-maps");
const directory = process.argv[2];
const maps = new Map();
const coverage = createCoverageMap({});
function accept(entry) {
  const signature = JSON.stringify([entry.statementMap, entry.branchMap, entry.fnMap, entry.inputSourceMap]);
  if (maps.has(entry.path) && maps.get(entry.path) !== signature) { throw new Error(`Instrumentation mismatch: ${entry.path}`); }
  maps.set(entry.path, signature);
  coverage.addFileCoverage(entry);
}
for (const bundle of await readdir(path.join(directory, "bundles"))) {
  const manifest = JSON.parse(await readFile(path.join(directory, "bundles", bundle, "manifest.json"), "utf8"));
  for (const { coverage: entry } of Object.values(manifest)) { accept(entry); }
}
for (const filename of await readdir(path.join(directory, "snapshots"))) {
  const record = JSON.parse(await readFile(path.join(directory, "snapshots", filename), "utf8"));
  for (const entry of Object.values(record.coverage)) { accept(entry); }
}
const remapped = await createSourceMapStore().transformCoverage(coverage);
await writeFile(path.join(directory, "coverage-final.json"), JSON.stringify(remapped.toJSON()));
