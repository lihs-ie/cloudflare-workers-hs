import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { digest, isFile, jsonFile, repositoryRoot, runCli, writeJson } from './Support/cli.mts';
import { compileEvidence, nativeCompileEvidence } from './Support/compile-evidence.mts';
import { applyScope, inventory, manifestEntries, type Source } from './Support/coverage-scope.mts';
import { sourceSnapshot } from './Support/evidence-io.mts';
import { haskellContractEvidence } from './Support/haskell-contracts.mts';
import { collectHpc } from './Support/hpc-report.mts';
import { hpcProof } from './Support/proof-inputs.mts';
import {
  javascriptEvidence,
  shellEvidence,
  verifiedSharedJavascript,
} from './Support/runtime-evidence.mts';
import { object } from './Support/validation.mts';

const one = { type: 'string' } as const;
const many: { type: 'string'; multiple: true; default: string[] } = {
  type: 'string',
  multiple: true,
  default: [],
};
const options = {
  root: { ...one, default: repositoryRoot },
  output: one,
  tix: many,
  'mix-dir': many,
  'wasm-tix': many,
  'wasm-mix-dir': many,
  istanbul: many,
  'shared-js-proof': one,
  'workerd-only': one,
  'shell-json': one,
  'haskell-proof': one,
  'native-compile-proof': one,
  'wasm-proof': one,
  'host-proof': one,
  'compile-proof': one,
  'scope-manifest': one,
  'report-only': { type: 'boolean', default: false },
} as const;

type CoverageArgs = ReturnType<typeof parseArgs<{ options: typeof options }>>['values'];

function completeness(
  sources: Source[],
  errors: string[],
): {
  unmeasured_sources: string[];
  host_hpc_complete: boolean;
  runtime_complete: boolean;
  compile_validation_complete: boolean;
  complete: boolean;
} {
  const evidence = sources.flatMap((source) => Object.entries(source.evidence));
  const runtime = evidence.filter(([name]) => name !== 'compile');
  const host = runtime.filter(([name]) => name === 'host');
  const compile = evidence.filter(([name]) => name === 'compile');
  const passed = errors.length === 0;
  const unmeasured = sources.filter((source) =>
    Object.values(source.evidence).some((entry) => entry.status === 'unmeasured'),
  );
  return {
    unmeasured_sources: unmeasured.map(({ path }) => path),
    host_hpc_complete: host.length > 0 && host.every(([, entry]) => entry.complete),
    runtime_complete: passed && runtime.length > 0 && runtime.every(([, entry]) => entry.complete),
    compile_validation_complete: passed && compile.every(([, entry]) => entry.complete),
    complete: passed && evidence.length > 0 && evidence.every(([, entry]) => entry.complete),
  };
}

function collectJavascript(
  root: string,
  sources: Source[],
  paths: string[],
  sharedProof?: string,
  workerdPath?: string,
): Record<string, unknown> {
  const shared = sharedProof ? verifiedSharedJavascript(root, sharedProof) : undefined;
  const combined = shared ? javascriptEvidence(root, [shared.combined]) : {};
  const js = { ...javascriptEvidence(root, paths), ...combined };
  const isolated = shared?.workerdOnly ?? workerdPath;
  const workerd = isolated ? javascriptEvidence(root, [isolated]) : {};
  const known = new Set(
    sources.filter(({ language }) => language === 'javascript').map(({ path }) => path),
  );
  if ([...Object.keys(js), ...Object.keys(workerd)].some((path) => !known.has(path))) {
    throw new Error('Istanbul report contains sources absent from inventory');
  }

  for (const source of sources) {
    if (source.language !== 'javascript') {
      continue;
    }

    source.javascript_execution = {
      workerd_only: workerd[source.path] ?? { status: 'unmeasured', complete: false },
      shared_execution: Object.hasOwn(combined, source.path) ? 'measured' : 'unmeasured',
    };

    if (Object.hasOwn(js, source.path) && source.evidence.javascript !== undefined) {
      source.evidence.javascript = js[source.path];
      source.host = 'measured';
    }
  }

  return {
    status: Object.keys(js).length > 0 ? 'measured' : 'unmeasured',
    files: js,
    shared_execution: {
      status: shared ? 'measured' : 'unmeasured',
      proof: shared?.proof ?? null,
      note: 'Node boundary doubles and workerd counters share authenticated instrumentation; Node is not Cloudflare platform verification.',
    },
    workerd_only: {
      status: Object.keys(workerd).length > 0 ? 'measured' : 'unmeasured',
      files: workerd,
    },
  };
}

