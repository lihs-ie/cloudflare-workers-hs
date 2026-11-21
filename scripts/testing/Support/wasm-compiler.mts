import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { absolutePath, digest, executableOnPath, isFile, jsonFile } from './cli.mts';
import { loggedCommand, recordCommand, type CommandEvidence } from './evidence-io.mts';
import { object, string } from './validation.mts';

export interface CrossCompiler {
  path: string;
  sha256: string;
  version: string;
  cabal_path: string;
  cabal_sha256: string;
  alias: string;
  search_path: string;
  platform: string;
}

export function crossCompiler(
  root: string,
  output: string,
  env: NodeJS.ProcessEnv,
): {
  compiler: CrossCompiler;
  compilerCommands: CommandEvidence[];
  toolchainEnvironment: { path: string; sha256: string } | null;
} {
  const envFile = join(homedir(), '.ghc-wasm/env');
  const shell =
    'if ! command -v wasm32-wasi-ghc >/dev/null; then source "$1"; fi; command -v wasm32-wasi-ghc; printf "%s\\n" "$PATH"';
  const records: CommandEvidence[] = [];
  function run(label: string, argv: string[]): string {
    const result = loggedCommand(output, 'compiler-' + label + '.log', argv, { cwd: root, env });
    records.push(recordCommand(result));

    if (result.code !== 0) {
      throw new Error('WASM compiler ' + label + ' failed');
    }

    return result.stdout.trim();
  }

  const [alias, searchPath, ...extra] = run('resolution', [
    'bash',
    '-c',
    shell,
    'wasm-compiler',
    envFile,
  ]).split('\n');

  if (!alias || !searchPath || extra.length > 0) {
    throw new Error('Cross compiler resolution returned ambiguous paths');
  }

  const path = absolutePath(resolve(alias));
  const cabal = executableOnPath('wasm32-wasi-cabal', searchPath, root);
  const version = run('version', [path, '--numeric-version']);
  const platform = run('platform', [path, '--print-target-platform']);
  if (!['wasm32-wasi', 'wasm32-unknown-wasi'].includes(platform)) {
    throw new Error('Coverage cross compiler does not target wasm32-wasi');
  }

  return {
    compiler: {
      path,
      sha256: digest(path),
      version,
      cabal_path: cabal,
      cabal_sha256: digest(cabal),
      alias,
      search_path: searchPath,
      platform,
    },
    compilerCommands: records,
    toolchainEnvironment: isFile(envFile) ? { path: envFile, sha256: digest(envFile) } : null,
  };
}

export function saveBuildPlan(
  root: string,
  output: string,
  directory: string,
  example: string,
  compiler: CrossCompiler,
): { path: string; sha256: string; buildDirectory: string; compiler: string } {
  const buildDirectory = resolve(root, directory);
  const path = join(buildDirectory, 'cache/plan.json');
  const plan = object(jsonFile(path));
  if (
    plan['compiler-id'] !== 'ghc-' + compiler.version ||
    plan.arch !== 'wasm32' ||
    plan.os !== 'wasi'
  ) {
    throw new Error('WASM build plan differs from the recorded compiler');
  }

  const saved = join(output, 'plans', example + '.json');
  mkdirSync(dirname(saved), { recursive: true });
  copyFileSync(path, saved);
  return {
    path: relative(output, saved),
    sha256: digest(saved),
    buildDirectory,
    compiler: string(plan['compiler-id']),
  };
}
