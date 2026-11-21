import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  absolutePath,
  capture,
  digest,
  files,
  isFile,
  jsonFile,
  textFile,
  within,
  writeJson,
} from './cli.mts';
import {
  childPath,
  equals,
  loggedCommand,
  recordCommand,
  type RunEvidence,
  type Sources,
} from './evidence-io.mts';
import { copyMix, mixIndex, parseTix, successfulSummaries } from './hpc.mts';
import { list, object, string } from './validation.mts';

interface Compiler {
  path: string;
  sha256: string;
  version: string;
}

interface HostProof extends RunEvidence {
  schema: number;
  compiler?: Compiler;
  planSha256?: string;
  snapshots: Record<string, string>;
  mixFiles: Record<string, string>;
}

interface CollectHostOptions {
  root: string;
  output: string;
  targets: readonly string[];
  snapshot: () => Sources;
  builds?: string;
  match?: string;
  environment?: NodeJS.ProcessEnv;
}

interface HostCommands {
  root: string;
  build: string;
  common: string[];
  env: NodeJS.ProcessEnv;
  execute: (argv: string[], cwd: string, label: string, env?: NodeJS.ProcessEnv) => string;
}

export function testEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...input };
  const ffi = '/opt/homebrew/opt/libffi/include';
  if (process.platform === 'darwin' && isFile(join(ffi, 'ffi.h'))) {
    env.C_INCLUDE_PATH = [ffi, env.C_INCLUDE_PATH].filter(Boolean).join(':');
  }

  return env;
}

function configurePackageData(
  root: string,
  plan: Record<string, unknown>[],
  env: NodeJS.ProcessEnv,
): void {
  for (const entry of plan) {
    const source = object(entry['pkg-src'] ?? {});
    if (source.type !== 'local') {
      continue;
    }

    const packageRoot = childPath(root, string(source.path));
    const manifests = readdirSync(packageRoot).filter((path) => path.endsWith('.cabal'));
    if (manifests.length !== 1) {
      throw new Error('Ambiguous package data configuration: ' + packageRoot);
    }

    const dataDirectories = [
      ...textFile(join(packageRoot, manifests[0])).matchAll(/^data-dir:\s*(.+)$/gim),
    ];
    if (dataDirectories.length > 1) {
      throw new Error('Ambiguous data-dir: ' + packageRoot);
    }

    const data = childPath(packageRoot, dataDirectories[0]?.[1].trim() ?? '.');
    env[string(entry['pkg-name']).replaceAll('-', '_') + '_datadir'] = data;
  }
}

function suiteComponent(plan: Record<string, unknown>[], target: string): Record<string, unknown> {
  const [packageName, kind, suite] = target.split(':');

  if (kind !== 'test' || suite === undefined) {
    throw new Error('Only test components are accepted');
  }

  const entries = plan.filter(
    (item) => item['pkg-name'] === packageName && item['component-name'] === 'test:' + suite,
  );
  if (entries.length !== 1) {
    throw new Error('Ambiguous test component in plan: ' + target);
  }

  return entries[0];
}

function runSuite(
  context: HostCommands,
  plan: Record<string, unknown>[],
  target: string,
  index: number,
  output: string,
  match?: string,
): { tix: string; label: string } {
  const { root, build, common, env, execute } = context;
  const entry = suiteComponent(plan, target);
  const source = object(entry['pkg-src']);
  if (source.type !== 'local') {
    throw new Error('Test source is not local');
  }

  const cwd = childPath(root, string(source.path));
  const listed = execute(['cabal', 'list-bin', target, ...common], root, `list-${index}`).trim();
  const binary = absolutePath(resolve(root, listed));
  if (
    !within(build, binary) ||
    !isFile(binary) ||
    binary !== absolutePath(resolve(root, string(entry['bin-file'])))
  ) {
    throw new Error('Binary differs from local build plan: ' + target);
  }

  const label = `suite-${index}`;
  const tix = join(output, label + '.tix');
  if (existsSync(tix)) {
    throw new Error('Refusing stale counters');
  }

  const log = execute([binary, ...(match ? ['--match', match] : [])], cwd, label, {
    ...env,
    HPCTIXFILE: tix,
  });
  if (!successfulSummaries(log, 1)) {
    throw new Error('Missing, failed or empty test summary');
  }

  if (!isFile(tix) || lstatSync(tix).isSymbolicLink()) {
    throw new Error('Missing fresh counters');
  }

  return { tix, label };
}

