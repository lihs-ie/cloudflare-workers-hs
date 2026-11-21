import { mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { digest, files, isFile, repositoryRoot, runCli, writeJson } from './Support/cli.mts';
import {
  collectFingerprints,
  equals,
  evidencePath,
  loggedCommand,
  recordCommand,
  sourceSnapshot,
  type CommandEvidence,
  type Sources,
} from './Support/evidence-io.mts';

const root = repositoryRoot;

export function contractSpecs(
  root: string,
  directory: string,
  select: (file: string) => boolean,
): string[] {
  return files(
    join(root, directory),
    (name) =>
      ['node_modules', '.wrangler', 'test-artifacts'].includes(name) ||
      name.startsWith('.dev-test-'),
  )
    .filter((file) => file.endsWith('.spec.mts') && select(file))
    .map((file) => relative(root, file));
}

export function contractCommands(root: string): string[][] {
  const tests = new Set([
    ...contractSpecs(root, 'examples', (file) =>
      /\/test\/Support\/.*contract.*\.spec\.mts$/.test(file),
    ),
    ...contractSpecs(root, 'scripts/testing/test', () => true),
    ...contractSpecs(root, 'cloudflare-workers/test/Support', () => true),
    'tests/runtime/model/storage-bridge.spec.mts',
    ...contractSpecs(root, 'tests/runtime/test/Support', () => true),
    'examples/api-catalog/test/integration/log-records.spec.mts',
  ]);
  return [...tests]
    .sort()
    .map((file) => [
      'node',
      '--import',
      join(root, 'scripts/testing/Support/node_shared_coverage.mts'),
      '--experimental-test-module-mocks',
      '--test',
      '--test-concurrency=1',
      file,
    ]);
}

function collect(output: string, sources: Sources): string[] {
  mkdirSync(output);
  const bundles = join(output, 'bundles');
  const snapshotPath = join(output, 'snapshots');
  mkdirSync(bundles);
  mkdirSync(snapshotPath);

  const inputs = join(output, 'inputs.json');
  writeJson(inputs, Object.keys(sources).sort());
  const preload = pathToFileURL(
    join(root, 'scripts/testing/Support/node_shared_coverage.mts'),
  ).href;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SHARED_JS_COVERAGE_DIRECTORY: output,
    SHARED_JS_COVERAGE_INPUTS: inputs,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`.trim(),
  };
  delete env.NODE_V8_COVERAGE;
  const errors: string[] = [];
  const commands: CommandEvidence[] = [];
  for (const [index, argv] of contractCommands(root).entries()) {
    const result = loggedCommand(output, `contract-${index}.log`, argv, { cwd: root, env });
    commands.push(recordCommand(result));

    if (result.code !== 0) {
      errors.push('Node boundary command failed: ' + argv.at(-1));
      break;
    }
  }

  const manifests = collectFingerprints(
    output,
    files(bundles).filter((path) => path.endsWith('/manifest.json')),
  );
  const snapshots = collectFingerprints(
    output,
    files(snapshotPath).filter((path) => path.endsWith('.json')),
  );
  if (Object.keys(manifests).length === 0 || Object.keys(snapshots).length === 0) {
    errors.push('Missing shared instrumentation manifests or snapshots');
  }

  const result = loggedCommand(
    output,
    'report.log',
    ['node', 'scripts/testing/Support/workerd_js_report.mts', output],
    { cwd: root },
  );
  const report = join(output, 'coverage-final.json');
  if (result.code !== 0 || !isFile(report)) {
    errors.push('Shared instrumentation report failed');
  }

  if (!equals(sourceSnapshot(root), sources)) {
    errors.push('Sources changed during shared Node collection');
  }

  writeJson(join(output, 'proof.json'), {
    sources,
    errors,
    commands,
    manifests,
    snapshots,
    exit_code: Number(errors.length > 0),
    sha256: isFile(report) ? digest(report) : null,
    semantics:
      'Node boundary doubles; same authored TypeScript instrumenter as workerd, not Cloudflare execution',
  });
  return errors;
}

runCli(import.meta.url, '--workerd DIR [--output DIR]', () => {
  const { values } = parseArgs({
    options: { output: { type: 'string' }, workerd: { type: 'string' } },
  });

  if (!values.workerd) {
    throw new Error('Shared coverage requires --workerd');
  }

  const output = evidencePath(root, 'shared-js-coverage', values.output);
  const node = join(output, 'node');
  const errors = collect(node, sourceSnapshot(root));
  if (errors.length > 0) {
    console.error(JSON.stringify({ output, errors }));
    return 1;
  }

  const combined = join(output, 'combined');
  const merged = loggedCommand(
    output,
    'shared-report.log',
    [
      'node',
      'scripts/testing/Support/shared_js_report.mts',
      resolve(values.workerd),
      node,
      combined,
    ],
    { cwd: root },
    true,
  );
  if (merged.code !== 0) {
    return merged.code;
  }

  const proof = join(combined, 'proof.json');
  writeJson(join(root, 'artifacts/testing/shared-js-coverage-latest.json'), {
    report: relative(root, join(combined, 'coverage-final.json')),
    proof: relative(root, proof),
    proofSha256: digest(proof),
    workerdOnly: relative(root, join(combined, 'workerd-only.json')),
  });
  console.log(JSON.stringify({ output, errors: [] }));
  return 0;
});
