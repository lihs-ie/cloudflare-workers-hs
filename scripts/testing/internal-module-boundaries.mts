import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  command,
  isFile,
  repositoryRoot,
  runCli,
  textFile,
  withTemp,
  type CommandRunner,
} from './Support/cli.mts';

const packages = [
  ['cloudflare-workers', 'Cloudflare.Workers.HTTP', 'Cloudflare.Workers.Internal.FFI.Bytes'],
  [
    'servant-cloudflare-workers',
    'Servant.Cloudflare.Workers.Server',
    'Servant.Cloudflare.Workers.Server.Internal.Router',
  ],
  [
    'servant-cloudflare-workers-client',
    'Servant.Cloudflare.Workers.Client.Fetch',
    'Servant.Cloudflare.Workers.Client.Internal.FFI.Fetch',
  ],
  [
    'servant-cloudflare-workers-access',
    'Servant.Cloudflare.Workers.Access',
    'Servant.Cloudflare.Workers.Access.Internal.Claims',
  ],
] as const;

function indentation(line: string): number {
  let column = 0;
  for (const char of line) {
    if (char === '\t') {
      column += 8 - (column % 8);
    } else if (char === ' ') {
      column += 1;
    } else {
      break;
    }
  }

  return column;
}

export function exposedModules(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const modules: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^\s*exposed-modules\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }

    const field = [match[1]];
    for (let next = index + 1; next < lines.length; next += 1) {
      const continuation = lines[next];
      if (!continuation.trim() || indentation(continuation) <= indentation(line)) {
        break;
      }

      field.push(continuation.trimStart());
      index = next;
    }

    const uncommented = field.map((part) => part.split('--', 1)[0]).join('\n');
    modules.push(
      ...(uncommented.match(/\b[A-Z][A-Za-z0-9_']*(?:\.[A-Z][A-Za-z0-9_']*)+\b/g) ?? []),
    );
  }

  return modules;
}

export function manifestErrors(root: string): string[] {
  const errors: string[] = [];
  for (const [name] of packages) {
    const path = `${name}/${name}.cabal`;
    const file = join(root, path);
    if (!isFile(file)) {
      errors.push(`${path}: missing Cabal file`);
      continue;
    }

    for (const module of exposedModules(textFile(file))) {
      if (module.split('.').includes('Internal')) {
        errors.push(`${path}: ${module} must be in other-modules, not exposed-modules`);
      }
    }
  }

  return errors;
}

function ghcArgs(names: readonly string[], source: string): string[] {
  return [
    'cabal',
    'exec',
    '--project-file=cabal.project',
    '--',
    'ghc',
    '-fno-code',
    '-fforce-recomp',
    '-v0',
    '-hide-all-packages',
    '-package',
    'base',
    ...names.flatMap((name) => ['-package', name]),
    source,
  ];
}

function probeSource(modules: readonly string[]): string {
  return [
    'module Probe where',
    ...modules.map((name) => `import qualified ${name}`),
    'probe :: ()',
    'probe = ()',
    '',
  ].join('\n');
}

export function consumerErrors(root: string, run: CommandRunner = command): string[] {
  const names = packages.map(([name]) => name);
  const build = run(
    [
      'cabal',
      'build',
      '--project-file=cabal.project',
      ...names.map((name) => `${name}:lib:${name}`),
    ],
    { cwd: root },
  );
  if (build.code !== 0) {
    return ['could not build public libraries before consumer probes:\n' + build.stderr];
  }

  return withTemp('internal-module-boundaries-', (directory) => {
    const source = join(directory, 'Probe.hs');
    writeFileSync(source, probeSource(packages.map(([, publicModule]) => publicModule)));
    const publicImports = run(ghcArgs(names, source), { cwd: root });
    if (publicImports.code !== 0) {
      return [
        'public import control failed; Internal failures would be inconclusive:\n' +
          publicImports.stderr,
      ];
    }

    const errors: string[] = [];
    for (const [name, , internalModule] of packages) {
      writeFileSync(source, probeSource([internalModule]));
      const result = run(ghcArgs([name], source), { cwd: root });
      const diagnostic = (result.stdout + '\n' + result.stderr).toLowerCase();

      if (result.code === 0) {
        errors.push(`${name}: external consumer unexpectedly imported ${internalModule}`);
      } else if (
        !diagnostic.includes(internalModule.toLowerCase()) ||
        !/hidden module|not exposed/.test(diagnostic)
      ) {
        errors.push(
          `${name}: import failed for an unrelated reason instead of module visibility:\n${result.stderr}`,
        );
      }
    }

    return errors;
  });
}

runCli(import.meta.url, '<manifest|consumer> [--root DIR]', () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { root: { type: 'string', default: repositoryRoot } },
  });
  const [mode] = positionals;

  if (positionals.length !== 1 || (mode !== 'manifest' && mode !== 'consumer')) {
    throw new Error('Usage: internal-module-boundaries.mts manifest|consumer [--root PATH]');
  }

  const root = resolve(values.root);
  const errors = manifestErrors(root);
  if (mode === 'consumer' && errors.length === 0) {
    errors.push(...consumerErrors(root));
  }

  console.log(
    JSON.stringify({ mode, packages: packages.map(([name]) => name).sort(), errors }, null, 2),
  );
  return errors.length === 0 ? 0 : 1;
});