export function collectHost(options: CollectHostOptions): HostProof {
  const { targets, snapshot, match } = options;
  const root = absolutePath(resolve(options.root));
  const output = absolutePath(resolve(options.output));
  const build = absolutePath(resolve(root, options.builds ?? 'dist-testing-coverage'));
  mkdirSync(output);
  const proof: HostProof = {
    schema: 1,
    sources: snapshot(),
    commands: [],
    snapshots: {},
    mixFiles: {},
    errors: [],
    exit_code: 1,
  };
  const env = testEnvironment(options.environment);
  delete env.HPCTIXFILE;
  delete env.GHCRTS;

  function execute(
    argv: string[],
    cwd: string,
    label: string,
    commandEnv: NodeJS.ProcessEnv = env,
  ): string {
    const result = loggedCommand(output, label + '.log', argv, {
      cwd,
      env: commandEnv,
      timeout: 1_200_000,
    });
    proof.commands.push(recordCommand(result));

    if (result.code !== 0) {
      throw new Error('Command failed: ' + label);
    }

    return result.stdout;
  }

  try {
    if (targets.length === 0 || new Set(targets).size !== targets.length) {
      throw new Error('Targets must be nonempty and unique');
    }

    const executable = absolutePath(capture(['which', 'ghc'], { env }).trim());
    if (!isFile(executable)) {
      throw new Error('Missing GHC compiler');
    }

    const version = execute([executable, '--numeric-version'], root, 'compiler').trim();
    const compiler = { path: executable, sha256: digest(executable), version };
    proof.compiler = compiler;
    const common = [
      '--project-file=cabal.project',
      '--builddir=' + build,
      '--enable-coverage',
      '--with-compiler=' + executable,
    ];
    execute(['cabal', 'build', ...targets, ...common, '-j2'], root, 'build');

    const planPath = join(build, 'cache/plan.json');
    const planData = object(jsonFile(planPath));
    if (planData['compiler-id'] !== 'ghc-' + version) {
      throw new Error('Build plan compiler differs from requested GHC');
    }

    const plan = list(planData['install-plan']).map(object);
    proof.planSha256 = digest(planPath);
    configurePackageData(root, plan, env);
    const candidates = mixIndex(files(build).filter((path) => path.endsWith('.mix')));
    for (const [index, target] of targets.entries()) {
      const { tix, label } = runSuite(
        { root, build, common, env, execute },
        plan,
        target,
        index,
        output,
        match,
      );
      Object.assign(proof.mixFiles, copyMix(parseTix(textFile(tix)), candidates, output));
      proof.snapshots[label + '.tix'] = digest(tix);
    }

    if (digest(executable) !== compiler.sha256 || !equals(snapshot(), proof.sources)) {
      throw new Error('Compiler or sources changed during host coverage');
    }

    const actualMix = files(join(output, 'mix')).filter((path) => path.endsWith('.mix'));
    if (
      !equals(
        actualMix.map((path) => relative(output, path)).sort(),
        Object.keys(proof.mixFiles).sort(),
      )
    ) {
      throw new Error('Unlisted mix files');
    }

    proof.exit_code = 0;
  } catch (error) {
    proof.errors.push(error instanceof Error ? error.message : String(error));
  }

  writeJson(join(output, 'proof.json'), proof);
  return proof;
}
