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
import {
  collectFingerprints,
  equals,
  evidencePath,
  loggedCommand,
  publish,
  recordCommand,
  sourceSnapshot,
  type CommandEvidence,
  type Sources,
} from './Support/evidence-io.mts';
import { canonicalV8Files } from './Support/v8-queries.mts';
import { object, string } from './Support/validation.mts';
import { integrationTests, otherExamples } from './run.mts';
import { contractSpecs } from './shared-node-coverage.mts';

const root = repositoryRoot;
const examples = [
  'minimal',
  'static-assets',
  'realtime',
  'workflows',
  'api-catalog',
  'queued-jobs',
  'url-shortener',
];
const prefixes = [
  'examples/',
  'scripts/testing/',
  'tests/runtime/',
  'cloudflare-workers/test/',
  'servant-cloudflare-workers/test/',
  'servant-cloudflare-workers-client/test/',
  'servant-cloudflare-workers-access/test/',
];
const boundarySources = new Set([
  'examples/static-assets/public/app.js',
  'examples/api-catalog/test/Support/Remote/ssec-evidence.ts',
  'examples/api-catalog/test/Support/Remote/ssec-probe.ts',
  'examples/api-catalog/test/Support/Remote/cleanup-probe.ts',
  'examples/url-shortener/test/Support/Dev/gateway.ts',
]);

export function nodeSources(sources: Sources, toolsOnly: boolean = false): string[] {
  return Object.keys(sources)
    .filter((name) => {
      if (toolsOnly) {
        return name.startsWith('scripts/testing/') && name.endsWith('.mts');
      }

      return (
        (boundarySources.has(name) ||
          (prefixes.some((prefix) => name.startsWith(prefix)) && /\.(mts|mjs)$/.test(name))) &&
        !name.includes('/worker/') &&
        !name.endsWith('.d.mts') &&
        !name.endsWith('-jsffi.mjs')
      );
    })
    .sort();
}

export function commandsFor(example: string): string[][] {
  const contracts = contractSpecs(root, `examples/${example}/test/Support`, () => true);
  const contractRun = [
    'node',
    '--experimental-test-module-mocks',
    '--test',
    '--test-concurrency=1',
    ...contracts,
  ];

  if (example === 'url-shortener') {
    return [
      contractRun,
      ['pnpm', '--dir', 'examples/url-shortener', 'test:dev'],
      ['node', 'scripts/testing/run.mts', 'model', '--skip-runtime-build'],
      ['node', 'scripts/testing/run.mts', 'integration', '--skip-runtime-build'],
      [
        'node',
        '--test',
        'tests/runtime/model/storage-bridge.spec.mts',
        'tests/runtime/test/Support/harness-contract.spec.mts',
      ],
    ];
  }

  const tests = integrationTests(root, example).map((path) => relative(root, path));
  return [
    ['node', '--test', '--test-concurrency=1', ...tests],
    ...(contracts.length > 0 ? [contractRun] : []),
  ];
}

function toolsCommands(only: boolean): string[][] {
  const specs = [
    ...contractSpecs(root, 'scripts/testing/test', () => true),
    ...contractSpecs(root, 'cloudflare-workers/test/Support', () => true),
  ];
  const tests = ['node', '--experimental-test-module-mocks', '--test', ...specs];
  return only
    ? [tests]
    : [
        tests,
        ['node', 'scripts/testing/typecheck.mts', '--check'],
        ['node', 'scripts/testing/git-runtime-consumer.mts'],
      ];
}

function collect(output: string, selected: string[], tools: boolean, only: boolean): number {
  const prefix = only ? 'tools-coverage' : 'example-node-coverage';
  const sources = sourceSnapshot(root);
  const node = nodeSources(sources, only);
  const raw = join(output, 'raw');
  mkdirSync(raw);
  const env = { ...process.env, NODE_V8_COVERAGE: raw };
  const proof = {
    sources,
    commands: [] as CommandEvidence[],
    errors: [] as string[],
    exit_code: 1,
    nodeSources: node,
    queryProvenance: [] as Record<string, unknown>[],
    raw: {} as Record<string, string>,
    sha256: null as string | null,
    collector: { name: 'c8', version: '' },
  };
  const report = join(output, 'report/coverage-final.json');
  try {
    const commands = selected.flatMap((example) =>
      commandsFor(example).map((command) => ({ label: example, command })),
    );

    if (tools) {
      commands.push(...toolsCommands(only).map((command) => ({ label: 'tools', command })));
    }

    for (const [index, { label, command }] of commands.entries()) {
      const result = loggedCommand(output, `${label}-${index}.log`, command, { cwd: root, env });
      proof.commands.push(recordCommand(result));

      if (result.code !== 0) {
        throw new Error(`Test command failed: ${label} (see ${result.log})`);
      }
    }

    const canonical = join(output, 'canonical-raw');
    proof.queryProvenance = canonicalV8Files(root, raw, canonical, sources, new Set(node));

    if (proof.queryProvenance.length === 0) {
      throw new Error('Missing raw Node evidence');
    }

    proof.raw = collectFingerprints(
      output,
      files(raw).filter((path) => path.endsWith('.json')),
    );
    const config = join(output, 'c8.json');
    writeJson(config, {
      all: true,
      include: node,
      exclude: [],
      src: only ? ['scripts/testing'] : prefixes,
      extension: ['.mjs', '.mts', '.js', '.ts'],
      reporter: ['json', 'text', 'html'],
      'temp-directory': canonical,
      'reports-dir': join(output, 'report'),
    });
    const c8 = join(root, 'node_modules/c8');
    proof.collector.version = string(object(jsonFile(join(c8, 'package.json'))).version);
    const rendered = loggedCommand(
      output,
      'report.log',
      ['node', join(c8, 'bin/c8.js'), '--config', config, 'report'],
      { cwd: root },
    );
    if (rendered.code !== 0 || !isFile(report)) {
      throw new Error('c8 report failed');
    }

    proof.sha256 = digest(report);

    if (!equals(sources, sourceSnapshot(root))) {
      throw new Error('Source inputs changed during collection');
    }

    proof.exit_code = 0;
  } catch (error) {
    proof.errors.push(error instanceof Error ? error.message : String(error));
  }

  publish(root, output, prefix, proof, report);
  console.log(JSON.stringify({ output, errors: proof.errors, nodeSources: node.length }));
  return proof.exit_code;
}

runCli(import.meta.url, () => {
  const { values } = parseArgs({
    options: {
      output: { type: 'string' },
      example: { type: 'string', multiple: true },
      tools: { type: 'boolean' },
      'tools-only': { type: 'boolean' },
    },
  });

  if (values['tools-only'] && values.example) {
    throw new Error('Use --tools-only or --example, not both');
  }

  const only = values['tools-only'] ?? false;
  const selected = only ? [] : (values.example ?? examples);
  if (selected.some((name) => !otherExamples.includes(name) && name !== 'url-shortener')) {
    throw new Error('Unknown example');
  }

  const path = evidencePath(root, only ? 'tools-coverage' : 'example-node-coverage', values.output);
  return collect(path, selected, only || values.tools === true, only);
});
