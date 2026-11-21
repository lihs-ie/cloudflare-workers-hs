import { coverageData } from './coverage-schema.mts';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import coverageLibrary from 'istanbul-lib-coverage';
const { createCoverageMap } = coverageLibrary;
import sourceMapLibrary from 'istanbul-lib-source-maps';
const { createSourceMapStore } = sourceMapLibrary;
import { manifestSchema, snapshotSchema, jsonValue } from './coverage-schema.mts';
import type { CoverageEntry } from './coverage-schema.mts';
const directory = process.argv[2];
const maps = new Map();
const coverage = createCoverageMap({});
function accept(entry: CoverageEntry): void {
  const signature = JSON.stringify([
    entry.statementMap,
    entry.branchMap,
    entry.fnMap,
    entry.inputSourceMap,
  ]);

  if (maps.has(entry.path) && maps.get(entry.path) !== signature) {
    throw new Error(`Instrumentation mismatch: ${entry.path}`);
  }

  maps.set(entry.path, signature);
  coverage.addFileCoverage(coverageData(entry));
}
for (const bundle of await readdir(path.join(directory, 'bundles'))) {
  const manifest = manifestSchema.parse(
    jsonValue(await readFile(path.join(directory, 'bundles', bundle, 'manifest.json'), 'utf8')),
  );
  for (const { coverage: entry } of Object.values(manifest)) {
    accept(entry);
  }
}
for (const filename of await readdir(path.join(directory, 'snapshots'))) {
  const record = snapshotSchema.parse(
    jsonValue(await readFile(path.join(directory, 'snapshots', filename), 'utf8')),
  );
  for (const entry of Object.values(record.coverage)) {
    accept(entry);
  }
}
const remapped = await createSourceMapStore().transformCoverage(coverage);
await writeFile(path.join(directory, 'coverage-final.json'), JSON.stringify(remapped.toJSON()));
