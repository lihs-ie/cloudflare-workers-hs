import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { digest, files, isFile, repositoryRoot, runCli, writeJson } from './Support/cli.mts';
import { hostCoverageArguments, otherCoverageArguments } from './Support/coverage-inputs.mts';
import {
  equals,
  evidencePath,
  loggedCommand,
  sourceSnapshot,
  type Sources,
} from './Support/evidence-io.mts';
import { collectHost, testEnvironment } from './Support/host-coverage.mts';
import { successfulSummaries } from './Support/hpc.mts';

const root = repositoryRoot;
const urlShortener = join(root, 'examples/url-shortener');
const runtime = join(root, 'tests/runtime');
export const otherExamples = [
  'api-catalog',
  'queued-jobs',
  'minimal',
  'static-assets',
  'realtime',
  'workflows',
];
const model = 'runtime-contracts:test:model';
const conformance = 'servant-cloudflare-workers:test:conformance';
const host = [
  'cloudflare-workers:test:unit',
  'cloudflare-workers:test:host-testkit-unit',
  'servant-cloudflare-workers:test:unit',
  'servant-cloudflare-workers-client:test:unit',
  'servant-cloudflare-workers-access:test:unit',
  'url-shortener:test:unit',
  'conformance-oracle:test:unit',
  'url-shortener-domain:test:unit',
  'url-shortener-management:test:unit',
  'testing-support:test:integration',
  'workflow-example:test:unit',
  'minimal-worker:test:unit',
  'static-assets-worker:test:unit',
  'realtime-worker:test:unit',
];

const flag = { type: 'boolean', default: false } as const;
const options = {
  seed: { type: 'string', default: '42' },
  examples: { type: 'string', default: '100' },
  target: { type: 'string' },
  match: { type: 'string' },
  'host-proof': { type: 'string' },
  'compile-proof': { type: 'string' },
  'native-compile-proof': { type: 'string' },
  'shell-json': { type: 'string' },
  'report-only': flag,
  'skip-runtime-build': flag,
} as const;

type Args = ReturnType<
  typeof parseArgs<{ options: typeof options; allowPositionals: true }>
>['values'];
type Run = (argv: readonly string[], cwd?: string) => number;
interface Context {
  run: Run;
  output: string;
  sources: Sources;
  buildRuntime: boolean;
  runCabal: (targets: string[]) => number;
}

export function integrationTests(root: string, example: string): string[] {
  const directory = join(root, 'examples', example, 'test/integration');
  const tests = files(directory).filter(
    (file) =>
      file.endsWith('.spec.mts') && file.slice(directory.length + 1).split('/').length === 1,
  );
  if (tests.length === 0) {
    throw new Error('No integration tests found for ' + example);
  }

  return tests;
}

function javascriptProof(directory: string, context: Context): void {
  const report = join(directory, 'coverage-final.json');
  if (isFile(report) && equals(context.sources, sourceSnapshot(root))) {
    writeJson(join(directory, 'run-proof.json'), {
      sources: context.sources,
      sha256: digest(report),
      exit_code: 0,
      run: relative(root, context.output),
    });
  }
}

function runIntegration(context: Context, lane: 'model' | 'integration'): number {
  const { run, buildRuntime, runCabal } = context;

  if (buildRuntime) {
    const built = run(['pnpm', 'run', 'build:runtime'], runtime);
    if (built !== 0) {
      return built;
    }

    if (lane === 'integration') {
      const builtExample = run(['pnpm', 'run', 'build:runtime'], urlShortener);
      if (builtExample !== 0) {
        return builtExample;
      }
    }
  }

  if (lane === 'model') {
    const bundle = run(['pnpm', 'run', 'build:model'], runtime);
    return bundle || runCabal([model]);
  }

  const codes = [runtime, urlShortener].map((directory) => {
    const result = run(['pnpm', 'run', 'test:runtime:coverage'], directory);
    if (result === 0) {
      javascriptProof(join(directory, 'test-artifacts/coverage/runtime'), context);
    }

    return result;
  });
  const production = run(['bash', 'scripts/build-wasm.sh'], urlShortener);
  if (production !== 0) {
    return firstFailure([...codes, production]);
  }

  const productionTests = run(['pnpm', 'run', 'test:integration', '--coverage'], urlShortener);
  if (productionTests === 0) {
    javascriptProof(join(urlShortener, 'test-artifacts/coverage/production'), context);
  }

  return firstFailure([...codes, productionTests]);
}

function buildExample(run: Run, example: string): number {
  return (
    run(['bash', `examples/${example}/scripts/build.sh`]) ||
    run(['node', 'scripts/testing/typecheck.mts', example])
  );
}

function runDev(run: Run, lane: 'dev' | 'docker'): number {
  const first =
    run(['bash', 'scripts/build-wasm.sh', 'runtime-tests'], urlShortener) ||
    run(['bash', 'scripts/build-wasm.sh'], urlShortener);
  if (first !== 0) {
    return first;
  }

  if (lane === 'docker') {
    const urlTypes = run(['node', 'scripts/testing/typecheck.mts', 'url-shortener']);
    if (urlTypes !== 0) {
      return urlTypes;
    }

    for (const example of otherExamples) {
      const built = buildExample(run, example);
      if (built !== 0) {
        return built;
      }
    }
  }

  return run(['pnpm', 'run', 'test:' + lane], urlShortener);
}

function firstFailure(codes: number[]): number {
  return codes.find((code) => code !== 0) ?? 0;
}

