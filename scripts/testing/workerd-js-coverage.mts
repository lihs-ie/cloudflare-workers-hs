import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  digest,
  files,
  isFile,
  jsonFile,
  repositoryRoot,
  runCli,
  writeJson,
} from './Support/cli.mts';
import { runLogged } from './Support/async-command.mts';
import { manifestSchema, snapshotSchema, type CoverageEntry } from './Support/coverage-schema.mts';
import {
  collectFingerprints,
  equals,
  evidencePath,
  loggedCommand,
  publish,
  recordCommand,
  sourceSnapshot,
  type CommandEvidence,
} from './Support/evidence-io.mts';
import { withSnapshotServer } from './Support/snapshot-server.mts';
import { nonnegative, string } from './Support/validation.mts';
import { integrationTests, otherExamples } from './run.mts';

const root = repositoryRoot;

interface Snapshot {
  bundle: string;
  isolate: string;
  sequence: number;
  coverage: Record<string, CoverageEntry>;
}

function readSnapshot(value: unknown): Snapshot {
  const parsed = snapshotSchema.parse(value);
  const bundle = string(parsed.bundle);
  const isolate = string(parsed.isolate).toLowerCase();
  const sequence = nonnegative(parsed.sequence);
  if (
    !/^[0-9a-f]{16}$/.test(bundle) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(isolate) ||
    sequence === 0
  ) {
    throw new Error('Invalid coverage snapshot identity');
  }

  return { bundle, isolate, sequence, coverage: parsed.coverage };
}

function verifyCounters(
  next: Record<string, number | number[]>,
  previous: Record<string, number | number[]>,
  cumulative: boolean,
): void {
  if (!equals(Object.keys(next).sort(), Object.keys(previous).sort())) {
    throw new Error('Counter keys changed');
  }

  for (const [identifier, value] of Object.entries(next)) {
    const expected = previous[identifier];
    if (Array.isArray(value) !== Array.isArray(expected)) {
      throw new Error('Invalid counter shape');
    }

    const hits = Array.isArray(value) ? value : [value];
    const prior = Array.isArray(expected) ? expected : [expected];
    if (hits.length !== prior.length) {
      throw new Error('Invalid branch arity');
    }

    if (hits.some((count, index) => nonnegative(count) < (cumulative ? prior[index] : 0))) {
      throw new Error('Cumulative counter regressed');
    }
  }
}

export function acceptSnapshot(
  output: string,
  received: Map<string, Snapshot>,
  body: string,
): void {
  const next = readSnapshot(JSON.parse(body));
  const manifest = manifestSchema.parse(
    jsonFile(join(output, 'bundles', next.bundle, 'manifest.json')),
  );
  const entries = Object.entries(next.coverage);
  if (entries.length === 0) {
    throw new Error('Empty coverage snapshot');
  }

  for (const [name, value] of entries) {
    const expected = manifest[name]?.coverage;
    if (
      expected === undefined ||
      !(['path', 'statementMap', 'branchMap', 'fnMap', 'inputSourceMap'] as const).every((key) =>
        equals(value[key], expected[key]),
      )
    ) {
      throw new Error('Instrumentation map changed');
    }

    for (const key of ['s', 'f', 'b'] as const) {
      verifyCounters(value[key], expected[key], false);
    }
  }

  const key = next.bundle + '-' + next.isolate;
  const previous = received.get(key);
  if (previous !== undefined && next.sequence <= previous.sequence) {
    if (next.sequence === previous.sequence && !equals(previous, next)) {
      throw new Error('Conflicting duplicate snapshot');
    }

    return;
  }

  if (previous !== undefined) {
    for (const [name, entry] of Object.entries(previous.coverage)) {
      const fresh = next.coverage[name];
      if (fresh === undefined) {
        throw new Error('Cumulative snapshot lost a source');
      }

      for (const lane of ['s', 'f', 'b'] as const) {
        verifyCounters(fresh[lane], entry[lane], true);
      }
    }
  }

  writeJson(join(output, 'snapshots', key + '.json'), next);
  received.set(key, next);
}

async function collect(output: string, examples: string[]): Promise<number> {
  const sources = sourceSnapshot(root);
  const errors: string[] = [];
  const commands: CommandEvidence[] = [];
  const received = new Map<string, Snapshot>();
  const snapshots = join(output, 'snapshots');
  mkdirSync(snapshots);
  try {
    await withSnapshotServer(
      (body) => acceptSnapshot(output, received, body),
      errors,
      async (endpoint) => {
        const env = {
          ...process.env,
          WORKERD_JS_COVERAGE_ENDPOINT: endpoint,
          WORKERD_JS_COVERAGE_DIRECTORY: output,
        };
        for (const example of examples) {
          const before = received.size;
          const argv = [
            'node',
            '--test',
            '--test-concurrency=1',
            ...integrationTests(root, example).map((path) => relative(root, path)),
          ];
          const result = await runLogged(output, example + '.log', argv, { cwd: root, env });
          commands.push(recordCommand(result));

          if (result.exitCode !== 0 || received.size === before) {
            throw new Error('Failed tests or no snapshots: ' + example);
          }
        }
      },
    );
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const report = join(output, 'coverage-final.json');
  const conversion = loggedCommand(
    output,
    'report.log',
    ['node', 'scripts/testing/Support/workerd_js_report.mts', output],
    { cwd: root },
  );
  if (conversion.code !== 0 || !isFile(report)) {
    errors.push('Workerd coverage report failed');
  }

  if (!equals(sources, sourceSnapshot(root))) {
    errors.push('Sources changed during collection');
  }

  const proof = {
    sources,
    exit_code: Number(errors.length > 0),
    errors,
    commands,
    sha256: isFile(report) ? digest(report) : null,
    snapshots: collectFingerprints(
      output,
      files(snapshots).filter((path) => path.endsWith('.json')),
    ),
    manifests: collectFingerprints(
      output,
      files(join(output, 'bundles')).filter((path) => path.endsWith('/manifest.json')),
    ),
    semantics: 'Latest cumulative snapshot per bundle/isolate; never sum successive snapshots',
  };
  publish(root, output, 'workerd-js-coverage', proof, report);
  console.log(JSON.stringify({ output, errors, isolates: received.size }));
  return proof.exit_code;
}

runCli(import.meta.url, async () => {
  const { values } = parseArgs({
    options: { output: { type: 'string' }, example: { type: 'string', multiple: true } },
  });
  const names = values.example ?? otherExamples;
  if (names.some((name) => !otherExamples.includes(name))) {
    throw new Error('Unknown workerd example');
  }

  return await collect(evidencePath(root, 'workerd-js-coverage', values.output), names);
});
