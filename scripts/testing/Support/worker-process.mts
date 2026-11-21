import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchReadiness } from './readiness.mts';

export interface WorkerProcessOptions {
  directory: string;
  artifactDirectory: string;
  command(port: number, state: string): { executable: string; arguments: string[] };
  readyPath?: string;
  state?: string;
  port?: number;
  preserveState?: boolean;
  startupTimeout?: number;
  shutdownTimeout?: number;
  environment?: Partial<NodeJS.ProcessEnv>;
  release?(): Promise<void>;
  verify?(): void;
}

export interface WorkerProcess {
  base: string;
  state: string;
  logPath: string;
  logs(): string;
  getLogs(): string;
  close(): Promise<void>;
}

async function freePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const address = socket.address();

  if (address === null || typeof address === 'string') {
    socket.close();
    throw new Error('Expected a TCP listening address');
  }

  await new Promise<void>((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function connectionRefused(error: unknown): boolean {
  if (!(error instanceof Error) || typeof error.cause !== 'object' || error.cause === null) {
    return false;
  }

  return 'code' in error.cause && error.cause.code === 'ECONNREFUSED';
}

export async function startWorkerProcess(options: WorkerProcessOptions): Promise<WorkerProcess> {
  const port = options.port ?? (await freePort());
  const state = options.state ?? (await mkdtemp(path.join(tmpdir(), 'haskell-worker-')));
  const artifact = path.join(
    options.artifactDirectory,
    `worker-${Date.now()}-${process.pid}-${port}`,
  );
  await mkdir(artifact, { recursive: true });
  const logPath = path.join(artifact, 'wrangler.log');
  let command: ReturnType<WorkerProcessOptions['command']>;
  try {
    command = options.command(port, state);
  } catch (error) {
    await Promise.allSettled([rm(state, { recursive: true, force: true }), options.release?.()]);
    throw error;
  }
  const child = spawn(command.executable, command.arguments, {
    cwd: options.directory,
    detached: true,
    env: { ...process.env, ...options.environment, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  child.on('error', (error) => {
    failure = error;
  });
  child.stdout.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    logs += chunk.toString();
  });

  async function stop(): Promise<void> {
    const identifier = child.pid;

    if (identifier && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        process.kill(-identifier, 'SIGTERM');
      } catch {}
      const forced = setTimeout(() => {
        try {
          process.kill(-identifier, 'SIGKILL');
        } catch {}
      }, options.shutdownTimeout ?? 3000);
      await exited;
      clearTimeout(forced);
    }

    const cleanup = await Promise.allSettled([
      writeFile(logPath, logs),
      options.preserveState ? undefined : rm(state, { recursive: true, force: true }),
      options.release?.(),
      Promise.resolve().then(() => options.verify?.()),
    ]);
    const errors = cleanup
      .filter((result) => result.status === 'rejected')
      .map((result): unknown => result.reason);

    if (errors.length) {
      throw new AggregateError(errors, 'Worker cleanup failed');
    }
  }

  function close(): Promise<void> {
    closing ??= stop();
    return closing;
  }

  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + (options.startupTimeout ?? 60000);
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null || child.signalCode !== null) {
        throw (
          failure ?? new Error(`Wrangler exited ${child.exitCode}/${child.signalCode}\n${logs}`)
        );
      }

      try {
        const response = await fetchReadiness(`${base}${options.readyPath ?? '/health'}`, deadline);

        if (!response.ok) {
          throw new Error(`Wrangler readiness returned ${response.status}; logs: ${logPath}`);
        }

        return { base, state, logPath, logs: () => logs, getLogs: () => logs, close };
      } catch (error) {
        if (!connectionRefused(error)) {
          throw error;
        }
      }

      await delay(100);
    }
    throw new Error(`Wrangler readiness timeout\n${logs}`);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Worker startup and cleanup failed');
    }
    throw error;
  }
}
