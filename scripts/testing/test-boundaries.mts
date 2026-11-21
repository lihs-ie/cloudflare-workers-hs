import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { absolutePath, files, repositoryRoot, runCli, textFile, within } from './Support/cli.mts';

const libraries = [
  'cloudflare-workers',
  'servant-cloudflare-workers',
  'servant-cloudflare-workers-client',
  'servant-cloudflare-workers-access',
];
const importReference = /(?:\bfrom\s*|\bimport\s*\()(['"])([^'"\n]+)\1/g;
const exampleImport =
  /^import\s+(?:qualified\s+)?(?:ApiCatalog|QueuedJobs|UrlShortener|Minimal|Realtime|WorkflowExample|StaticAssets)\b/m;

function skippedDirectory(name: string): boolean {
  return (
    ['node_modules', '.wrangler', 'test-artifacts'].includes(name) || name.startsWith('.dev-test-')
  );
}

function importViolations(root: string, file: string, name: string, source: string): string[] {
  const [topLevel, packageDirectory, area] = name.split(sep);
  const parts = name.split(sep);
  const sharedRuntime = topLevel === 'tests' && packageDirectory === 'runtime';
  const libraryTest = libraries.includes(topLevel) && parts.includes('test');
  const sharedSupport =
    topLevel === 'scripts' && packageDirectory === 'testing' && area === 'Support';
  const production =
    topLevel === 'examples' &&
    ['worker', 'src', 'app', 'apps', 'workers', 'packages'].includes(area);

  const errors: string[] = [];
  for (const [, , reference] of source.matchAll(importReference)) {
    if (!reference.startsWith('.')) {
      continue;
    }

    const target = absolutePath(resolve(dirname(file), reference));
    if (!within(root, target)) {
      errors.push(`${name}: import escapes repository: ${reference}`);
      continue;
    }

    const destination = relative(root, target).split(sep);
    if ((libraryTest || sharedSupport || sharedRuntime) && destination[0] === 'examples') {
      errors.push(`${name}: library/test infrastructure imports an example: ${reference}`);
    }

    if (
      production &&
      (destination.includes('test') || destination.slice(0, 2).join('/') === 'tests/runtime')
    ) {
      errors.push(`${name}: production imports test support: ${reference}`);
    }
  }

  return errors;
}

export function violations(directory: string): string[] {
  const root = absolutePath(resolve(directory));
  const errors: string[] = [];
  for (const name of [
    ...libraries,
    'examples',
    'scripts/testing/Support',
    'tests/runtime',
    'testing-support',
  ]) {
    for (const file of files(join(root, name), skippedDirectory)) {
      const path = relative(root, file);
      const extension = extname(file);
      if (
        !['.ts', '.mts', '.js', '.mjs', '.hs', '.cabal'].includes(extension) ||
        ['.d.ts', '.d.mts', '-jsffi.mjs'].some((suffix) => file.endsWith(suffix))
      ) {
        continue;
      }

      const source = textFile(file);

      if (extension === '.mjs') {
        errors.push(`${path}: handwritten JavaScript must use TypeScript`);
      }

      errors.push(...importViolations(root, file, path, source));

      if (name === 'examples' || name === 'scripts/testing/Support') {
        continue;
      }

      if (extension === '.cabal' && source.includes('examples/')) {
        errors.push(`${path}: shared library/test composition depends on example modules`);
      }

      if (extension === '.hs' && exampleImport.test(source)) {
        errors.push(`${path}: shared Haskell code imports an example module`);
      }
    }
  }

  return errors;
}

runCli(import.meta.url, '[--root DIR]', () => {
  const { values } = parseArgs({ options: { root: { type: 'string', default: repositoryRoot } } });
  const errors = violations(values.root);
  errors.forEach((error) => console.log(error));
  console.log(`Test ownership: ${errors.length} violation(s)`);
  return errors.length === 0 ? 0 : 1;
});
