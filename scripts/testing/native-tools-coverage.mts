import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import {
  absolutePath,
  capture,
  files,
  isFile,
  jsonFile,
  repositoryRoot,
  runCli,
  textFile,
  within,
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
} from './Support/evidence-io.mts';
import { testEnvironment } from './Support/host-coverage.mts';
import { collectPlugin } from './Support/host-plugin-probe.mts';
import { parseTix } from './Support/hpc.mts';

const root = repositoryRoot;
const discovery = 'testing-support:exe:sydtest-discover-layer';
const oracle = 'conformance-oracle:exe:regenerate-conformance-golden';

function nativeProbe(
  output: string,
  cwd: string,
  label: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  success: boolean,
  marker: string = '',
): CommandEvidence & {
  processExitCode: number;
  expectedSuccess: boolean;
  assertionsPassed: boolean;
  tix: string;
} {
  const tix = join(output, label + '.tix');
  if (existsSync(tix)) {
    throw new Error('Refusing existing probe counters: ' + tix);
  }

  const result = loggedCommand(output, label + '.log', argv, {
    cwd,
    env: { ...env, HPCTIXFILE: tix },
    timeout: 90_000,
  });
  if ((result.code === 0) !== success || !result.stdout.includes(marker)) {
    throw new Error('Unexpected native tool result: ' + label);
  }

  parseTix(textFile(tix));
  return {
    ...recordCommand(result),
    processExitCode: result.code,
    exitCode: 0,
    expectedSuccess: success,
    assertionsPassed: true,
    tix: basename(tix),
  };
}

function toolProbes(
  output: string,
  bin: (name: string) => string,
  env: NodeJS.ProcessEnv,
): ReturnType<typeof nativeProbe>[] {
  const fixtures = join(output, 'fixtures');
  const layer = join(fixtures, 'test/unit');
  const spec = join(layer, 'Spec.hs');
  const outputSource = join(fixtures, 'generated.hs');
  mkdirSync(layer, { recursive: true });
  mkdirSync(join(fixtures, 'test/Support'));
  writeFileSync(spec, '');
  writeFileSync(join(layer, 'HTTPSpec.hs'), 'module HTTPSpec where\nspec = pure ()\n');
  writeFileSync(join(fixtures, 'test/Support/HiddenSpec.hs'), '');

  const discover = bin(discovery);
  const generated = nativeProbe(
    output,
    fixtures,
    'discovery-success',
    [discover, spec, spec, outputSource],
    env,
    true,
  );
  const content = textFile(outputSource);
  if (!content.includes('HTTPSpec') || content.includes('HiddenSpec')) {
    throw new Error('Discovery did not preserve layer isolation');
  }

  const golden = join(fixtures, 'reference.json');
  const executable = bin(oracle);
  const regenerated = nativeProbe(
    output,
    fixtures,
    'oracle-success',
    [executable, golden],
    env,
    true,
  );

  if (
    !equals(
      jsonFile(golden),
      jsonFile(join(root, 'conformance-oracle/test/Support/Golden/reference.json')),
    )
  ) {
    throw new Error('Oracle CLI generated a different contract document');
  }

  return [
    generated,
    nativeProbe(
      output,
      fixtures,
      'discovery-invalid-arguments',
      [discover],
      env,
      false,
      'expected GHC source, input and output paths',
    ),
    regenerated,
    nativeProbe(
      output,
      fixtures,
      'oracle-invalid-arguments',
      [executable],
      env,
      false,
      'Usage: regenerate-conformance-golden',
    ),
  ];
}

function collect(output: string): number {
  const sources = sourceSnapshot(root);
  const proof = {
    sources,
    commands: [] as CommandEvidence[],
    snapshots: {} as Record<string, string>,
    mixFiles: {} as Record<string, string>,
    compilerContracts: [] as Record<string, unknown>[],
    errors: [] as string[],
    exit_code: 1,
  };
  const build = join(output, 'build');
  const common = ['--project-file=cabal.project', '--builddir=' + build];
  const env = testEnvironment();
  delete env.HPCTIXFILE;
  const ticks: string[] = [];

  function copy(source: string, name: string): string {
    const destination = join(output, name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return destination;
  }

  try {
    const built = loggedCommand(
      output,
      'build.log',
      ['cabal', 'build', discovery, oracle, ...common, '--enable-coverage', '-j2'],
      { cwd: root, env, timeout: 600_000 },
    );
    proof.commands.push(recordCommand(built));

    if (built.code !== 0) {
      throw new Error('Native tool coverage build failed');
    }

    const probes = toolProbes(
      output,
      (target) => {
        const binary = absolutePath(
          capture(['cabal', 'list-bin', target, ...common], {
            cwd: root,
            env,
            timeout: 30_000,
          }).trim(),
        );
        if (!within(build, binary) || !isFile(binary)) {
          throw new Error('Native executable is not in the isolated build');
        }

        return binary;
      },
      env,
    );
    proof.commands.push(...probes);
    ticks.push(...probes.map(({ tix }) => join(output, tix)));
    for (const mode of ['compat', 'wasm'] as const) {
      const name = 'compiler-' + mode;
      const plugin = collectPlugin(root, join(output, name), mode);
      proof.commands.push(
        ...plugin.commandRecords.map((record) => ({ ...record, log: join(name, record.log) })),
      );
      ticks.push(copy(plugin.ticks, name + '.tix'));
      copy(plugin.mix, join('mix', name, basename(dirname(plugin.mix)), basename(plugin.mix)));
      proof.compilerContracts.push({
        mode,
        proof: relative(root, join(output, name, 'proof.json')),
        prim: plugin.prim,
      });

      if (mode === 'compat') {
        const interfaces = files(join(output, 'compiler-compat/build')).filter((path) =>
          path.endsWith('/Prim.hi'),
        );
        if (interfaces.length !== 1) {
          throw new Error('Expected one fresh Prim interface');
        }

        const iface = copy(interfaces[0], 'Prim.hi');
        const dump = loggedCommand(output, 'Prim.interface', ['ghc', '--show-iface', iface], {
          cwd: root,
          env,
          timeout: 30_000,
        });
        proof.commands.push(recordCommand(dump));

        if (dump.code !== 0) {
          throw new Error('GHC interface dump failed');
        }
      }
    }

    for (const path of files(build).filter((path) => path.endsWith('.mix'))) {
      copy(path, join('mix', relative(build, path)));
    }

    proof.mixFiles = collectFingerprints(
      output,
      files(join(output, 'mix')).filter((path) => path.endsWith('.mix')),
    );
    proof.snapshots = collectFingerprints(output, ticks);

    if (
      ticks.length !== 6 ||
      Object.keys(proof.mixFiles).length === 0 ||
      !equals(sources, sourceSnapshot(root))
    ) {
      throw new Error('Incomplete native tool coverage or changed sources');
    }

    proof.exit_code = 0;
  } catch (error) {
    proof.errors.push(error instanceof Error ? error.message : String(error));
  }

  publish(root, output, 'native-tools-coverage', proof);
  console.log('Native tool evidence: ' + output);
  return proof.exit_code;
}

runCli(import.meta.url, '[--output DIR]', () => {
  const { values } = parseArgs({ options: { output: { type: 'string' } } });
  return collect(evidencePath(root, 'native-tools-coverage', values.output));
});
