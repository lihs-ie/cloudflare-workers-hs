import { copyFileSync, cpSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { digest, files, isDirectory, jsonFile, repositoryRoot, runCli } from './Support/cli.mts';
import { runLogged } from './Support/async-command.mts';
import {
  collectFingerprints,
  equals,
  evidencePath,
  publish,
  recordCommand,
  sourceSnapshot,
  type CommandEvidence,
} from './Support/evidence-io.mts';
import { parseTix } from './Support/hpc.mts';
import { withSnapshotServer } from './Support/snapshot-server.mts';
import { crossCompiler, saveBuildPlan } from './Support/wasm-compiler.mts';
import { list, object } from './Support/validation.mts';
import { integrationTests, otherExamples } from './run.mts';

const root = repositoryRoot;
const library = 'library-runtime';
const urlShortener = 'url-shortener';
const examples = [library, urlShortener, ...otherExamples];
const urlBuild = 'examples/url-shortener/scripts/build-wasm.sh';
type Execute = (argv: string[], log: string) => Promise<number>;

function copyMixes(example: string, mix: string): void {
  const owners = [
    'cloudflare-workers',
    'servant-cloudflare-workers',
    'servant-cloudflare-workers-access',
    'servant-cloudflare-workers-client',
    example === library ? 'tests/runtime' : 'examples/' + example,
  ];

  if (example === urlShortener) {
    owners.push(
      'examples/url-shortener/packages/domain',
      'examples/url-shortener/packages/infrastructure',
      'examples/url-shortener/apps/management',
    );
  }

  for (const owner of owners) {
    const parent = join(root, owner, '.hpc');
    if (!isDirectory(parent)) {
      continue;
    }

    for (const directory of readdirSync(parent, { withFileTypes: true })) {
      if (directory.isDirectory() && directory.name.startsWith('wasm')) {
        cpSync(join(parent, directory.name), join(mix, owner, directory.name), { recursive: true });
      }
    }
  }
}

function buildCommand(name: string): string[] {
  if (name === library) {
    return ['bash', 'tests/runtime/scripts/build.sh'];
  }

  if (name === urlShortener) {
    return ['bash', urlBuild, 'runtime-tests'];
  }

  return ['bash', `examples/${name}/scripts/build.sh`];
}

function testCommand(name: string): string[] {
  if (name === library) {
    return ['pnpm', '--dir', 'tests/runtime', 'test:runtime:coverage'];
  }

  if (name === urlShortener) {
    return ['pnpm', '--dir', 'examples/url-shortener', 'test:runtime'];
  }

  return ['node', '--test', '--test-concurrency=1', ...integrationTests(root, name)];
}

async function withSnapshots(
  execute: Execute,
  command: string[],
  logName: string,
  snapshots: string[],
  errors: string[],
): Promise<number> {
  const before = snapshots.length;
  const code = await execute(command, logName + '.log');

  if (before === snapshots.length) {
    errors.push('No WASM snapshots from ' + logName);
  }

  return code;
}

async function urlShortenerProduction(
  execute: Execute,
  snapshots: string[],
  errors: string[],
): Promise<number> {
  const built = await execute(
    ['bash', urlBuild, urlShortener],
    'url-shortener-production-build.log',
  );
  if (built !== 0) {
    return built;
  }

  const run = ['pnpm', '--dir', 'examples/url-shortener'];
  return (
    (await withSnapshots(
      execute,
      [...run, 'test:integration'],
      'url-shortener-production-tests',
      snapshots,
      errors,
    )) ||
    (await withSnapshots(
      execute,
      [...run, 'test:dev'],
      'url-shortener-dev-tests',
      snapshots,
      errors,
    ))
  );
}

async function collect(selected: readonly string[], output: string): Promise<number> {
  const sources = sourceSnapshot(root);
  const commands: CommandEvidence[] = [];
  const snapshots: string[] = [];
  const errors: string[] = [];
  const buildPlans: ReturnType<typeof saveBuildPlan>[] = [];
  const javascriptReports: { path: string; sha256: string }[] = [];
  const env = {
    ...process.env,
    WASM_PROJECT_FILE: 'cabal-wasm-coverage.project',
    WASM_COVERAGE: '1',
    WASM_COVERAGE_ENDPOINT: '',
    WASM_BUILD_DIR: 'dist-wasm-coverage',
  };
  const provenance = crossCompiler(root, output, env);
  const mix = join(output, 'mix');

  const execute: Execute = async (command, log) => {
    const result = await runLogged(output, log, command, { cwd: root, env });
    commands.push(recordCommand(result));
    return result.exitCode;
  };

  function receive(content: string): void {
    parseTix(content);
    const path = join(output, `reactor-${snapshots.length}.tix`);
    writeFileSync(path, content, { flag: 'wx' });
    snapshots.push(path);
  }

  let exit = 1;
  try {
    exit = await withSnapshotServer(receive, errors, async (endpoint) => {
      env.WASM_COVERAGE_ENDPOINT = endpoint;
      for (const name of selected) {
        const build = name === urlShortener ? 'dist-wasm-coverage' : `dist-${name}-coverage`;
        env.WASM_BUILD_DIR = build;
        const code = await execute(buildCommand(name), name + '-build.log');
        if (code !== 0) {
          return code;
        }

        buildPlans.push(saveBuildPlan(root, output, build, name, provenance.compiler));
        let tested = await withSnapshots(
          execute,
          testCommand(name),
          name + '-tests',
          snapshots,
          errors,
        );
        if (tested === 0 && name === library) {
          const path = 'library-runtime-javascript.json';
          copyFileSync(
            join(root, 'tests/runtime/test-artifacts/coverage/runtime/coverage-final.json'),
            join(output, path),
          );
          javascriptReports.push({ path, sha256: digest(join(output, path)) });
        }

        if (tested === 0 && name === urlShortener) {
          tested = await urlShortenerProduction(execute, snapshots, errors);
        }

        copyMixes(name, mix);

        if (tested !== 0 || errors.length > 0) {
          return tested || 1;
        }
      }

      return 0;
    });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!equals(sourceSnapshot(root), sources)) {
    errors.push('Sources changed during coverage execution');
  }

  if (snapshots.length === 0) {
    errors.push('No WASM coverage snapshots received');
  }

  const proof = {
    ...provenance,
    buildPlans,
    javascriptReports,
    sources,
    commands: [...commands],
    errors,
    runtime: 'workerd',
    exit_code: exit || Number(errors.length > 0),
    snapshots: collectFingerprints(output, snapshots),
    mixFiles: collectFingerprints(
      output,
      files(mix).filter((path) => path.endsWith('.mix')),
    ),
  };
  const prefix = 'wasm-coverage';

  if (proof.exit_code !== 0) {
    publish(root, output, prefix, proof);
    console.error(JSON.stringify({ output, errors, exitCode: proof.exit_code }));
    return proof.exit_code;
  }

  // The report reads the completed capture proof before the success pointer is published.
  const proofPath = join(output, 'proof.json');
  writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
  const reportPath = join(output, 'coverage.json');
  const reportCommand = [
    'node',
    'scripts/testing/coverage.mts',
    '--wasm-mix-dir',
    mix,
    '--wasm-proof',
    proofPath,
    '--output',
    reportPath,
    '--report-only',
    ...snapshots.flatMap((path) => ['--wasm-tix', path]),
  ];
  const code = await execute(reportCommand, 'report.log');
  if (code !== 0) {
    return code;
  }

  const result = object(jsonFile(reportPath));
  const reportErrors = list(result.errors);
  if (reportErrors.length === 0) {
    publish(root, output, prefix, proof);
  }

  console.log(
    JSON.stringify({
      output,
      snapshots: snapshots.length,
      wasmModules: list(result.wasm_hpc).length,
      errors: reportErrors,
      complete: result.complete,
    }),
  );
  return Number(reportErrors.length > 0);
}

runCli(import.meta.url, async () => {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      example: { type: 'string', multiple: true },
      'all-examples': { type: 'boolean' },
    },
  });

  if (values['all-examples'] && values.example) {
    throw new Error('Use --all-examples or --example, not both');
  }

  const selected = values['all-examples'] ? examples : (values.example ?? [library, urlShortener]);
  if (selected.some((name) => !examples.includes(name))) {
    throw new Error('Unknown WASM example');
  }

  return await collect(selected, evidencePath(root, 'wasm-coverage', values.output));
});
