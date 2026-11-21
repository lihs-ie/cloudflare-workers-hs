import { spawn } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { digest, textFile } from './cli.mts';
import type { CommandEvidence } from './evidence-io.mts';

interface Options {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

export interface CommandLog extends CommandEvidence {
  output: string;
  timed_out: boolean;
}

export async function runLogged(
  directory: string,
  logName: string,
  argv: readonly string[],
  options: Options,
): Promise<CommandLog> {
  const [program, ...args] = argv;

  if (!program) {
    throw new Error('Missing command executable');
  }

  const log = join(directory, logName);
  const fd = openSync(log, 'w');
  let timedOut = false;
  try {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    const exit = await new Promise<number>((done) => {
      const timeout =
        options.timeout === undefined
          ? undefined
          : setTimeout(() => {
              if (child.pid === undefined || child.exitCode !== null) {
                return;
              }

              timedOut = true;
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch (error) {
                if (
                  typeof error !== 'object' ||
                  error === null ||
                  !('code' in error) ||
                  error.code !== 'ESRCH'
                ) {
                  child.kill('SIGKILL');
                }
              }
            }, options.timeout);
      child.once('error', (error) => {
        clearTimeout(timeout);
        writeFileSync(fd, error.message + '\n');
        done(127);
      });
      child.once('close', (code) => {
        clearTimeout(timeout);
        done(timedOut ? 124 : (code ?? 1));
      });
    });
    return {
      command: argv,
      cwd: options.cwd,
      exitCode: exit,
      log: logName,
      logSha256: digest(log),
      output: textFile(log),
      timed_out: timedOut,
    };
  } finally {
    closeSync(fd);
  }
}
