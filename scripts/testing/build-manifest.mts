import { jsonValue } from './Support/json.mts';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type BuildTarget = 'library-runtime' | 'url-shortener' | 'runtime-tests';
export type InputHashes = Record<string, string>;

const root = fileURLToPath(new URL('../../', import.meta.url));
const libraries = [
  'cloudflare-workers',
  'servant-cloudflare-workers',
  'servant-cloudflare-workers-client',
  'servant-cloudflare-workers-access',
];
const ignoredDirectories = new Set(['node_modules', '.wrangler', 'test-artifacts', '.git', '.hpc']);

export function sourceFiles(
  directory: string,
  excludedFiles: ReadonlySet<string> = new Set(),
): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (
        ignoredDirectories.has(entry.name) ||
        entry.name.startsWith('dist-') ||
        entry.name.startsWith('.dev-test-') ||
        entry.name === 'worker-configuration.d.ts'
      ) {
        return [];
      }

      const filename = path.join(directory, entry.name);

      if (excludedFiles.has(filename)) {
        return [];
      }

      if (entry.isDirectory()) {
        return sourceFiles(filename, excludedFiles);
      }

      if (/\.(?:wasm|tix|build\.json)$/.test(entry.name) || entry.name.endsWith('-jsffi.mjs')) {
        return [];
      }

      return [filename];
    })
    .sort();
}

function targetDirectory(target: BuildTarget): string {
  if (!['library-runtime', 'url-shortener', 'runtime-tests'].includes(target)) {
    throw new Error(`Unknown build target: ${target}`);
  }

  return target === 'library-runtime' ? 'tests/runtime' : 'examples/url-shortener';
}

function digest(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

function inputRoots(target: BuildTarget): string[] {
  const common = [
    'support/interop/src',
    ...libraries.flatMap((library) => [`${library}/src`, `${library}/${library}.cabal`]),
  ];

  if (target === 'library-runtime') {
    return [...common, ...libraries.map((library) => `${library}/test`), 'tests/runtime'];
  }

  const example = 'examples/url-shortener';
  const application = [
    ...common,
    ...['app', 'src', 'apps', 'workers', 'packages', 'migrations', 'worker', 'scripts'].map(
      (name) => `${example}/${name}`,
    ),
    `${example}/url-shortener.cabal`,
    `${example}/package.json`,
    `${example}/apps/redirect/wrangler.jsonc`,
    `${example}/test/Support/Coverage.hs`,
  ];
  return target === 'runtime-tests'
    ? [...application, `${example}/test/Support/Runtime`]
    : application;
}

export function buildInputs(target: BuildTarget): InputHashes {
  targetDirectory(target);
  const candidates = [
    'cabal-wasm.project',
    'cabal-wasm-coverage.project',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    'scripts/testing/build-manifest.mts',
    ...inputRoots(target),
  ].flatMap((name) => {
    const filename = path.join(root, name);
    return path.extname(name) ? [filename] : sourceFiles(filename);
  });
  const names = [...new Set(candidates)].sort();

  return Object.fromEntries(
    names.map((filename) => [path.relative(root, filename), digest(filename)]),
  );
}

function parseHashes(value: unknown): InputHashes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an input hash record');
  }

  const result: InputHashes = {};
  for (const [name, hash] of Object.entries(value)) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new TypeError(`Invalid input hash: ${name}`);
    }

    result[name] = hash;
  }

  return result;
}

function readJSON(filename: string): unknown {
  return jsonValue(readFileSync(filename, 'utf8'));
}

function artifact(target: BuildTarget, extension: string): string {
  return path.join(root, targetDirectory(target), 'worker', target + extension);
}

export function captureBuildInputs(target: BuildTarget, snapshot: string): void {
  writeFileSync(snapshot, JSON.stringify(buildInputs(target)));
}

export function writeBuild(target: BuildTarget, snapshot: string): void {
  const initialInputs = parseHashes(readJSON(snapshot));

  if (JSON.stringify(initialInputs) !== JSON.stringify(buildInputs(target))) {
    throw new Error('Build inputs changed during compilation; rebuild before running tests');
  }

  const manifest = {
    target,
    inputs: initialInputs,
    wasm: digest(artifact(target, '.wasm')),
    glue: digest(artifact(target, '-jsffi.mjs')),
  };
  writeFileSync(artifact(target, '.build.json'), JSON.stringify(manifest, null, 2));
}

export function verifyBuild(target: BuildTarget): void {
  const recorded = readJSON(artifact(target, '.build.json'));

  if (
    typeof recorded !== 'object' ||
    recorded === null ||
    !('target' in recorded) ||
    recorded.target !== target ||
    !('inputs' in recorded) ||
    !('wasm' in recorded) ||
    !('glue' in recorded)
  ) {
    throw new Error('Invalid build manifest');
  }

  const inputs = parseHashes(recorded.inputs);

  if (
    JSON.stringify(inputs) !== JSON.stringify(buildInputs(target)) ||
    recorded.wasm !== digest(artifact(target, '.wasm')) ||
    recorded.glue !== digest(artifact(target, '-jsffi.mjs'))
  ) {
    throw new Error(`Stale or modified WASM/glue: rebuild ${target}`);
  }
}

export function bundleFiles(directory: string): InputHashes {
  function files(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true })
      .flatMap((entry) => {
        const filename = path.join(folder, entry.name);
        return entry.isDirectory() ? files(filename) : [filename];
      })
      .sort();
  }

  return Object.fromEntries(
    files(directory)
      .filter((filename) => filename !== path.join(directory, 'build-manifest.json'))
      .map((filename) => [path.relative(directory, filename), digest(filename)]),
  );
}

export interface BundleBuildContext {
  verify(): void;
  inputs(): InputHashes;
}

const libraryBundleContext: BundleBuildContext = {
  verify: () => verifyBuild('library-runtime'),
  inputs: () => buildInputs('library-runtime'),
};

export function writeBundle(
  directory: string,
  initialInputs: InputHashes,
  context: BundleBuildContext = libraryBundleContext,
): void {
  context.verify();

  if (JSON.stringify(initialInputs) !== JSON.stringify(context.inputs())) {
    throw new Error('Build inputs changed during bundling; rebuild the runtime and model bundle');
  }

  const outputs = bundleFiles(directory);

  if (!('harness.js' in outputs) || !Object.keys(outputs).some((name) => name.endsWith('.wasm'))) {
    throw new Error('Model bundle is missing its JavaScript or WASM artifact');
  }

  writeFileSync(
    path.join(directory, 'build-manifest.json'),
    JSON.stringify(
      {
        inputs: initialInputs,
        outputs,
      },
      null,
      2,
    ),
  );
}

export function verifyBundle(
  directory: string,
  context: BundleBuildContext = libraryBundleContext,
): void {
  context.verify();
  const recorded = readJSON(path.join(directory, 'build-manifest.json'));

  if (
    typeof recorded !== 'object' ||
    recorded === null ||
    !('inputs' in recorded) ||
    !('outputs' in recorded)
  ) {
    throw new Error('Invalid model bundle manifest');
  }

  if (
    JSON.stringify(parseHashes(recorded.inputs)) !== JSON.stringify(context.inputs()) ||
    JSON.stringify(parseHashes(recorded.outputs)) !== JSON.stringify(bundleFiles(directory))
  ) {
    throw new Error('Stale or modified model bundle: run pnpm --dir tests/runtime build:model');
  }
}
