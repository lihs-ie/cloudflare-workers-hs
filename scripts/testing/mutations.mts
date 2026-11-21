import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  absolutePath,
  digest,
  isFile,
  repositoryRoot,
  runCli,
  textFile,
  within,
  writeJson,
} from './Support/cli.mts';
import { runLogged } from './Support/async-command.mts';
import { evidencePath, trackedFiles } from './Support/evidence-io.mts';

const target = 'cloudflare-workers:test:unit';
const mutations = [
  ['http-method', 'HTTP.hs', 'methodToText GET = "GET"', 'methodToText GET = "POST"'],
  ['header-order', 'Headers.hs', '(flip (++))', '(++)'],
  ['kv-ttl', 'Binding/KV.hs', 'seconds >= 30', 'seconds >= 31'],
] as const;
const summary =
  /^\s*Passed:[ \t]*(\d+)(?:, Failed:[ \t]*|[ \t]*\n[ \t]*Failed:[ \t]*)(\d+)(?:[ \t]*\(|[ \t]*$)/gm;

type Verdict = 'error' | 'passed' | 'survived' | 'baseline-failed' | 'killed';

export function verdict(
  record: { output: string; exitCode: number; timed_out: boolean },
  baseline: boolean = false,
): Verdict {
  const matches = [...record.output.matchAll(summary)];
  if (record.timed_out || matches.length !== 1) {
    return 'error';
  }

  const passed = Number(matches[0][1]);
  const failed = Number(matches[0][2]);
  if (passed + failed === 0) {
    return 'error';
  }

  if (record.exitCode === 0 && failed === 0) {
    return baseline ? 'passed' : 'survived';
  }

  if (record.exitCode === 1 && failed > 0) {
    return baseline ? 'baseline-failed' : 'killed';
  }

  return 'error';
}

export function mutationSnapshot(root: string, directory: string): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of trackedFiles(root).filter((path) =>
    /^(cloudflare-workers|testing-support)\//.test(path),
  )) {
    const source = join(root, name);
    const copy = join(directory, name);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(source, copy);
    chmodSync(copy, statSync(source).mode & 0o777);
    digests[name] = digest(copy);
  }

  const project = join(root, 'cabal.project');
  const content = textFile(project);
  const stanza = /^packages:[^\n]*(?:\n[ \t]+[^\n]*)*/gm;
  if ([...content.matchAll(stanza)].length !== 1) {
    throw new Error('Expected exactly one packages stanza in cabal.project');
  }

  writeFileSync(
    join(directory, 'cabal.project'),
    content.replace(
      stanza,
      'packages: cloudflare-workers/cloudflare-workers.cabal\n  testing-support/testing-support.cabal',
    ),
  );
  digests['cabal.project'] = digest(project);
  return digests;
}

interface MutationReport {
  seed: number;
  status: string;
  commands: Record<string, unknown>[];
  mutations: { name: string; file: string; before: string; after: string; status: string }[];
  baseline?: { status: string };
  sources?: Record<string, string>;
  error?: string;
}

async function runMutations(
  output: string,
  seed: number,
  timeout: number,
  selected: Set<string>,
): Promise<number> {
  const tree = absolutePath(mkdtempSync(join(tmpdir(), 'workers-mutations-')));
  const report: MutationReport = { seed, status: 'incomplete', commands: [], mutations: [] };
  const env = {
    ...process.env,
    SYDTEST_RETRIES: '0',
    SYDTEST_GOLDEN_START: 'false',
    SYDTEST_GOLDEN_RESET: 'false',
  };
  const common = ['--enable-tests', '--project-file=cabal.project', '--builddir=dist-mutations'];
  const save = (): void => writeJson(join(output, 'results.json'), report);

  async function run(
    argv: string[],
    label: string,
  ): Promise<Awaited<ReturnType<typeof runLogged>>> {
    const log = `${String(report.commands.length).padStart(2, '0')}-${label}.log`;
    console.log('+ ' + argv.join(' '));
    const result = await runLogged(output, log, argv, { cwd: tree, env, timeout });
    report.commands.push({
      command: argv,
      label,
      log,
      logSha256: result.logSha256,
      timed_out: result.timed_out,
      exit_code: result.exitCode,
    });
    save();
    return result;
  }

  async function test(label: string): Promise<{ status: string }> {
    const built = await run(['cabal', 'build', target, ...common, '-j2'], label + '-build');
    if (built.exitCode !== 0) {
      return { status: 'build-error' };
    }

    const located = await run(['cabal', 'list-bin', target, ...common], label + '-binary');
    const binary = located.output.trim();
    if (
      located.exitCode !== 0 ||
      !isAbsolute(binary) ||
      !isFile(binary) ||
      !within(tree, absolutePath(binary))
    ) {
      return { status: 'binary-error' };
    }

    const result = await run(
      [
        binary,
        '--seed',
        String(seed),
        '--synchronous',
        '--terse',
        '--no-skip-passed',
        '--no-fail-fast',
        '--retries',
        '0',
        '--max-success',
        '100',
        '--no-golden-start',
        '--no-golden-reset',
      ],
      label + '-test',
    );
    return { status: verdict(result, label === 'baseline') };
  }

  try {
    report.sources = mutationSnapshot(repositoryRoot, tree);
    save();
    report.baseline = await test('baseline');

    if (report.baseline.status !== 'passed') {
      throw new Error('Baseline did not pass; mutations were not executed');
    }

    for (const [name, path, before, after] of mutations) {
      if (!selected.has(name)) {
        continue;
      }

      const file = join(tree, 'cloudflare-workers/src/Cloudflare/Workers', path);
      const original = textFile(file);
      if (original.split(before).length !== 2) {
        throw new Error(`${name}: expected exactly one original fragment`);
      }

      try {
        writeFileSync(file, original.replace(before, after));
        const result = await test(name);
        report.mutations.push({ name, file: relative(tree, file), before, after, ...result });
        console.log(name + ': ' + result.status);
      } finally {
        writeFileSync(file, original);
        save();
      }
    }

    report.status = report.mutations.every((item) => item.status === 'killed')
      ? 'passed'
      : 'failed';
  } catch (error) {
    report.status = 'error';
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    save();
    rmSync(tree, { recursive: true, force: true });
  }

  console.log('Evidence: ' + output);
  return report.status === 'passed' ? 0 : 1;
}

runCli(
  import.meta.url,
  '[--mutation NAME]... [--seed N] [--timeout SECONDS] [--output DIR]',
  async () => {
    const { values } = parseArgs({
      options: {
        output: { type: 'string' },
        seed: { type: 'string', default: '73' },
        timeout: { type: 'string', default: '1800' },
        mutation: { type: 'string', multiple: true },
      },
    });
    const seed = Number(values.seed);
    const timeout = Number(values.timeout);
    if (
      !Number.isSafeInteger(seed) ||
      !Number.isSafeInteger(timeout) ||
      timeout <= 0 ||
      timeout > 2_147_483
    ) {
      throw new Error('Expected an integer seed and a positive timeout in seconds');
    }

    const names = mutations.map(([name]) => name);
    const selected = new Set(values.mutation ?? names);
    if ([...selected].some((name) => !names.some((entry) => entry === name))) {
      throw new Error('Unknown mutation');
    }

    return await runMutations(
      evidencePath(repositoryRoot, 'mutations', values.output),
      seed,
      timeout * 1000,
      selected,
    );
  },
);
