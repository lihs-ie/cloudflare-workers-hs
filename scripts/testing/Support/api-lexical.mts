import { extname, join, relative } from 'node:path';
import { files, textFile } from './cli.mts';
import { exposedModules } from '../internal-module-boundaries.mts';

export const packages = [
  'cloudflare-workers',
  'servant-cloudflare-workers',
  'servant-cloudflare-workers-client',
  'servant-cloudflare-workers-access',
];
type Category = 'example_test' | 'example_source' | 'library_test';

interface Consumer {
  path: string;
  category: Category;
  imports: Set<string>;
  lines: string[];
  runtime: boolean;
}

export interface ModuleSource {
  path: string;
  module: string;
  exports: string[] | null;
  text: string;
}

export function cleanHaskell(text: string): string {
  const lines = (value: string): string => '\n'.repeat(value.split('\n').length - 1);
  return text
    .replace(/\{-[\s\S]*?-\}/g, lines)
    .replace(/"(?:\\.|[^"\\])*"/g, (value) => '"' + lines(value) + '"')
    .replace(/--[^\n]*/g, '');
}

export function splitExports(text: string): string[] {
  let depth = 0;
  let start = 0;
  const result: string[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      result.push(text.slice(start, index));
      start = index + 1;
    }
  }

  result.push(text.slice(start));
  return result.map((entry) => entry.trim().replace(/\s+/g, ' ')).filter(Boolean);
}

export function moduleExports(
  text: string,
): { module: string; exports: string[] | null } | undefined {
  const match = /\bmodule\s+([\w.]+)\s*/.exec(text);
  if (match === null) {
    return undefined;
  }

  const module = match[1];
  const tail = text.slice(match.index + match[0].length);
  if (!tail.startsWith('(')) {
    return { module, exports: null };
  }

  let depth = 0;
  for (let index = 0; index < tail.length; index += 1) {
    const char = tail[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;

      if (depth === 0) {
        return { module, exports: splitExports(tail.slice(1, index)) };
      }
    }
  }

  throw new Error('Unclosed export list: ' + module);
}

function importsAndBody(text: string): { imports: Set<string>; lines: string[] } {
  const imports = new Set(
    [...text.matchAll(/^import\s+(?:qualified\s+)?([A-Z][\w.]*)\b/gm)].map((match) => match[1]),
  );
  let active = false;
  let depth = 0;
  const lines = text.split('\n').map((line) => {
    if (/^import\b/.test(line)) {
      active = true;
    }

    if (!active) {
      return line;
    }

    depth += line.split('(').length - line.split(')').length;

    if (depth <= 0) {
      active = false;
      depth = 0;
    }

    return '';
  });
  return { imports, lines };
}

function ignored(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('dist-') ||
    ['node_modules', 'test-artifacts'].includes(name)
  );
}

export function facadeModules(
  root: string,
  sourceOnly: boolean,
): {
  packageName: string;
  module: string;
  sources: ModuleSource[];
}[] {
  return packages.flatMap((packageName) => {
    const packageDirectory = join(root, packageName);
    const sources = files(
      sourceOnly ? join(packageDirectory, 'src') : packageDirectory,
      (name) => ignored(name) || name === 'test',
    )
      .filter((path) => path.endsWith('.hs'))
      .flatMap((path) => {
        const text = cleanHaskell(textFile(path));
        const parsed = moduleExports(text);
        return parsed ? [{ path: relative(root, path), text, ...parsed }] : [];
      });
    const exposed = exposedModules(textFile(join(packageDirectory, packageName + '.cabal')));
    return [...new Set(exposed)].sort().map((module) => ({
      packageName,
      module,
      sources: sources.filter((source) => source.module === module),
    }));
  });
}

export function apiConsumers(root: string, excludeWorker: boolean): Consumer[] {
  return ['examples', ...packages].flatMap((directory) =>
    files(
      join(root, directory),
      (name) => ignored(name) || (excludeWorker && name === 'worker'),
    ).flatMap((file) => {
      const path = relative(root, file);
      const extension = extname(file);
      const test = path.split('/').includes('test');
      if (
        !['.hs', '.ts', '.mts', '.mjs'].includes(extension) ||
        ['-jsffi.mjs', '.d.ts', '.d.mts'].some((suffix) => file.endsWith(suffix)) ||
        (directory !== 'examples' && !test)
      ) {
        return [];
      }

      const raw = textFile(file);
      const text = cleanHaskell(raw);
      const parsed =
        extension === '.hs'
          ? importsAndBody(text)
          : { imports: new Set<string>(), lines: text.split('\n') };
      const exampleCategory = test ? 'example_test' : 'example_source';
      const category: Category = directory === 'examples' ? exampleCategory : 'library_test';
      return [
        {
          path,
          category,
          ...parsed,
          runtime:
            extension !== '.hs' && /worker-runtime|@cloudflare-workers-hs\/runtime/.test(raw),
        },
      ];
    }),
  );
}

export function references(
  consumers: readonly Consumer[],
  module: string,
  name: string,
  runtime: boolean = false,
): {
  path: string;
  category: Category;
  line: number;
}[] {
  const pattern = new RegExp(`(?<![\\w'])${RegExp.escape(name)}(?![\\w'])`);
  return consumers.flatMap((consumer) => {
    if (!(runtime ? consumer.runtime : consumer.imports.has(module))) {
      return [];
    }

    return consumer.lines.flatMap((line, index) =>
      pattern.test(line)
        ? [{ path: consumer.path, category: consumer.category, line: index + 1 }]
        : [],
    );
  });
}

export function countBy(values: readonly string[]): Record<string, number> {
  const totals = new Map<string, number>();
  for (const value of values) {
    totals.set(value, (totals.get(value) ?? 0) + 1);
  }

  return Object.fromEntries(totals);
}
