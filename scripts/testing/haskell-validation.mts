import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { digest, files, jsonFile, repositoryRoot, runCli, textFile } from './Support/cli.mts';
import { manifestEntries } from './Support/coverage-scope.mts';
import {
  childPath,
  equals,
  evidencePath,
  loggedCommand,
  publish,
  recordCommand,
  sourceSnapshot,
  verifiedFile,
} from './Support/evidence-io.mts';
import {
  compilerRuntimes,
  discoveryExecution,
  discoveryPragma,
  loadParent,
  privateModules,
  validateInterfaceDump,
  type CompilerRuntime,
  type Parent,
} from './Support/haskell-contracts.mts';
import { list, object, string, strings } from './Support/validation.mts';

const root = repositoryRoot;
const publicProbe = `module Public where
import Cloudflare.Workers.HTTP (Response)
import Cloudflare.Workers.Binding.WorkersAI (WorkersAI, AIModel, AIOptions, workersAIRun)
import Cloudflare.Workers.Binding.WorkersAI.Gemma (GemmaInput, GemmaOutput)
import Servant.Cloudflare.Workers.Server.Extension (Router)
import qualified Servant.Cloudflare.Workers.Access
responseContract :: Response -> Response
responseContract = id
bindingContract :: WorkersAI -> AIModel -> GemmaInput -> AIOptions -> IO GemmaOutput
bindingContract = workersAIRun
routerContract :: Router a b -> Router a b
routerContract = id
`;

interface Invocation {
  argv: string[];
  runtime: CompilerRuntime;
  success?: boolean;
  diagnostic?: string;
  probe?: string;
  input?: string;
  log?: string;
}
type Execute = (invocation: Invocation) => string;

function artifact(output: string, path: string): { path: string; sha256: string } {
  return { path: relative(output, path), sha256: digest(path) };
}

function buildRoots(parent: Parent, runtime: CompilerRuntime): string[] {
  const directories =
    runtime === 'wasm'
      ? list(parent.data.buildPlans).map((plan) => string(object(plan).buildDirectory))
      : parent.commands.flatMap(({ command }) =>
          strings(command)
            .filter((item) => item.startsWith('--builddir='))
            .map((item) => item.slice('--builddir='.length)),
        );
  return [...new Set(directories)].map((path) => childPath(root, path)).sort();
}

function findInterface(
  output: string,
  source: string,
  name: string,
  index: number,
  runtime: CompilerRuntime,
  candidates: string[],
  compiler: string,
  execute: Execute,
): Record<string, unknown> {
  for (const [number, candidate] of candidates
    .filter((path) => path.endsWith('/' + name))
    .entries()) {
    const directory = join(output, 'interfaces', runtime, String(index));
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, number + '.hi');
    const log = join(directory, number + '.interface');
    copyFileSync(candidate, destination);
    const dump = execute({
      argv: [compiler, '--show-iface', destination],
      runtime,
      log: relative(output, log),
    });
    if (validateInterfaceDump(source, dump)) {
      return { interface: artifact(output, destination), dump: artifact(output, log) };
    }
  }

  throw new Error('Missing compiled interface or source fingerprint mismatch: ' + source);
}

function reviewedEntries(
  output: string,
  parents: Record<CompilerRuntime, Parent>,
  candidates: Record<CompilerRuntime, string[]>,
  execute: Execute,
): Record<string, unknown>[] {
  const manifest = object(jsonFile(join(root, 'scripts/testing/runtime-scope.json')));
  const validated: Record<string, unknown>[] = [];
  for (const [path, entry] of manifestEntries(manifest, 'validations')) {
    if (entry.kind !== 'haskell-test-entry' && entry.kind !== 'haskell-interface') {
      continue;
    }

    const source = verifiedFile(root, path, entry.source_sha256);

    if (entry.kind === 'haskell-test-entry') {
      if (textFile(source).trim() !== discoveryPragma) {
        throw new Error('Discovery entry gained authored executable code');
      }

      validated.push({
        path,
        kind: entry.kind,
        execution: discoveryExecution(parents.host, string(entry.target)),
      });
      continue;
    }

    const moduleName = /^module\s+([A-Z][\w.]*)/m.exec(textFile(source))?.[1];
    if (moduleName === undefined) {
      throw new Error('Missing Haskell module declaration: ' + path);
    }

    const interfaces: Record<string, unknown> = {};
    for (const name of strings(entry.compiler_runtimes)) {
      const runtime = compilerRuntimes.find((item) => item === name);
      if (runtime === undefined) {
        throw new Error('Invalid compiler runtime: ' + name);
      }

      interfaces[runtime] = findInterface(
        output,
        source,
        moduleName.replaceAll('.', '/') + '.hi',
        validated.length,
        runtime,
        candidates[runtime],
        parents[runtime].executable,
        execute,
      );
    }

    validated.push({ path, kind: entry.kind, interfaces });
  }

  return validated;
}

