import { jsonValue } from './Support/json.mts';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { sourceFiles } from './build-manifest.mts';

export interface ExampleBuild {
  directory: string;
  components: string[];
  inputs: string[];
}

const hashes = z.record(z.string(), z.string());
const proofSchema = z.object({ sources: hashes, artifacts: hashes });

function digest(filename: string): string {
  return createHash('sha256').update(readFileSync(filename)).digest('hex');
}

export function sourceHashes(build: ExampleBuild): Record<string, string> {
  return Object.fromEntries(
    build.inputs
      .flatMap((name) => {
        const filename = path.resolve(build.directory, name);
        return path.extname(name)
          ? [filename]
          : sourceFiles(filename, new Set([path.resolve(build.directory, 'worker/build.json')]));
      })
      .sort()
      .map((filename) => [path.relative(build.directory, filename), digest(filename)]),
  );
}

function artifactHashes(build: ExampleBuild): Record<string, string> {
  const names = build.components.flatMap((name) => [
    `worker/${name}.wasm`,
    `worker/${name}-jsffi.mjs`,
  ]);
  return Object.fromEntries(names.map((name) => [name, digest(path.join(build.directory, name))]));
}

export function verifyExampleBuild(build: ExampleBuild): void {
  const recorded: unknown = jsonValue(
    readFileSync(path.join(build.directory, 'worker/build.json'), 'utf8'),
  );
  const proof = proofSchema.parse(recorded);

  if (JSON.stringify(proof.sources) !== JSON.stringify(sourceHashes(build))) {
    throw new Error('Example WASM is stale; run its scripts/build.sh');
  }

  if (JSON.stringify(proof.artifacts) !== JSON.stringify(artifactHashes(build))) {
    throw new Error('Example WASM/glue digest mismatch');
  }
}

export function writeExampleBuild(build: ExampleBuild, snapshot: string): void {
  const recorded: unknown = jsonValue(readFileSync(snapshot, 'utf8'));
  const before = hashes.parse(recorded);
  const after = sourceHashes(build);

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Example inputs changed while compiling; rebuild');
  }

  writeFileSync(
    path.join(build.directory, 'worker/build.json'),
    JSON.stringify(
      {
        sources: after,
        artifacts: artifactHashes(build),
      },
      null,
      2,
    ) + '\n',
  );
}

export function exampleBuild(moduleURL: string, name: string, components: string[]): ExampleBuild {
  return {
    directory: fileURLToPath(new URL('../..', moduleURL)),
    components,
    inputs: [
      'app',
      'src',
      'worker',
      'scripts',
      'test',
      'package.json',
      `${name}.cabal`,
      '../../support/interop/src',
      '../../scripts/testing/example-build.mts',
      '../../scripts/testing/build-manifest.mts',
      '../../pnpm-lock.yaml',
      '../../pnpm-workspace.yaml',
      '../../package.json',
      '../../cabal-wasm.project',
      '../../cabal-wasm-coverage.project',
      ...[
        'cloudflare-workers',
        'servant-cloudflare-workers',
        'servant-cloudflare-workers-client',
      ].flatMap((library) => [`../../${library}/src`, `../../${library}/${library}.cabal`]),
    ],
  };
}

export function manifestCLI(moduleURL: string, build: ExampleBuild): void {
  if (process.argv[1] !== fileURLToPath(moduleURL)) {
    return;
  }

  const [, , operation, snapshot] = process.argv;

  if (!snapshot) {
    throw new Error('Expected capture or write and a snapshot filename');
  }

  if (operation === 'capture') {
    writeFileSync(snapshot, JSON.stringify(sourceHashes(build)));
    return;
  }

  if (operation === 'write') {
    writeExampleBuild(build, snapshot);
    return;
  }

  throw new Error('Expected capture or write');
}
