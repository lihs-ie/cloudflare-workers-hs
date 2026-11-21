import { parseArgs } from 'node:util';
import {
  capture,
  command,
  repositoryRoot,
  runCli,
  writeJson,
  type CommandResult,
  type CommandRunner,
} from './Support/cli.mts';
import { nonnegative, object } from './Support/validation.mts';

const root = repositoryRoot;
const dependencyNames = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.node-version',
  'flake.nix',
  'flake.lock',
  '.pnpmfile.cjs',
  '.pnpmfile.mjs',
  'pnpmfile.cjs',
]);

export function changesDependencies(paths: readonly string[]): boolean {
  return paths.some(
    (path) =>
      dependencyNames.has(path.split('/').at(-1) ?? '') ||
      path.startsWith('nix/') ||
      /^docker\/(?:[^/]*\.)?Dockerfile$/.test(path) ||
      path.startsWith('.github/workflows/') ||
      path.startsWith('.github/actions/') ||
      path === 'scripts/testing/dependency-audit.mts',
  );
}

export function auditOutcome(result: CommandResult): {
  status: 'passed' | 'vulnerabilities' | 'unavailable';
  report?: unknown;
  reason?: string;
} {
  try {
    const report = JSON.parse(result.stdout) as unknown;
    const counts = object(object(object(report).metadata).vulnerabilities);
    const high = nonnegative(counts.high);
    const critical = nonnegative(counts.critical);
    if (high > 0 || critical > 0) {
      return { status: 'vulnerabilities', report };
    }

    if (result.code === 0) {
      return { status: 'passed', report };
    }
  } catch {
    // An exit status alone cannot distinguish a returned advisory from a failed request.
  }

  return {
    status: 'unavailable',
    reason: 'Registry did not return a successful, valid audit result',
  };
}

export function collectAudit(run: CommandRunner = command): ReturnType<typeof auditOutcome> {
  try {
    return auditOutcome(
      run(['pnpm', 'audit', '--audit-level', 'high', '--json'], { cwd: root, timeout: 60_000 }),
    );
  } catch {
    return { status: 'unavailable', reason: 'Package manager could not complete the audit' };
  }
}

runCli(import.meta.url, () => {
  const { values } = parseArgs({
    options: {
      'base-sha': { type: 'string' },
      output: { type: 'string', default: 'artifacts/testing/dependency-audit.json' },
    },
  });

  if (values['base-sha'] !== undefined) {
    const base = values['base-sha'];
    if (!/^[a-f0-9]{40}$/.test(base)) {
      throw new Error('Expected a full pull request base commit SHA');
    }

    const paths = capture(['git', 'diff', '--name-only', '--no-renames', '-z', base, 'HEAD'], {
      cwd: root,
    }).split('\0');
    if (!changesDependencies(paths)) {
      writeJson(values.output, { status: 'skipped', reason: 'No dependency or toolchain changes' });
      console.log('Dependency audit skipped: no dependency or toolchain changes');
      return 0;
    }
  }

  const outcome = collectAudit();
  writeJson(values.output, outcome);
  console.log('Dependency audit: ' + outcome.status);
  return outcome.status === 'passed' ? 0 : 1;
});
