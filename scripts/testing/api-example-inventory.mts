import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repositoryRoot, runCli, writeJson } from './Support/cli.mts';
import { apiConsumers, countBy, facadeModules, references } from './Support/api-lexical.mts';

export function apiExampleInventory(root: string): {
  method: string;
  rows: { status: string }[];
  unresolved_modules: unknown[];
} {
  const consumers = apiConsumers(root, false);
  const rows: (Record<string, unknown> & { status: string })[] = [];
  const unresolved: unknown[] = [];
  for (const { packageName, module, sources } of facadeModules(root, false)) {
    if (sources.length === 0) {
      unresolved.push({
        package: packageName,
        module,
        reason: 'source not resolved (including upstream/conditional modules)',
      });
    }

    for (const source of sources) {
      if (source.exports === null) {
        unresolved.push({
          package: packageName,
          module,
          source: source.path,
          reason: 'implicit export list; manual compiler-backed expansion required',
        });
        continue;
      }

      for (const group of source.exports) {
        const name = /^(?:type\s+|pattern\s+)?([\w']+)/.exec(group)?.[1] ?? null;
        const refs =
          name && !group.startsWith('module ') ? references(consumers, module, name) : [];
        let status = refs.length > 0 ? 'test_only_candidate' : 'no_direct_reference_found';

        if (refs.some(({ category }) => category === 'example_source')) {
          status = 'example_source_candidate';
        }

        rows.push({
          package: packageName,
          module,
          source: source.path,
          export: group,
          name,
          internal: module.includes('.Internal') || module.startsWith('GHC.'),
          status,
          references: refs.map(({ path, line, category }) => ({ path, line, kind: category })),
        });
      }
    }
  }

  return {
    method:
      'Lexical candidates only. Export groups T(..), reexports and indirect references require compiler-backed resolution. No runtime coverage or completeness claim.',
    rows,
    unresolved_modules: unresolved,
  };
}

runCli(import.meta.url, '[--output FILE]', () => {
  const { values } = parseArgs({
    options: { output: { type: 'string', default: 'docs/audits/api-example-inventory.json' } },
  });
  const result = apiExampleInventory(repositoryRoot);
  writeJson(resolve(repositoryRoot, values.output), result);
  console.log(
    JSON.stringify({
      exports_groups: result.rows.length,
      status: countBy(result.rows.map(({ status }) => status)),
      unresolved_modules: result.unresolved_modules,
    }),
  );
  return 0;
});