function verifyConsumers(
  output: string,
  runtime: CompilerRuntime,
  parent: Parent,
  roots: string[],
  execute: Execute,
): void {
  const project = runtime === 'host' ? 'cabal.project' : 'cabal-wasm-coverage.project';
  const build = runtime === 'host' ? roots[0] : join(root, 'dist-library-runtime-coverage');
  if (build === undefined || !roots.includes(build)) {
    throw new Error('Missing authenticated public consumer build directory');
  }

  const base = [
    parent.cabal,
    'exec',
    '--project-file=' + project,
    '--builddir=' + build,
    '--',
    parent.executable,
    '-fno-code',
    '-fforce-recomp',
    '-v0',
    '-hide-all-packages',
    '-package',
    'base',
    '-package',
    'cloudflare-workers',
    '-package',
    'servant-cloudflare-workers',
    '-package',
    'servant-cloudflare-workers-access',
  ];
  const probes = [
    { probe: 'public', body: publicProbe, success: true, diagnostic: '' },
    {
      probe: 'router-constructor',
      body: 'module Negative where\nimport Servant.Cloudflare.Workers.Server.Extension\nprobe = StaticRouter\n',
      success: false,
      diagnostic: 'StaticRouter',
    },
    ...privateModules.map((name) => ({
      probe: name,
      body: `module Negative where\nimport ${name}\n`,
      success: false,
      diagnostic: name,
    })),
  ];
  for (const { probe, body, success, diagnostic } of probes) {
    const input = join(output, 'consumers', runtime, probe + '.hs');
    mkdirSync(dirname(input), { recursive: true });
    writeFileSync(input, body);
    execute({ argv: [...base, input], runtime, probe, success, diagnostic, input });
  }
}

function collect(output: string, hostProof: string, wasmProof: string): number {
  const sources = sourceSnapshot(root);
  const proof = {
    sources,
    parents: { host: artifact(root, hostProof), wasm: artifact(root, wasmProof) },
    commands: [] as Record<string, unknown>[],
    validated: [] as Record<string, unknown>[],
    errors: [] as string[],
    exit_code: 1,
  };
  try {
    const parents = {
      host: loadParent(root, hostProof, 'host', sources),
      wasm: loadParent(root, wasmProof, 'wasm', sources),
    };
    const roots = {
      host: buildRoots(parents.host, 'host'),
      wasm: buildRoots(parents.wasm, 'wasm'),
    };
    const candidates = {
      host: roots.host.flatMap((path) => files(path).filter((file) => file.endsWith('.hi'))),
      wasm: roots.wasm.flatMap((path) => files(path).filter((file) => file.endsWith('.hi'))),
    };
    const execute: Execute = ({
      argv,
      runtime,
      success = true,
      diagnostic = '',
      probe,
      input,
      log,
    }) => {
      const name = log ?? `command-${proof.commands.length}.log`;
      const result = loggedCommand(output, name, argv, {
        cwd: root,
        timeout: 180_000,
        env: { ...process.env, PATH: parents[runtime].searchPath ?? process.env.PATH },
      });
      const expected =
        (result.code === 0) === success &&
        result.stdout.toLowerCase().includes(diagnostic.toLowerCase()) &&
        (success || /hidden module|not exposed|not in scope/i.test(result.stdout));
      proof.commands.push({
        ...recordCommand(result),
        runtime,
        processExitCode: result.code,
        exitCode: expected ? 0 : 1,
        expectedSuccess: success,
        expectedDiagnostic: diagnostic,
        probe,
        input: input ? artifact(output, input) : undefined,
      });

      if (!expected) {
        throw new Error('Unexpected Haskell compiler/consumer result: ' + argv.join(' '));
      }

      return result.stdout;
    };

    proof.validated = reviewedEntries(output, parents, candidates, execute);
    for (const runtime of compilerRuntimes) {
      verifyConsumers(output, runtime, parents[runtime], roots[runtime], execute);
    }

    if (!equals(sources, sourceSnapshot(root))) {
      throw new Error('Sources changed during Haskell contract validation');
    }

    proof.exit_code = 0;
  } catch (error) {
    proof.errors.push(error instanceof Error ? error.message : String(error));
  }

  publish(root, output, 'haskell-validation', proof);
  console.log('Haskell compiler/discovery evidence: ' + output);
  return proof.exit_code;
}

runCli(import.meta.url, '--host-proof FILE --wasm-proof FILE [--output DIR]', () => {
  const { values } = parseArgs({
    options: {
      'host-proof': { type: 'string' },
      'wasm-proof': { type: 'string' },
      output: { type: 'string' },
    },
  });

  if (!values['host-proof'] || !values['wasm-proof']) {
    throw new Error('Haskell validation requires --host-proof and --wasm-proof');
  }

  const output = evidencePath(root, 'haskell-validation', values.output);
  return collect(output, resolve(values['host-proof']), resolve(values['wasm-proof']));
});
