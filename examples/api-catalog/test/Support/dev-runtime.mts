import { collectCoverageOnClose } from '../../../../scripts/testing/Support/reactor-coverage.mts';
import { jsonValue } from '../../../../scripts/testing/Support/json.mts';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { startWorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import type { WorkerProcess } from '../../../../scripts/testing/Support/worker-process.mts';
import { instrumentConfig } from '../../../../scripts/testing/Support/workerd_js.mts';
import { startClientHttpFixture } from './client-http-fixture.mts';
import { startSocketFixtures } from './socket-fixtures.mts';
import { verifyBuild } from './build-manifest.mts';

export const directory = fileURLToPath(new URL('../..', import.meta.url));
export interface CatalogueRuntime extends WorkerProcess {
  evidence: string;
  clientHttpFixture: Awaited<ReturnType<typeof startClientHttpFixture>>;
}

export async function startRuntime(): Promise<CatalogueRuntime> {
  verifyBuild();
  const state = await mkdtemp(path.join(tmpdir(), 'api-catalog-'));
  const releases: (() => Promise<unknown>)[] = [];

  let released = false;
  async function release(): Promise<void> {
    if (released) {
      return;
    }

    released = true;
    const results = await Promise.allSettled(releases.map((close) => close()));
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result): unknown => result.reason);

    if (failures.length) {
      throw new AggregateError(failures, 'Catalogue cleanup failed');
    }
  }

  try {
    const sockets = await startSocketFixtures();
    releases.push(() => sockets.close());
    const clientHttpFixture = await startClientHttpFixture();
    releases.push(() => clientHttpFixture.close());
    const configurations: string[] = [];
    for (const [filename, label, main] of [
      ['test/Support/wrangler.jsonc', 'primary', 'test/Support/entry.ts'],
      ['wrangler.guide.jsonc', 'guide', 'test/Support/entry.ts'],
      ['wrangler.tail.jsonc', 'tail', 'test/Support/tail-entry.ts'],
    ] as const) {
      const input: unknown = jsonValue(await readFile(path.join(directory, filename), 'utf8'));
      const config = z
        .object({ vars: z.record(z.string(), z.unknown()).optional() })
        .passthrough()
        .parse(input);
      const temporary = path.join(
        directory,
        `.dev-test-${label}-${process.pid}-${Date.now()}.json`,
      );
      await writeFile(
        temporary,
        JSON.stringify({
          ...config,
          main,
          vars: {
            ...config.vars,
            ...sockets.variables,
            CLIENT_ORIGIN: clientHttpFixture.origin,
            EXAMPLE_MODE: 'fixture',
          },
        }),
      );
      releases.push(() => rm(temporary, { force: true }));
      const coverage = await instrumentConfig(temporary);
      releases.push(coverage.close);
      configurations.push('--config', coverage.config);
    }
    const wrangler = path.resolve(directory, '../../node_modules/wrangler/bin/wrangler.js');
    const migration = spawnSync(
      process.execPath,
      [
        wrangler,
        'd1',
        'migrations',
        'apply',
        'catalog',
        '--local',
        '--config',
        'wrangler.jsonc',
        '--persist-to',
        state,
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
        migration.error ?? new Error(`D1 migration failed: ${migration.stdout} ${migration.stderr}`)
      );
    }

    const running = await startWorkerProcess({
      directory,
      verify: verifyBuild,
      state,
      release,
      artifactDirectory: path.resolve(directory, '../../artifacts/testing'),
      environment: { NODE_EXTRA_CA_CERTS: sockets.certificate },
      command(port: number): { executable: string; arguments: string[] } {
        return {
          executable: process.execPath,
          arguments: [
            wrangler,
            'dev',
            '--local',
            ...configurations,
            '--port',
            String(port),
            '--inspector-port',
            '0',
            '--persist-to',
            state,
          ],
        };
      },
    });
    return {
      ...collectCoverageOnClose(running, 3),
      evidence: path.dirname(running.logPath),
      clientHttpFixture,
    };
  } catch (error) {
    await Promise.allSettled([release(), rm(state, { recursive: true, force: true })]);
    throw error;
  }
}
