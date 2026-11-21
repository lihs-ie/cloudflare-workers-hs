import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { capture, digest, files, isFile, textFile, writeJson } from './cli.mts';
import {
  childPath,
  collectFingerprints,
  equals,
  loggedCommand,
  recordCommand,
  type CommandEvidence,
} from './evidence-io.mts';
import { compilerDriver, compatibilityProbe } from './plugin-fixtures.mts';
import { parseTix } from './hpc.mts';

function wasmShim(root: string, output: string): string[] {
  const directory = join(output, 'package');
  const project = join(output, 'cabal.project');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'shim-wasm-probe.cabal'),
    [
      'cabal-version: 3.0',
      'name: shim-wasm-probe',
      'version: 0.1.0.0',
      'build-type: Simple',
      'library',
      '  exposed-modules: GHC.Wasm.FFI.Plugin',
      '  default-language: GHC2024',
      '  build-depends: base, ghc',
      '  hs-source-dirs: ' + join(root, 'cloudflare-workers/shim/wasm'),
      '',
    ].join('\n'),
  );
  writeFileSync(project, 'packages: ' + directory + '\n');
  return ['cabal', 'build', 'shim-wasm-probe', '--project-file=' + project];
}

const noopProbe = `module Main where
main :: IO ()
main = if (42 :: Int) == 42 then putStrLn "plugin probe passed" else fail "ordinary declaration changed"
`;

type Mode = 'compat' | 'wasm';
type RunProbeCommand = (argv: string[], label: string, target?: string) => string;

interface ProbeBuild {
  build: string;
  packageDatabase: string;
  packageName: string;
  probeSource: string;
  driver: string;
  probe: string;
  driverMix: string;
}

function buildProbe(root: string, output: string, mode: Mode, run: RunProbeCommand): ProbeBuild {
  const flags = isFile('/opt/homebrew/opt/libffi/include/ffi.h')
    ? ['-optc-I/opt/homebrew/opt/libffi/include']
    : [];
  const build = join(output, 'build');
  const buildCommand =
    mode === 'wasm'
      ? wasmShim(root, output)
      : ['cabal', 'build', 'cloudflare-workers:lib:ghc-wasm-shim'];
  run(
    [
      ...buildCommand,
      '--builddir=' + build,
      '--enable-coverage',
      ...flags.map((flag) => '--ghc-options=' + flag),
    ],
    'shim-build',
  );
  const packageConfigs = files(join(build, 'packagedb')).filter((name) => name.endsWith('.conf'));
  if (packageConfigs.length !== 1) {
    throw new Error('Expected one isolated shim package');
  }

  const packageDatabase = dirname(packageConfigs[0]);
  const packageName = basename(packageConfigs[0], '.conf');
  const driverSource = join(output, 'Driver.hs');
  const probeSource = join(output, 'Main.hs');
  const driver = join(output, 'driver');
  const probe = join(output, 'probe');
  const driverMix = join(output, 'driver-mix');
  writeFileSync(driverSource, compilerDriver);
  writeFileSync(probeSource, mode === 'wasm' ? noopProbe : compatibilityProbe);
  run(
    [
      'ghc',
      '-package',
      'ghc',
      '-fhpc',
      '-hpcdir',
      driverMix,
      '-outputdir',
      join(output, 'driver-build'),
      ...flags,
      driverSource,
      '-o',
      driver,
    ],
    'driver-build',
  );
  return { build, packageDatabase, packageName, probeSource, driver, probe, driverMix };
}

