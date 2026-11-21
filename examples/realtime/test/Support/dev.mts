import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startWorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import type { WorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import { instrumentConfig } from '../../../../scripts/testing/Support/workerd_js.mts';
import { verifyBuild } from './build-manifest.mts';

const directory = fileURLToPath(new URL('../..', import.meta.url));

export async function startDev(options: { config?: string } = {}): Promise<WorkerProcess> {
  verifyBuild();
  const coverage = await instrumentConfig(
    options.config ?? path.join(directory, 'wrangler.jsonc'),
    'test/Support/entry.ts',
  );

  return startWorkerProcess({
    directory,
    verify: verifyBuild,
    artifactDirectory: path.resolve(directory, '../../artifacts/testing'),
    readyPath: '/health',
    release: coverage.close,
    command(port: number, state: string): { executable: string; arguments: string[] } {
      return {
        executable: process.execPath,
        arguments: [
          path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js'),
          'dev',
          ...(process.env.WORKERD_JS_COVERAGE_ENDPOINT ? [] : ['test/Support/entry.ts']),
          '--config',
          coverage.config,
          '--port',
          String(port),
          '--ip',
          '127.0.0.1',
          '--persist-to',
          state,
          '--inspector-port',
          '0',
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
}