function runCoverage(context: Context, args: Args, env: NodeJS.ProcessEnv): number {
  const { run, buildRuntime, output, sources } = context;
  const codes: number[] = [];
  let path = args['host-proof'];
  if (path === undefined) {
    const build =
      (buildRuntime ? run(['pnpm', 'run', 'build:runtime'], runtime) : 0) ||
      run(['pnpm', 'run', 'build:model'], runtime);
    codes.push(build);
    const hostOutput = join(output, 'host');
    const proof = collectHost({
      root,
      output: hostOutput,
      targets: [...host, conformance, ...(build === 0 ? [model] : [])],
      snapshot: () => sourceSnapshot(root),
      match: args.match,
      environment: env,
    });
    codes.push(proof.exit_code);
    path = join(hostOutput, 'proof.json');
  }

  const hostArgs = hostCoverageArguments(root, path, sources);
  if (hostArgs.length === 0) {
    console.error('Host coverage evidence is incomplete or invalid; refusing it.');
    codes.push(1);
  }

  const others = otherCoverageArguments(root, sources, {
    compile: args['compile-proof'],
    nativeCompile: args['native-compile-proof'],
    shell: args['shell-json'],
  });
  codes.push(
    run([
      'node',
      'scripts/testing/coverage.mts',
      '--output',
      join(output, 'coverage.json'),
      ...hostArgs,
      ...others,
      ...(args['report-only'] ? ['--report-only'] : []),
    ]),
  );
  return firstFailure(codes);
}

function dispatch(lane: string, context: Context, args: Args, env: NodeJS.ProcessEnv): number {
  const { run, runCabal } = context;
  switch (lane) {
    case 'host':
      return runCabal(host);
    case 'conformance':
      return runCabal([conformance]);
    case 'replay':
      if (!args.target) {
        throw new Error('Replay requires --target');
      }

      return runCabal([args.target]);
    case 'integration':
    case 'model':
      return runIntegration(context, lane);
    case 'dev':
    case 'docker':
      return runDev(run, lane);
    case 'coverage':
      return runCoverage(context, args, env);
    default:
      if (!otherExamples.includes(lane)) {
        throw new Error('Unknown test lane: ' + lane);
      }

      return (
        buildExample(run, lane) ||
        run(['node', '--test', '--test-concurrency=1', ...integrationTests(root, lane)])
      );
  }
}

function checkedNumber(input: string, name: string, positive: boolean = false): number {
  const number = Number(input);
  if (!/^-?\d+$/.test(input) || !Number.isSafeInteger(number) || (positive && number <= 0)) {
    throw new Error('Invalid ' + name);
  }

  return number;
}

function runLane(lane: string, args: Args): number {
  const seed = checkedNumber(args.seed, '--seed');
  const examples = checkedNumber(args.examples, '--examples', true);
  const output = evidencePath(root, lane);
  const sources = sourceSnapshot(root);
  const env = {
    ...testEnvironment(),
    SYDTEST_SEED: String(seed),
    SYDTEST_MAX_SUCCESS: String(examples),
    SYDTEST_RETRIES: '0',
    SYDTEST_GOLDEN_START: 'False',
    SYDTEST_GOLDEN_RESET: 'False',
    SYDTEST_COLOUR: 'False',
    SYDTEST_SKIP_PASSED: 'False',
  };
  const records: Record<string, unknown>[] = [];
  let lastLog = '';

  const run: Run = (command, cwd = root) => {
    const log = String(records.length).padStart(2, '0') + '.log';
    const result = loggedCommand(output, log, command, { cwd, env }, true);
    lastLog = result.stdout;
    records.push({ command, cwd: relative(root, cwd) || '.', log, exit_code: result.code });
    writeJson(join(output, 'run.json'), {
      lane,
      seed,
      examples,
      report_only: args['report-only'],
      sources,
      commands: records,
    });
    return result.code;
  };

  function runCabal(targets: string[]): number {
    const command = [
      'cabal',
      'test',
      ...targets,
      '--project-file=cabal.project',
      '--builddir=dist-testing',
      '-j2',
      '--keep-going',
      '--test-show-details=direct',
    ];

    if (args.match !== undefined) {
      command.push('--test-options=--match ' + JSON.stringify(args.match));
    }

    const code = run(command);
    if (code === 0 && !successfulSummaries(lastLog, targets.length)) {
      console.error('Missing, empty or failed runner summary; refusing a successful Cabal exit.');
      return 1;
    }

    return code;
  }

  const code = dispatch(
    lane,
    { run, output, sources, buildRuntime: !args['skip-runtime-build'], runCabal },
    args,
    env,
  );
  const current = sourceSnapshot(root);
  console.log('Evidence: ' + output);

  if (!equals(sources, current)) {
    const changes = [...new Set([...Object.keys(sources), ...Object.keys(current)])]
      .filter((name) => sources[name] !== current[name])
      .sort();
    writeJson(join(output, 'changed-inputs.json'), changes);
    console.error('Source/config inputs changed during validation; rerun against a stable tree.');
    return code || 1;
  }

  return code;
}

runCli(
  import.meta.url,
  '<host|conformance|integration|model|coverage|replay|dev|docker|EXAMPLE>\n  [--seed N] [--examples N] [--target CABAL_TARGET] [--match FILTER]\n  [--skip-runtime-build] [--report-only] [--host-proof FILE]\n  [--compile-proof FILE] [--native-compile-proof FILE] [--shell-json FILE]',
  () => {
    const { values, positionals } = parseArgs({ options, allowPositionals: true });

    if (
      positionals.length !== 1 ||
      ![
        ...otherExamples,
        'host',
        'conformance',
        'replay',
        'model',
        'integration',
        'dev',
        'docker',
        'coverage',
      ].includes(positionals[0])
    ) {
      throw new Error('Specify one valid test lane');
    }

    return runLane(positionals[0], values);
  },
);
