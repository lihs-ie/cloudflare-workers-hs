import { instrumentConfig } from '../../../../scripts/testing/Support/workerd_js.mts';
import { collectCoverageOnClose } from '../../../../scripts/testing/Support/reactor-coverage.mts';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startWorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import type { WorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import { verifyBuild } from './build-manifest.mts';

const directory = fileURLToPath(new URL('../..', import.meta.url));

export async function startRuntime(): Promise<WorkerProcess> {
  verifyBuild();
  const migrationState = await mkdtemp(path.join(tmpdir(), 'queued-jobs-state-'));
  const executable = path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js');

  const cleanups: (() => Promise<void>)[] = [
    () => rm(migrationState, { recursive: true, force: true }),
  ];
  async function release(): Promise<void> {
    const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result): unknown => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, 'Queued jobs cleanup failed');
    }
  }

  try {
    const application = await instrumentConfig(path.join(directory, 'test/Support/wrangler.jsonc'));
    cleanups.push(application.close);
    const validator = await instrumentConfig(path.join(directory, 'wrangler.validator.jsonc'));
    cleanups.push(validator.close);
    return collectCoverageOnClose(
      await startWorkerProcess({
        directory,
        verify: verifyBuild,
        artifactDirectory: path.resolve(directory, '../../artifacts/testing'),
        release,
        command(port: number): { executable: string; arguments: string[] } {
          const migration = spawnSync(
            process.execPath,
            [
              executable,
              'd1',
              'migrations',
              'apply',
              'library-jobs',
              '--local',
              '--config',
              'wrangler.jsonc',
              '--persist-to',
              migrationState,
            ],
            {
              cwd: directory,
              encoding: 'utf8',
              env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
            },
          );

          if (migration.error || migration.status !== 0) {
            throw (
              migration.error ??
              new Error(`D1 migration failed: ${migration.stdout} ${migration.stderr}`)
            );
          }

          return {
            executable: process.execPath,
            arguments: [
              executable,
              'dev',
              '--local',
              '--config',
              application.config,
              '--config',
              validator.config,
              '--port',
              String(port),
              '--persist-to',
              migrationState,
              '--inspector-port',
              '0',
            ],
          };
        },
      }),
      3,
    );
  } catch (error) {
    try {
      await release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Queued jobs startup and cleanup failed');
    }
    throw error;
  }
}