export function coverageReport(
  args: CoverageArgs,
): Record<string, unknown> & ReturnType<typeof completeness> {
  const root = resolve(args.root);
  const sources = inventory(root);
  const errors: string[] = [];
  const report: Record<string, unknown> = {
    schema: 2,
    scope: 'all repository-authored executable sources; no silent exclusions',
    sources,
    host_hpc: [],
    wasm_hpc: [],
    errors,
    javascript: { status: 'unmeasured' },
    line_coverage: { status: 'unmeasured' },
  };
  try {
    const manifestPath = resolve(
      args['scope-manifest'] ?? join(root, 'scripts/testing/runtime-scope.json'),
    );
    const hasManifest = isFile(manifestPath);
    if (args['scope-manifest'] !== undefined && !hasManifest) {
      throw new Error('Requested scope manifest does not exist');
    }

    const manifest = hasManifest ? object(jsonFile(manifestPath)) : {};
    report.runtime_manifest = hasManifest
      ? { path: manifestPath, sha256: digest(manifestPath) }
      : null;
    applyScope(root, sources, manifest);

    const compiled = {
      ...compileEvidence(root, sources, args['compile-proof'], manifestPath),
      ...haskellContractEvidence(root, sources, args['haskell-proof']),
      ...nativeCompileEvidence(root, sources, args['native-compile-proof']),
    };
    report.compile_validation = {
      status: Object.keys(compiled).length > 0 ? 'validated' : 'unmeasured',
      files: compiled,
      required_sources: sources
        .filter((source) => source.required_runtimes.includes('compile'))
        .map(({ path }) => path),
    };
    const shell = shellEvidence(root, args['shell-json']);
    const shellSources = new Set(
      sources
        .filter((source) => source.required_runtimes.includes('shell'))
        .map(({ path }) => path),
    );
    if (Object.keys(shell).some((path) => !shellSources.has(path))) {
      throw new Error('Shell report contains non-shell inventory paths');
    }

    report.shell = {
      status: Object.keys(shell).length > 0 ? 'measured' : 'unmeasured',
      files: shell,
    };
    for (const source of sources) {
      if (Object.hasOwn(compiled, source.path)) {
        source.evidence.compile = compiled[source.path];
      }

      if (Object.hasOwn(shell, source.path)) {
        source.evidence.shell = shell[source.path];
      }
    }

    report.javascript = collectJavascript(
      root,
      sources,
      args.istanbul,
      args['shared-js-proof'],
      args['workerd-only'],
    );
    const snapshot = sourceSnapshot(root);
    const guards = manifestEntries(manifest, 'constant_guards');
    for (const runtime of ['host', 'wasm'] as const) {
      const path = args[`${runtime}-proof`];
      const proof =
        path === undefined ? undefined : hpcProof(root, resolve(path), snapshot, runtime);
      const tix = runtime === 'host' ? args.tix : args['wasm-tix'];
      const mix = runtime === 'host' ? args['mix-dir'] : args['wasm-mix-dir'];
      report[`${runtime}_hpc`] = collectHpc(
        root,
        runtime,
        { tix, mix, proof },
        sources,
        guards,
        errors,
      );
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const wasm = sources.filter((source) => source.required_runtimes.includes('wasm'));
  const wasmStatus =
    Array.isArray(report.wasm_hpc) && report.wasm_hpc.length > 0 ? 'partial' : 'unmeasured';
  report.wasm = {
    status: wasm.length === 0 ? 'not-applicable' : wasmStatus,
    note: 'WASM HPC measures instrumented Haskell ticks; JavaScript FFI requires separate instrumentation.',
    required_sources: wasm.map(({ path }) => path),
  };
  const hasLines =
    (Array.isArray(report.host_hpc) && report.host_hpc.length > 0) ||
    object(report.javascript).status === 'measured';
  report.line_coverage = {
    status: hasLines ? 'partial' : 'unmeasured',
    note: 'HPC expression-span projection; JS uses Istanbul statement-start lines. WASM remains separate.',
  };
  return { ...report, ...completeness(sources, errors) };
}

function parseCoverageArgs(args: string[]): CoverageArgs {
  return parseArgs({ args, options }).values;
}

runCli(
  import.meta.url,
  '--output FILE [--root DIR] [--scope-manifest FILE] [--report-only]\n  [--tix FILE]... [--mix-dir DIR]... [--wasm-tix FILE]... [--wasm-mix-dir DIR]...\n  [--host-proof FILE] [--wasm-proof FILE] [--haskell-proof FILE]\n  [--compile-proof FILE] [--native-compile-proof FILE] [--shell-json FILE]\n  [--istanbul FILE]... [--shared-js-proof FILE] [--workerd-only FILE]',
  () => {
    const args = parseCoverageArgs(process.argv.slice(2));
    if (args.output === undefined) {
      throw new Error('Coverage requires --output');
    }

    const report = coverageReport(args);
    writeJson(args.output, report);
    console.log(
      `Coverage evidence: ${args.output}; ${report.unmeasured_sources.length} unmeasured sources; complete=${report.complete}`,
    );
    return args['report-only'] || report.complete ? 0 : 1;
  },
);
