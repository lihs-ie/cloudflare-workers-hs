import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { mergeReports, validateMergedReport } from '../Support/shared_js_report.mts';
import type { CoverageEntry, InstrumentationManifest } from '../Support/coverage-schema.mts';
import { jsonValue, coverageEntrySchema } from '../Support/coverage-schema.mts';
import { z } from 'zod';

function hash(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface RawInput {
  source: string;
  kind: string;
  manifest: InstrumentationManifest;
  snapshot: { coverage: Record<string, CoverageEntry> };
  proof: {
    sources: Record<string, string>;
    exit_code: number;
    errors: unknown[];
    commands: { command: string[]; exitCode: number; log: string; logSha256: string }[];
    sha256: string;
    manifests: Record<string, string>;
    snapshots: Record<string, string>;
  };
}

type Mutation = (input: RawInput) => void;

async function fixture(
  context: TestContext,
  mutate: Mutation = () => {},
): Promise<{
  root: string;
  source: string;
  run(): ReturnType<typeof mergeReports>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'coverage-evidence-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.js');
  await writeFile(source, 'export const value = 1;');
  const sourceHash = hash(await readFile(source));
  const identity = 'a'.repeat(64);

  for (const kind of ['workerd', 'node']) {
    const directory = path.join(root, kind);
    await mkdir(directory);
    const entry: CoverageEntry = {
      path: source,
      statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 22 } } },
      fnMap: {},
      branchMap: {},
      s: { 0: 0 },
      f: {},
      b: {},
    };
    const input: RawInput = {
      kind,
      source,
      manifest: { [source]: { sha256: sourceHash, instrumentation: identity, coverage: entry } },
      snapshot: { coverage: { [source]: { ...entry, s: { 0: kind === 'workerd' ? 2 : 3 } } } },
      proof: {
        sources: { 'source.js': sourceHash },
        exit_code: 0,
        errors: [],
        commands: [
          { command: ['node', 'test'], exitCode: 0, log: 'test.log', logSha256: hash('passed') },
        ],
        sha256: hash('{}'),
        manifests: {},
        snapshots: {},
      },
    };
    mutate(input);
    for (const [filename, value, records] of [
      ['manifest.json', input.manifest, input.proof.manifests],
      ['snapshot.json', input.snapshot, input.proof.snapshots],
    ] as const) {
      const bytes = JSON.stringify(value);
      await writeFile(path.join(directory, filename), bytes);
      records[filename] = hash(bytes);
    }
    await writeFile(path.join(directory, 'test.log'), 'passed');
    await writeFile(path.join(directory, 'coverage-final.json'), '{}');
    await writeFile(path.join(directory, 'proof.json'), JSON.stringify(input.proof));
  }

  return {
    root,
    source,
    run: () =>
      mergeReports(path.join(root, 'workerd'), path.join(root, 'node'), path.join(root, 'merged'), {
        root,
        expectedIdentity: identity,
      }),
  };
}

void test('merges identical instrumentation counters and retains separate workerd results', async (context) => {
  const { root, source, run } = await fixture(context);
  const proof = await run();
  const parseReport = z.record(z.string(), coverageEntrySchema);
  const combined = parseReport.parse(
    jsonValue(await readFile(path.join(root, 'merged/coverage-final.json'))),
  );
  const workerd = parseReport.parse(
    jsonValue(await readFile(path.join(root, 'merged/workerd-only.json'))),
  );

  assert.equal(combined[source].s[0], 5);
  assert.equal(workerd[source].s[0], 2);
  assert.equal(proof.inputs.length, 2);
  await validateMergedReport(path.join(root, 'merged/proof.json'), {
    root,
    expectedIdentity: 'a'.repeat(64),
  });
  await assert.rejects(run(), /EEXIST/);
});

const mutations: [string, Mutation, RegExp][] = [
  [
    'failed run',
    ({ proof }) => {
      proof.exit_code = 1;
    },
    /failed/,
  ],
  [
    'boolean exit',
    ({ proof }) => {
      Reflect.set(proof.commands[0], 'exitCode', false);
    },
    /exitCode/,
  ],
  [
    'missing command',
    ({ proof }) => {
      proof.commands = [];
    },
    /commands/,
  ],
  [
    'changed log',
    ({ proof }) => {
      proof.commands[0].logSha256 = '0'.repeat(64);
    },
    /Hash/,
  ],
  [
    'escaped log',
    ({ proof }) => {
      proof.commands[0].log = '../source.js';
    },
    /escapes/,
  ],
  [
    'wrong source',
    ({ manifest, source }) => {
      manifest[source].sha256 = '0'.repeat(64);
    },
    /authenticated/,
  ],
  [
    'missing identity',
    ({ manifest, source }) => {
      Reflect.deleteProperty(manifest[source], 'instrumentation');
    },
    /instrumentation/,
  ],
  [
    'mixed compiler',
    ({ kind, manifest, source }) => {
      if (kind === 'node') {
        manifest[source].instrumentation = 'b'.repeat(64);
      }
    },
    /identity/,
  ],
  [
    'negative counter',
    ({ snapshot, source }) => {
      snapshot.coverage[source].s[0] = -1;
    },
    /counter/,
  ],
  [
    'boolean counter',
    ({ snapshot, source }) => {
      Reflect.set(snapshot.coverage[source].s, '0', true);
    },
    /number/,
  ],
  [
    'counter keys',
    ({ snapshot, source }) => {
      snapshot.coverage[source].s[1] = 1;
    },
    /keys/,
  ],
  [
    'empty snapshot',
    ({ snapshot }) => {
      snapshot.coverage = {};
    },
    /Empty/,
  ],
  [
    'unknown source',
    ({ snapshot, source }) => {
      snapshot.coverage[source + 'x'] = snapshot.coverage[source];
    },
    /manifest/,
  ],
  [
    'changed map',
    ({ snapshot, source }) => {
      snapshot.coverage[source].statementMap = {};
    },
    /maps/,
  ],
];

for (const [name, mutate, expected] of mutations) {
  void test(`rejects ${name}`, async (context) => {
    const { run } = await fixture(context, mutate);

    await assert.rejects(run(), expected);
  });
}

void test('rejects source changes after collection and merged report tampering', async (context) => {
  const { root, source, run } = await fixture(context);
  await run();
  await writeFile(path.join(root, 'merged/coverage-final.json'), '{}');

  await assert.rejects(
    validateMergedReport(path.join(root, 'merged/proof.json'), {
      root,
      expectedIdentity: 'a'.repeat(64),
    }),
    /Hash/,
  );

  await writeFile(source, 'changed source');
  await assert.rejects(run(), /Hash/);
});
