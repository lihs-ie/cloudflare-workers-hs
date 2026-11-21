import { parseArgs } from 'node:util';
import { digest, jsonFile, runCli, writeJson } from './Support/cli.mts';
import { list, nonnegative, object, string } from './Support/validation.mts';

export function correlate(
  inventory: Record<string, unknown>,
  reports: readonly [string, unknown][],
): Record<string, unknown>[] {
  const sourceHashes = object(inventory.source_sha256);
  const observations = new Map<string, unknown[]>();
  for (const [filename, data] of reports) {
    const report = object(data);
    if (list(report.errors ?? []).length > 0) {
      throw new Error('Coverage report contains collection errors: ' + filename);
    }

    const sources = new Map(
      list(report.sources)
        .map(object)
        .map(({ path, sha256 }) => [string(path), sha256]),
    );
    for (const runtime of ['host', 'wasm']) {
      for (const module of list(report[runtime + '_hpc'] ?? []).map(object)) {
        for (const source of list(module.sources).map(string)) {
          if (
            !Object.hasOwn(sourceHashes, source) ||
            sourceHashes[source] !== sources.get(source)
          ) {
            continue;
          }

          for (const binding of list(module.bindings ?? []).map(object)) {
            const hits = nonnegative(binding.hits);
            if (hits === 0) {
              continue;
            }

            const key = JSON.stringify([source, binding.name]);
            const entries = observations.get(key) ?? [];
            entries.push({
              runtime,
              report: filename,
              module: module.module,
              moduleHash: module.hash,
              binding: binding.name,
              entryHits: hits,
            });
            observations.set(key, entries);
          }
        }
      }
    }
  }

  return list(inventory.rows)
    .map(object)
    .map((row) => {
      const entries = observations.get(JSON.stringify([row.source, row.name])) ?? [];
      return {
        ...row,
        executed_evidence: entries,
        execution_status: entries.length > 0 ? 'binding_entry_observed' : 'unverified',
      };
    });
}

runCli(import.meta.url, () => {
  const { values } = parseArgs({
    options: {
      inventory: { type: 'string' },
      coverage: { type: 'string', multiple: true },
      output: { type: 'string' },
    },
  });

  if (!values.inventory || !values.coverage || !values.output) {
    throw new Error('Expected --inventory, --coverage and --output');
  }

  const rows = correlate(
    object(jsonFile(values.inventory)),
    values.coverage.map((path) => [path, jsonFile(path)]),
  );
  const summary = {
    candidates: rows.length,
    bindingEntriesObserved: rows.filter(
      ({ execution_status }) => execution_status === 'binding_entry_observed',
    ).length,
  };
  writeJson(values.output, {
    method:
      'Match exact source SHA-256, module source mapping and positive HPC TopLevelBox entry ticks. This proves binding evaluation. No API completeness percentage is inferred.',
    inputs: Object.fromEntries(
      [values.inventory, ...values.coverage].map((path) => [path, digest(path)]),
    ),
    summary,
    rows,
  });
  console.log(JSON.stringify(summary));
  return 0;
});