function verifyProbe(
  root: string,
  output: string,
  mode: Mode,
  prepared: ProbeBuild,
  run: RunProbeCommand,
): { compilerTicks: string; marker: string } {
  const { packageDatabase, packageName, probeSource, driver, probe } = prepared;
  const libdir = capture(['ghc', '--print-libdir'], { cwd: root }).trim();
  const compilerTicks = join(output, 'compiler.tix');
  const marker = mode === 'wasm' ? 'parsed AST noop passed' : 'parsed AST compatibility passed';
  const compiled = run(
    [
      driver,
      libdir,
      mode,
      '-package-db',
      packageDatabase,
      '-package-id',
      packageName,
      '-fplugin',
      'GHC.Wasm.FFI.Plugin',
      '-fforce-recomp',
      '-outputdir',
      join(output, 'probe-build'),
      probeSource,
      '-o',
      probe,
      ...(mode === 'compat' ? ['-ddump-rn-ast'] : []),
    ],
    'compiler',
    compilerTicks,
  );
  if (!compiled.split('\n').includes(marker)) {
    throw new Error('Compiler parsed AST contract did not succeed');
  }

  if (
    run([probe], 'probe').trim() !== 'plugin probe passed' ||
    !parseTix(textFile(compilerTicks)).some(({ name }) => name.endsWith('/GHC.Wasm.FFI.Plugin'))
  ) {
    throw new Error('Compiler plugin behavior or counters missing');
  }

  return { compilerTicks, marker };
}

export function collectPlugin(
  root: string,
  output: string,
  mode: Mode,
): {
  ticks: string;
  mix: string;
  commandRecords: CommandEvidence[];
  prim: string | null;
} {
  childPath(root, output);
  mkdirSync(output);
  const commandRecords: CommandEvidence[] = [];
  const prefix = join(root, `cloudflare-workers/shim/${mode}/GHC/Wasm`);
  const sources = [
    join(prefix, 'FFI/Plugin.hs'),
    ...(mode === 'compat' ? [join(prefix, 'Prim.hs')] : []),
  ];
  const before = collectFingerprints(root, sources);

  function run(
    argv: string[],
    label: string,
    target: string = join(output, label + '.tix'),
  ): string {
    if (existsSync(target)) {
      throw new Error('Refusing existing compiler tick file');
    }

    const result = loggedCommand(output, label + '.log', argv, {
      cwd: root,
      env: { ...process.env, HPCTIXFILE: target },
    });
    commandRecords.push(recordCommand(result));

    if (result.code !== 0) {
      throw new Error('Compiler probe command failed: ' + label);
    }

    return result.stdout;
  }

  const prepared = buildProbe(root, output, mode, run);
  const { build, packageName, driverMix } = prepared;
  const { compilerTicks, marker } = verifyProbe(root, output, mode, prepared, run);
  const maps = files(build).filter((file) =>
    file.endsWith(`/hpc/dyn/mix/${packageName}/GHC.Wasm.FFI.Plugin.mix`),
  );
  if (maps.length !== 1 || !equals(before, collectFingerprints(root, sources))) {
    throw new Error('Missing dynamic mix or sources changed during probe');
  }

  const mix = maps[0];
  run(
    [
      'hpc',
      'report',
      compilerTicks,
      '--per-module',
      '--hpcdir=' + dirname(dirname(mix)),
      '--hpcdir=' + driverMix,
    ],
    'coverage',
  );
  const ticks = join(output, 'plugin-only.tix');
  run(['hpc', 'sum', '--exclude=Main', '--output=' + ticks, compilerTicks], 'select-plugin');
  const prim =
    mode === 'compat'
      ? 'compiler accepted GHC.Wasm.Prim (JSVal) import; reexport has no runtime body'
      : null;
  writeJson(join(output, 'proof.json'), {
    status: 'passed',
    sources: before,
    commandRecords,
    commands: commandRecords.map(({ command }) => command),
    compiler_tix: relative(root, compilerTicks),
    tix: relative(root, ticks),
    tix_sha256: digest(ticks),
    mix: relative(root, mix),
    mix_sha256: digest(mix),
    prim,
    parsedAst: { mode, successfulMarker: marker },
    limitations:
      'The parsed AST and compiled behavior are checked; generated driver Main is excluded from repository coverage.',
  });
  return { ticks, mix, commandRecords, prim };
}
