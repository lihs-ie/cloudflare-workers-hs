import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandOptions = Omit<SpawnSyncOptionsWithStringEncoding, 'encoding'>;
export type CommandRunner = (argv: readonly string[], options?: CommandOptions) => CommandResult;

export const command: CommandRunner = (argv, options = {}) => {
  const [program, ...args] = argv;

  if (program === undefined) {
    throw new Error('A command requires an executable');
  }

  const result = spawnSync(program, args, {
    maxBuffer: 128 * 1024 * 1024,
    ...options,
    encoding: 'utf8',
  });
  if (result.error) {
    throw result.error;
  }

  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

export function capture(argv: readonly string[], options: CommandOptions = {}): string {
  const result = command(argv, options);
  if (result.code !== 0) {
    throw new Error(
      `${argv[0]} exited with status ${result.code}\n${result.stderr || result.stdout}`,
    );
  }

  return result.stdout;
}

export function textFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function jsonFile(path: string): unknown {
  return JSON.parse(textFile(path));
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

export function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export function executableOnPath(name: string, searchPath: string, cwd: string): string {
  for (const directory of searchPath.split(delimiter)) {
    const path = resolve(cwd, directory, name);
    try {
      accessSync(path, constants.X_OK);

      if (isFile(path)) {
        return absolutePath(path);
      }
    } catch {
      continue;
    }
  }

  throw new Error('Executable unavailable on recorded PATH: ' + name);
}

export function absolutePath(path: string): string {
  if (existsSync(path)) {
    return realpathSync(path);
  }

  const parent = dirname(path);
  if (path === parent) {
    return path;
  }

  return resolve(absolutePath(parent), relative(parent, path));
}

export function within(root: string, path: string): boolean {
  const name = relative(root, path);
  return !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep);
}

export function files(root: string, skip?: (name: string) => boolean): string[] {
  if (!isDirectory(root)) {
    return [];
  }

  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (skip?.(entry.name)) {
      continue;
    }

    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      result.push(...files(path, skip));
    } else if (!entry.isSymbolicLink() && entry.isFile()) {
      result.push(path);
    }
  }

  return result.sort();
}

export function withTemp<T>(prefix: string, work: (directory: string) => T): T {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  try {
    return work(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function runCli(url: string, run: () => number | Promise<number>): void {
  if (process.argv[1] === undefined || fileURLToPath(url) !== resolve(process.argv[1])) {
    return;
  }

  void Promise.resolve()
    .then(run)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
