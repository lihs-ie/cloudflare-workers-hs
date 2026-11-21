import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  absolutePath,
  files,
  isDirectory,
  isFile,
  repositoryRoot,
  runCli,
  textFile,
  writeJson,
} from './Support/cli.mts';

const libraries = [
  'cloudflare-workers',
  'servant-cloudflare-workers',
  'servant-cloudflare-workers-client',
  'servant-cloudflare-workers-access',
];
const smallExamples = ['minimal', 'static-assets', 'realtime', 'workflows'];
const defaultLayers = [
  'cloudflare-workers/test/unit',
  ...libraries.map((name) => `${name}/test/integration/runtime`),
  'cloudflare-workers/test/host-testkit',
  ...libraries
    .slice(1)
    .flatMap((name) =>
      name === 'servant-cloudflare-workers'
        ? [`${name}/test/unit`, `${name}/test/conformance`]
        : [`${name}/test/unit`],
    ),
  'examples/url-shortener/test/unit',
  'examples/url-shortener/test/integration',
  'tests/runtime/test/model',
  'conformance-oracle/test/unit',
  'testing-support/test/integration',
  'examples/url-shortener/packages/domain/test/unit',
  'examples/url-shortener/apps/management/test/unit',
  'examples/api-catalog/test/integration',
  'examples/queued-jobs/test/integration',
  ...smallExamples.map((name) => `examples/${name}/test/unit`),
  ...smallExamples.map((name) => `examples/${name}/test/integration`),
];

const extensions = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const extensionTranslations = new Map([
  ['.js', '.ts'],
  ['.mjs', '.mts'],
  ['.cjs', '.cts'],
]);
const scope =
  'static file/import/registration structure only; runtime full test names require separate verification';

interface TestEntry {
  entry: string;
  layer: string;
  children: string[];
}

export interface Registration {
  scope: string;
  inventory: TestEntry[];
  errors: string[];
}

interface Layer {
  root: string;
  entries: Set<string>;
  owners: Map<string, string[]>;
  errors: string[];
}

function moduleName(root: string, path: string): string {
  return relative(root, path).slice(0, -3).split(sep).join('.');
}

function unComment(path: string): string {
  const source = textFile(path);

  if (extname(path) === '.hs') {
    return source.replace(/\{-[\s\S]*?-\}/g, '').replace(/--[^\n]*/g, '');
  }

  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
}

function register(layer: Layer, entry: string, target: string, name: string, count: number): void {
  if (count !== 1) {
    layer.errors.push(
      `${relative(layer.root, entry)}: ${name} registered ${count} times, expected once`,
    );
  }

  layer.owners.get(target)?.push(entry);
}

function haskellChildren(
  layer: Layer,
  entry: string,
  byModule: ReadonlyMap<string, string>,
  support: ReadonlySet<string>,
): string[] {
  const source = unComment(entry);
  const body = source
    .split('\n')
    .filter((line) => !line.startsWith('import '))
    .join('\n')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const children: string[] = [];
  for (const [, module, alias] of source.matchAll(
    /^import\s+(?:qualified\s+)?([\w.]+)(?:\s+qualified)?(?:\s+as\s+(\w+))?/gm,
  )) {
    if (!/(?:Cases|Spec)$/.test(module)) {
      continue;
    }

    const target = byModule.get(module);
    if (target === undefined) {
      layer.errors.push(`${relative(layer.root, entry)}: unresolved test module ${module}`);
      continue;
    }

    if (layer.entries.has(target) && !support.has(target)) {
      layer.errors.push(`${relative(layer.root, entry)}: imports another entry ${module}`);
      continue;
    }

    const count = [
      ...body.matchAll(new RegExp(`\\b${RegExp.escape(alias ?? module)}\\.spec\\b`, 'g')),
    ].length;
    register(layer, entry, target, module + '.spec', count);
    children.push(relative(layer.root, target));
  }

  return children;
}

function resolveChild(entry: string, reference: string): string {
  const target = absolutePath(resolve(dirname(entry), reference));
  const extension = extname(target);
  const translated = extensionTranslations.get(extension);
  if (translated !== undefined && !isFile(target)) {
    return target.slice(0, -extension.length) + translated;
  }

  return extensions.includes(extension) ? target : target + '.ts';
}

