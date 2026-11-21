import { dirname, join } from 'node:path';
import { digest, executableOnPath, files, jsonFile, textFile } from './cli.mts';
import {
  childPath,
  commandProof,
  equals,
  readPointer,
  sourceSnapshot,
  successfulProof,
  verifiedFile,
  verifiedFiles,
  type Sources,
} from './evidence-io.mts';
import { list, object, string } from './validation.mts';

export interface HpcProof {
  compiler?: { path: string; version: string; sha256: string };
  artifacts: Set<string>;
  sources: Sources;
  snapshots: string[];
  mix: string[];
}

export function hpcProof(
  root: string,
  path: string,
  sources: Sources,
  runtime: 'host' | 'wasm' | 'native',
): HpcProof {
  const proofPath = childPath(root, path);
  const directory = dirname(proofPath);
  const proof = object(jsonFile(proofPath));
  successfulProof(proof, sources);
  const commands = commandProof(directory, proof.commands);
  const snapshots = verifiedFiles(directory, proof.snapshots, 'HPC counters');
  const mix = verifiedFiles(directory, proof.mixFiles, 'HPC maps');
  const actualMix = files(join(directory, 'mix'))
    .filter((name) => name.endsWith('.mix'))
    .sort();
  if (!equals(actualMix, mix.toSorted())) {
    throw new Error('Unlisted HPC mix file');
  }

  const artifacts = new Set([...snapshots, ...mix]);

  if (runtime === 'native') {
    return { artifacts, sources, snapshots, mix };
  }

  const details = object(proof.compiler);
  const executable = string(details.path);
  const sha256 = string(details.sha256);
  const version = string(details.version);

  if (digest(executable) !== sha256) {
    throw new Error('HPC compiler fingerprint changed');
  }

  const compiler = { path: executable, sha256, version };
  const compilerCommands =
    runtime === 'wasm' ? commandProof(directory, proof.compilerCommands) : commands;
  const versionCommand = compilerCommands.find(({ command }) =>
    equals(command, [executable, '--numeric-version']),
  );
  if (
    versionCommand === undefined ||
    textFile(childPath(directory, string(versionCommand.log))).trim() !== version
  ) {
    throw new Error('HPC compiler version command is missing or inconsistent');
  }

  if (runtime === 'host') {
    const build = commands
      .map((entry) => list(entry.command))
      .find(
        (argv) =>
          argv[0] === 'cabal' &&
          argv[1] === 'build' &&
          argv.includes('--with-compiler=' + executable),
      );
    if (build === undefined) {
      throw new Error('Compiler is not bound to the host build');
    }
  } else {
    validateWasmCompiler(root, directory, proof, compilerCommands, details, compiler);
  }

  return { compiler, artifacts, sources, snapshots, mix };
}

function validateWasmCompiler(
  root: string,
  directory: string,
  proof: Record<string, unknown>,
  commands: Record<string, unknown>[],
  details: Record<string, unknown>,
  compiler: NonNullable<HpcProof['compiler']>,
): void {
  if (
    !['wasm32-wasi', 'wasm32-unknown-wasi'].includes(string(details.platform)) ||
    digest(string(details.cabal_path)) !== details.cabal_sha256
  ) {
    throw new Error('Missing WASM compiler/build-plan provenance');
  }

  if (executableOnPath('wasm32-wasi-ghc', string(details.search_path), root) !== compiler.path) {
    throw new Error('WASM compiler resolution changed');
  }

  const platform = commands.find(({ command }) =>
    equals(command, [compiler.path, '--print-target-platform']),
  );
  if (
    platform === undefined ||
    textFile(childPath(directory, string(platform.log))).trim() !== details.platform
  ) {
    throw new Error('WASM compiler target differs');
  }

  if (proof.toolchainEnvironment !== null && proof.toolchainEnvironment !== undefined) {
    const env = object(proof.toolchainEnvironment);
    if (digest(string(env.path)) !== env.sha256) {
      throw new Error('WASM toolchain environment changed');
    }
  }

  const plans = list(proof.buildPlans).map(object);
  if (plans.length === 0) {
    throw new Error('Missing WASM build plans');
  }

  for (const plan of plans) {
    const saved = object(jsonFile(verifiedFile(directory, plan.path, plan.sha256)));
    if (
      saved['compiler-id'] !== 'ghc-' + compiler.version ||
      saved.arch !== 'wasm32' ||
      saved.os !== 'wasi'
    ) {
      throw new Error('WASM plan/compiler mismatch');
    }
  }
}

export function validJavascriptProof(report: string, proofPath: string, sources: Sources): boolean {
  try {
    const proof = object(jsonFile(proofPath));
    return (
      proof.exit_code === 0 && equals(proof.sources, sources) && proof.sha256 === digest(report)
    );
  } catch {
    return false;
  }
}

export interface SharedJavascript {
  combined: string;
  workerdOnly: string;
  proof: string;
}

export function pointerPath(root: string, name: string, field: string): string {
  const pointer = readPointer(root, name);
  return childPath(root, string(pointer[field]));
}

export function assertFreshSources(root: string, expected: Sources): void {
  if (!equals(sourceSnapshot(root), expected)) {
    throw new Error('Source inputs changed during validation');
  }
}
