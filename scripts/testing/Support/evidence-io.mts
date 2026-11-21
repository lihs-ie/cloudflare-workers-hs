import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  absolutePath,
  capture,
  command,
  digest,
  isFile,
  jsonFile,
  textFile,
  within,
  writeJson,
  type CommandOptions,
  type CommandResult,
} from './cli.mts';
import { list, object, string, stringsByName } from './validation.mts';

export type Sources = Record<string, string>;

export interface CommandEvidence {
  command: readonly string[];
  cwd: string;
  exitCode: number;
  log: string;
  logSha256: string;
}

export interface RunEvidence {
  sources: Sources;
  commands: CommandEvidence[];
  errors: string[];
  exit_code: number;
}

export function trackedFiles(root: string): string[] {
  const result = capture(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
  });
  return [...new Set(result.split('\0').filter((name) => name && isFile(join(root, name))))].sort();
}

export function sourceSnapshot(root: string): Sources {
  return Object.fromEntries(
    trackedFiles(root)
      .filter((name) => !name.startsWith('docs/') && name !== 'README.md')
      .map((name) => [name, digest(join(root, name))]),
  );
}

export function equals(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
}

export function childPath(root: string, name: string): string {
  const path = absolutePath(resolve(root, name));
  if (!within(absolutePath(resolve(root)), path)) {
    throw new Error(`Path escapes evidence directory: ${name}`);
  }

  return path;
}

export function verifiedFile(root: string, path: unknown, sha256: unknown): string {
  const file = childPath(root, string(path));
  if (digest(file) !== sha256) {
    throw new Error(`Evidence digest changed: ${file}`);
  }

  return file;
}

export function verifiedFiles(root: string, record: unknown, label: string): string[] {
  const entries = Object.entries(stringsByName(record)).sort(([left], [right]) =>
    left < right ? -1 : Number(left !== right),
  );
  if (entries.length === 0) {
    throw new Error(`Empty evidence: ${label}`);
  }

  return entries.map(([path, sha256]) => verifiedFile(root, path, sha256));
}

export function successfulProof(proof: Record<string, unknown>, sources: Sources): void {
  if (proof.exit_code !== 0 || !equals(proof.errors, []) || !equals(proof.sources, sources)) {
    throw new Error('Unsuccessful or stale evidence');
  }
}

export function commandProof(
  root: string,
  value: unknown,
  verifyLogs: boolean = true,
): Record<string, unknown>[] {
  const records = list(value).map(object);
  if (records.length === 0 || records.some((record) => record.exitCode !== 0)) {
    throw new Error('Missing or failed evidence commands');
  }

  if (verifyLogs) {
    for (const record of records) {
      verifiedFile(root, record.log, record.logSha256);
    }
  }

  return records;
}

export function evidencePath(root: string, prefix: string, output?: string): string {
  const artifacts = join(root, 'artifacts/testing');
  const directory =
    output === undefined ? join(artifacts, `${prefix}-${timestamp()}`) : resolve(output);
  if (!within(artifacts, absolutePath(directory))) {
    throw new Error('Choose a new output directory inside artifacts/testing');
  }

  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory);
  return directory;
}

export function loggedCommand(
  directory: string,
  logName: string,
  argv: readonly string[],
  options: CommandOptions = {},
  echo: boolean = false,
): CommandEvidence & CommandResult {
  const log = join(directory, logName);
  mkdirSync(dirname(log), { recursive: true });
  const descriptor = openSync(log, 'w');
  const cwd = options.cwd === undefined ? process.cwd() : String(options.cwd);

  if (echo) {
    console.log('+ ' + argv.join(' '));
  }

  let code: number;
  try {
    code = command(argv, { ...options, stdio: ['ignore', descriptor, descriptor] }).code;
  } catch (error) {
    const timeout =
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'ETIMEDOUT';
    code = timeout ? 124 : 127;
    const diagnostic = error instanceof Error ? error.message : String(error);
    console.error(diagnostic);
    writeJson(log + '.error.json', { diagnostic, code });
  } finally {
    closeSync(descriptor);
  }

  const stdout = textFile(log);

  if (echo) {
    process.stdout.write(stdout);
  }

  return {
    code,
    stdout,
    stderr: '',
    command: argv,
    cwd,
    exitCode: code,
    log: logName,
    logSha256: digest(log),
  };
}

export function recordCommand(result: CommandEvidence, root?: string): CommandEvidence {
  const { command, cwd, exitCode, log, logSha256 } = result;
  return { command, cwd: root ? relative(root, cwd) || '.' : cwd, exitCode, log, logSha256 };
}

export function publish<T extends Pick<RunEvidence, 'exit_code' | 'errors'>>(
  root: string,
  output: string,
  prefix: string,
  proof: T,
  report?: string,
): void {
  const path = join(output, 'proof.json');
  writeJson(path, proof);

  if (proof.exit_code === 0 && proof.errors.length === 0) {
    writeJson(join(root, 'artifacts/testing', `${prefix}-latest.json`), {
      proof: relative(root, path),
      sha256: digest(path),
      ...(report === undefined ? {} : { report: relative(root, report) }),
    });
  }
}

export function readPointer(root: string, name: string): Record<string, unknown> {
  return object(jsonFile(join(root, 'artifacts/testing', name + '-latest.json')));
}

export function collectFingerprints(
  directory: string,
  paths: readonly string[],
): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [relative(directory, path), digest(path)]));
}
