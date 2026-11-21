import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { digest, isFile, repositoryRoot, runCli, textFile, writeJson } from './Support/cli.mts';
import {
  apiConsumers,
  countBy,
  facadeModules,
  references,
  splitExports,
  type ModuleSource,
} from './Support/api-lexical.mts';

interface Declaration {
  constructors: string[];
  fields: string[];
}

export function declarations(text: string): Map<string, Declaration> {
  const result = new Map<string, Declaration>();
  for (const match of text.matchAll(
    /^(?:data|newtype|class)\s+(?:\([^\n]*\)\s*=>\s*)?([A-Z][\w']*)\b/gm,
  )) {
    const start = match.index + match[0].length;
    const tail = text.slice(start);
    const end = /\n(?=[A-Za-z_][^\n]*(?:::|=)|(?:data|newtype|type|class|instance)\b)/.exec(
      tail,
    )?.index;
    const body = text.slice(match.index, end === undefined ? undefined : start + end);
    const constructors = [
      ...body.matchAll(/(?:=|\|)\s*([A-Z][\w']*)\b/g),
      ...body.matchAll(/^\s+([A-Z][\w']*)\s*::/gm),
    ].map((entry) => entry[1]);
    const records = [...body.matchAll(/(?:\{|,)\s*([a-z][\w']*)\s*::/g)];
    const methods = body.startsWith('class ') ? [...body.matchAll(/^\s+([a-z][\w']*)\s*::/gm)] : [];
    result.set(match[1], {
      constructors: [...new Set(constructors)],
      fields: [...new Set([...records, ...methods].map((entry) => entry[1]))],
    });
  }

  return result;
}

interface Facade {
  package: string;
  module: string;
  expansion_gaps: string[];
}

interface Operation {
  name: string;
  kind: string;
  parent?: string;
  notes?: string[];
}

type Add = (source: string, facade: Facade, operation: Operation) => void;

function expand(source: ModuleSource, facade: Facade, add: Add): void {
  if (source.exports === null) {
    facade.expansion_gaps.push(
      'Implicit exports require compiler-backed enumeration: ' + source.path,
    );
    return;
  }

  const local = declarations(source.text);
  for (const group of source.exports) {
    if (group.startsWith('module ')) {
      add(source.path, facade, {
        name: group.slice(7),
        kind: 'module_reexport',
        notes: ['Unexpanded transitive reexport'],
      });
      facade.expansion_gaps.push(group);
      continue;
    }

    const match = /^(?:type\s+|pattern\s+)?([\w']+|\([^)]*\))/.exec(group);
    if (match === null) {
      facade.expansion_gaps.push('Unparsed export: ' + group);
      continue;
    }

    const name = match[1];
    add(source.path, facade, {
      name,
      kind: /^[A-Z]/.test(name) ? 'type_or_class' : 'operation',
      notes: ['Lexical export: ' + group],
    });
    const members = /\((.*)\)/.exec(group.slice(match[0].length))?.[1];
    if (members === undefined) {
      continue;
    }

    if (members.trim() !== '..') {
      splitExports(members).forEach((member) =>
        add(source.path, facade, { name: member, kind: 'explicit_member', parent: name }),
      );
      continue;
    }

    const declaration = local.get(name);
    if (declaration === undefined) {
      facade.expansion_gaps.push('Imported/reexported constructor group: ' + group);
      continue;
    }

    declaration.constructors.forEach((member) =>
      add(source.path, facade, { name: member, kind: 'constructor_candidate', parent: name }),
    );
    declaration.fields.forEach((member) =>
      add(source.path, facade, { name: member, kind: 'field_or_method_candidate', parent: name }),
    );
  }
}

export function operationInventory(root: string): Record<string, unknown> {
  const consumers = apiConsumers(root, true);
  const rows: (Record<string, unknown> & { kind: string })[] = [];
  const modules: Facade[] = [];
  const exclusions: unknown[] = [];
  const hashes: Record<string, string> = {};
  const add: Add = (source, facade, { name, kind, parent, notes = [] }) => {
    rows.push({
      key: [facade.package, facade.module, ...(parent ? [parent] : []), kind, name].join(':'),
      package: facade.package,
      module: facade.module,
      source,
      name,
      kind,
      parent: parent ?? null,
      source_candidates: references(
        consumers,
        facade.module,
        name,
        facade.package === '@cloudflare-workers-hs/runtime',
      ),
      executed_evidence: [],
      execution_status: 'unverified',
      notes,
    });
  };

  for (const { packageName, module, sources } of facadeModules(root, true)) {
    if (module.includes('.Internal') || module.startsWith('GHC.')) {
      exclusions.push({
        package: packageName,
        module,
        reason: 'Internal/GHC implementation module',
      });
      continue;
    }

    const facade: Facade = { package: packageName, module, expansion_gaps: [] };
    modules.push(facade);

    if (sources.length === 0) {
      facade.expansion_gaps.push(
        'No local source; upstream or conditional module requires compiler-backed expansion',
      );
    }

    for (const source of sources) {
      hashes[source.path] = digest(join(root, source.path));
      expand(source, facade, add);
    }
  }

  const runtimeSource = 'packages/worker-runtime/src/index.ts';
  if (isFile(join(root, runtimeSource))) {
    const facade = {
      package: '@cloudflare-workers-hs/runtime',
      module: 'index.ts',
      expansion_gaps: ['TypeScript fields, overloads and aliases require compiler verification'],
    };
    const raw = textFile(join(root, runtimeSource));
    hashes[runtimeSource] = digest(join(root, runtimeSource));
    modules.push(facade);
    for (const match of raw.matchAll(
      /^export (?:async )?(function|interface|type|class|const) (\w+)/gm,
    )) {
      const [, kind, name] = match;
      add(runtimeSource, facade, { name, kind: 'typescript_' + kind });

      if (kind === 'interface') {
        const start = raw.indexOf('{', match.index + match[0].length);
        let depth = 1;
        let end = start + 1;
        while (start >= 0 && depth > 0 && end < raw.length) {
          depth += Number(raw[end] === '{') - Number(raw[end] === '}');
          end += 1;
        }

        for (const [, field] of raw
          .slice(start + 1, end - 1)
          .matchAll(/^\s*(?:readonly\s+)?(\w+)\??\s*:/gm)) {
          add(runtimeSource, facade, {
            name: field,
            kind: 'typescript_field_candidate',
            parent: name,
          });
        }
      }
    }
  }

  const summary = {
    rows: rows.length,
    kinds: countBy(rows.map(({ kind }) => kind)),
    verified_rows: 0,
    modules_with_expansion_gaps: modules.filter(({ expansion_gaps }) => expansion_gaps.length > 0)
      .length,
  };
  return {
    schema_version: 1,
    source_sha256: hashes,
    modules,
    excluded_modules: exclusions,
    rows,
    summary,
    method_limits: [
      'Lexical inventory only. References do not prove resolution or reachability.',
      'Local constructor and field groups are candidate expansions. Compiler resolution is needed for gaps.',
      'No runtime execution or completeness is inferred.',
    ],
  };
}

runCli(import.meta.url, '[--output FILE]', () => {
  const { values } = parseArgs({
    options: {
      output: { type: 'string', default: 'docs/audits/public-api-operations-20260908.json' },
    },
  });
  const output = resolve(repositoryRoot, values.output);
  if (existsSync(output)) {
    throw new Error('Refusing to overwrite an existing audit; choose a new --output path');
  }

  const result = operationInventory(repositoryRoot);
  writeJson(output, result);
  console.log(JSON.stringify(result.summary));
  return 0;
});