function javascriptChildren(layer: Layer, entry: string): string[] {
  const source = unComment(entry);
  const children: string[] = [];
  for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, bindings, reference] = match;

    if (!reference.includes('.cases')) {
      continue;
    }

    const target = resolveChild(entry, reference);
    if (!layer.owners.has(target)) {
      layer.errors.push(`${relative(layer.root, entry)}: unresolved child ${reference}`);
      continue;
    }

    const names = bindings.split(',').flatMap((binding) => {
      const name = binding.trim().split(' as ').at(-1);
      return name?.startsWith('register') ? [name] : [];
    });
    const body = source.slice(0, match.index) + source.slice(match.index + match[0].length);
    const count = names.reduce(
      (sum, name) =>
        sum + [...body.matchAll(new RegExp(`\\b${RegExp.escape(name)}\\s*\\(`, 'g'))].length,
      0,
    );
    register(layer, entry, target, reference, count);
    children.push(relative(layer.root, target));
  }

  return children;
}

function findTestRoot(directory: string): string {
  for (let path = directory; path !== dirname(path); path = dirname(path)) {
    if (basename(path) === 'test') {
      return path;
    }
  }

  return directory;
}

function checkCabalRegistration(layer: Layer, directory: string, testRoot: string): void {
  const packageRoot = dirname(testRoot);
  const cabal = files(packageRoot, (name) => isDirectory(join(packageRoot, name))).find(
    (path) => extname(path) === '.cabal',
  );
  if (cabal === undefined) {
    return;
  }

  const manifest = textFile(cabal);
  for (const path of [...layer.entries, ...layer.owners.keys()]) {
    if (extname(path) !== '.hs') {
      continue;
    }

    const name = moduleName(directory, path);
    if (!new RegExp(`(?<![\\w.])${RegExp.escape(name)}(?![\\w.])`).test(manifest)) {
      layer.errors.push(
        `${relative(layer.root, path)}: module absent from ${relative(layer.root, cabal)}`,
      );
    }
  }
}

function checkLayer(root: string, name: string, errors: string[]): TestEntry[] {
  const directory = resolve(root, name);
  const paths = files(directory);
  const entries = new Set(
    paths.filter(
      (path) =>
        (path.endsWith('Spec.hs') && basename(path) !== 'Spec.hs') ||
        extensions.some((extension) => path.endsWith('.spec' + extension)),
    ),
  );
  if (entries.size === 0) {
    errors.push(`no test entrypoints: ${name}`);
  }

  const children = paths.filter(
    (path) =>
      path.endsWith('Cases.hs') ||
      extensions.some((extension) => path.endsWith('.cases' + extension)),
  );
  const owners = new Map<string, string[]>(children.map((path) => [path, []]));
  const layer = { root, entries, owners, errors };
  const testRoot = findTestRoot(directory);
  const support = new Set(files(join(testRoot, 'Support')).filter((path) => path.endsWith('.hs')));
  const byModule = new Map([...support].map((path) => [moduleName(testRoot, path), path]));
  for (const path of [...children, ...entries].filter((path) => path.endsWith('.hs'))) {
    byModule.set(moduleName(directory, path), path);
  }

  const inventory = [...entries].map((entry) => ({
    layer: name,
    entry: relative(root, entry),
    children: entry.endsWith('.hs')
      ? haskellChildren(layer, entry, byModule, support)
      : javascriptChildren(layer, entry),
  }));

  for (const [child, registrations] of owners) {
    if (registrations.length !== 1) {
      errors.push(`${relative(root, child)}: has ${registrations.length} owners, expected one`);
    }
  }

  checkCabalRegistration(layer, directory, testRoot);
  return inventory;
}

export function registration(
  directory: string,
  layers: readonly string[] = defaultLayers,
): Registration {
  const root = absolutePath(resolve(directory));
  const seen = new Set<string>();
  const errors: string[] = [];
  const inventory: TestEntry[] = [];
  for (const name of layers) {
    const path = absolutePath(resolve(root, name));
    if (!isDirectory(path)) {
      errors.push(`missing required test layer: ${name}`);
      continue;
    }

    if (seen.has(path)) {
      errors.push(`duplicate test layer: ${name}`);
      continue;
    }

    seen.add(path);
    inventory.push(...checkLayer(root, name, errors));
  }

  return { scope, inventory, errors: [...new Set(errors)].sort() };
}

runCli(import.meta.url, () => {
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: repositoryRoot },
      layer: { type: 'string', multiple: true },
      output: { type: 'string' },
    },
  });
  const result = registration(values.root, values.layer);

  if (values.output === undefined) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    writeJson(values.output, result);
    console.log(
      `Registration: ${result.inventory.length} entrypoints, ${result.errors.length} errors; inventory: ${values.output}`,
    );
    result.errors.forEach((error) => console.log(error));
  }

  return result.errors.length === 0 ? 0 : 1;
});
