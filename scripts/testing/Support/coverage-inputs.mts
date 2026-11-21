import { dirname, join, resolve } from 'node:path';
import { jsonFile } from './cli.mts';
import {
  childPath,
  commandProof,
  readPointer,
  successfulProof,
  verifiedFile,
  verifiedFiles,
  type Sources,
} from './evidence-io.mts';
import { hpcProof, validJavascriptProof } from './proof-inputs.mts';
import { verifiedSharedJavascript } from './runtime-evidence.mts';
import { validateV8Files } from './v8-queries.mts';
import { list, nonnegative, object, string, strings } from './validation.mts';

function optional(read: () => string[]): string[] {
  try {
    return read();
  } catch {
    return [];
  }
}

export function hostCoverageArguments(root: string, path: string, sources: Sources): string[] {
  return optional(() => {
    const proof = hpcProof(root, path, sources, 'host');
    return [
      '--host-proof',
      resolve(path),
      '--mix-dir',
      join(dirname(resolve(path)), 'mix'),
      ...proof.snapshots.flatMap((name) => ['--tix', name]),
    ];
  });
}

function native(root: string, sources: Sources): string[] {
  const pointer = readPointer(root, 'native-tools-coverage');
  const path = verifiedFile(root, pointer.proof, pointer.sha256);
  const proof = hpcProof(root, path, sources, 'native');
  return [
    '--mix-dir',
    join(dirname(path), 'mix'),
    ...proof.snapshots.flatMap((name) => ['--tix', name]),
  ];
}

function wasm(root: string, sources: Sources): string[] {
  const pointer = readPointer(root, 'wasm-coverage');
  const path = childPath(root, string(pointer.proof));
  const proof = hpcProof(root, path, sources, 'wasm');
  const metadata = object(jsonFile(path));
  const directory = dirname(path);
  const reports = list(metadata.javascriptReports ?? [])
    .map(object)
    .map((report) => verifiedFile(directory, report.path, report.sha256));
  return [
    '--wasm-proof',
    path,
    '--wasm-mix-dir',
    join(directory, 'mix'),
    ...proof.snapshots.flatMap((file) => ['--wasm-tix', file]),
    ...reports.flatMap((file) => ['--istanbul', file]),
  ];
}

function coveragePointer(
  root: string,
  name: string,
  sources: Sources,
): { report: string; proof: string } {
  const pointer = readPointer(root, name);
  const report = childPath(root, string(pointer.report));
  const proof = childPath(root, string(pointer.proof));
  if (!validJavascriptProof(report, proof, sources)) {
    throw new Error('Stale or unsuccessful coverage report: ' + name);
  }

  return { report, proof };
}

function nodeCoverage(root: string, name: string, sources: Sources): string[] {
  const { report, proof } = coveragePointer(root, name, sources);
  const data = object(jsonFile(proof));
  successfulProof(data, sources);
  commandProof(dirname(proof), data.commands);
  verifiedFiles(dirname(proof), data.raw, 'V8 raw reports');
  validateV8Files(
    root,
    dirname(proof),
    sources,
    new Set(strings(data.nodeSources)),
    data.queryProvenance,
  );
  return ['--istanbul', report];
}

function workerd(root: string, sources: Sources): string[] {
  const { report, proof } = coveragePointer(root, 'workerd-js-coverage', sources);
  const data = object(jsonFile(proof));
  successfulProof(data, sources);
  commandProof(dirname(proof), data.commands);
  for (const category of ['snapshots', 'manifests']) {
    verifiedFiles(dirname(proof), data[category], category);
  }

  return ['--istanbul', report, '--workerd-only', report];
}

function sharedCoverage(root: string, sources: Sources): string[] {
  const pointer = readPointer(root, 'shared-js-coverage');
  const path = verifiedFile(root, pointer.proof, pointer.proofSha256);
  const verified = verifiedSharedJavascript(root, path, sources);
  if (
    verified.combined !== childPath(root, string(pointer.report)) ||
    verified.workerdOnly !== childPath(root, string(pointer.workerdOnly))
  ) {
    throw new Error('Shared JavaScript pointer report differs');
  }

  return ['--shared-js-proof', path];
}

function shell(root: string, sources: Sources): string[] {
  const pointer = readPointer(root, 'shell-coverage');
  const path = verifiedFile(root, pointer.report, pointer.sha256);
  const report = object(jsonFile(path));
  const files = Object.entries(object(report.files));
  if (
    report.schema !== 1 ||
    object(report.collector).name !== 'kcov' ||
    files.length === 0 ||
    nonnegative(object(report.contracts).passed) === 0 ||
    files.some(([name, value]) => sources[name] !== object(value).sha256)
  ) {
    throw new Error('Unsuccessful or stale shell evidence');
  }

  return ['--shell-json', path];
}

function compiler(root: string, sources: Sources, name: 'compile' | 'haskell'): string[] {
  const pointer = readPointer(root, name + '-validation');
  const path = verifiedFile(root, pointer.proof, pointer.sha256);
  const proof = object(jsonFile(path));
  successfulProof(proof, sources);
  commandProof(dirname(path), proof.commands, name === 'haskell');

  if (list(proof.validated).length === 0) {
    throw new Error('No current compile validations');
  }

  return [`--${name}-proof`, path];
}

export function otherCoverageArguments(
  root: string,
  sources: Sources,
  selected: {
    compile?: string;
    nativeCompile?: string;
    shell?: string;
  } = {},
): string[] {
  const integrationReports = [
    'examples/url-shortener/test-artifacts/coverage/runtime',
    'examples/url-shortener/test-artifacts/coverage/production',
    'tests/runtime/test-artifacts/coverage/runtime',
  ].flatMap((name) => {
    const directory = join(root, name);
    const report = join(directory, 'coverage-final.json');
    return validJavascriptProof(report, join(directory, 'run-proof.json'), sources)
      ? ['--istanbul', report]
      : [];
  });
  const shared = optional(() => sharedCoverage(root, sources));
  const coverage = optional(() => nodeCoverage(root, 'example-node-coverage', sources));
  const tools =
    coverage.length === 0 ? optional(() => nodeCoverage(root, 'tools-coverage', sources)) : [];
  return [
    ...integrationReports,
    ...optional(() => wasm(root, sources)),
    ...optional(() => native(root, sources)),
    ...optional(() => compiler(root, sources, 'haskell')),
    ...optional(() => ['--istanbul', coveragePointer(root, 'npm-coverage', sources).report]),
    ...coverage,
    ...tools,
    ...(shared.length === 0 ? optional(() => workerd(root, sources)) : shared),
    ...(selected.compile
      ? ['--compile-proof', resolve(selected.compile)]
      : optional(() => compiler(root, sources, 'compile'))),
    ...(selected.nativeCompile ? ['--native-compile-proof', resolve(selected.nativeCompile)] : []),
    ...(selected.shell
      ? ['--shell-json', resolve(selected.shell)]
      : optional(() => shell(root, sources))),
  ];
}
