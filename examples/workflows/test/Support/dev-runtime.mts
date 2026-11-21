import { jsonArray, jsonString } from '../../../../scripts/testing/Support/json.mts';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startWorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import type { WorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import { instrumentConfig } from '../../../../scripts/testing/Support/workerd_js.mts';
import { verifyBuild } from './build-manifest.mts';

export const directory = fileURLToPath(new URL('../..', import.meta.url));
export interface WorkflowRuntime extends WorkerProcess {
  dispose(): Promise<void>;
  port: number;
  evidence: string;
}

export async function startRuntime(
  options: { state?: string; port?: number } = {},
): Promise<WorkflowRuntime> {
  verifyBuild();
  const state = options.state ?? (await mkdtemp(path.join(tmpdir(), 'haskell-workflows-')));
  const wrangler = path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js');
  const coverage = await instrumentConfig(
    path.join(directory, 'wrangler.jsonc'),
    'test/Support/entry.ts',
  );

  try {
    if (!options.state) {
      const migration = spawnSync(
        process.execPath,
        [
          wrangler,
          'd1',
          'execute',
          'AUDIT',
          '--local',
          '--config',
          'wrangler.jsonc',
          '--persist-to',
          state,
          '--file',
          'migrations/0001_audit.sql',
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 60000,
          env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
        },
      );

      if (migration.error || migration.status !== 0) {
        throw (
          migration.error ??
          new Error(`migration failed ${migration.status}: ${migration.stdout} ${migration.stderr}`)
        );
      }
    }

    const running = await startWorkerProcess({
      directory,
      verify: verifyBuild,
      state,
      port: options.port,
      preserveState: true,
      artifactDirectory: path.resolve(directory, '../../artifacts/testing'),
      startupTimeout: 90000,
      release: coverage.close,
      command(port: number): { executable: string; arguments: string[] } {
        return {
          executable: process.execPath,
          arguments: [
            wrangler,
            'dev',
            ...(process.env.WORKERD_JS_COVERAGE_ENDPOINT ? [] : ['test/Support/entry.ts']),
            '--local',
            '--config',
            coverage.config,
            '--port',
            String(port),
            '--inspector-port',
            '0',
            '--persist-to',
            state,
            ...(process.env.WASM_COVERAGE_ENDPOINT
              ? [
                  '--define',
                  `WASM_COVERAGE_ENDPOINT:${JSON.stringify(process.env.WASM_COVERAGE_ENDPOINT)}`,
                ]
              : []),
          ],
        };
      },
    });
    let closing: Promise<void> | undefined;
    function close(): Promise<void> {
      closing ??= (async () => {
        try {
          const endpoint = process.env.WASM_COVERAGE_ENDPOINT;
          if (endpoint) {
            const response = await fetch(running.base + '/__coverage/workflow-snapshots', {
              signal: AbortSignal.timeout(10000),
            });
            if (!response.ok) {
              throw new Error(`Workflow snapshots failed: ${response.status}`);
            }

            for (const snapshot of jsonArray(await response.json())) {
              const saved = await fetch(endpoint, {
                method: 'POST',
                body: jsonString(snapshot),
                signal: AbortSignal.timeout(10000),
              });
              if (saved.status !== 204) {
                throw new Error(`Workflow snapshot upload failed: ${saved.status}`);
              }
            }
          }
        } finally {
          await running.close();
        }
      })();
      return closing;
    }

    let disposing: Promise<void> | undefined;
    function dispose(): Promise<void> {
      disposing ??= (async () => {
        try {
          await close();
        } finally {
          await rm(state, { recursive: true, force: true });
        }
      })();
      return disposing;
    }

    return {
      ...running,
      close,
      dispose,
      port: Number(new URL(running.base).port),
      evidence: path.dirname(running.logPath),
    };
  } catch (error) {
    await coverage.close();

    if (!options.state) {
      await rm(state, { recursive: true, force: true });
    }

    throw error;
  }
}
