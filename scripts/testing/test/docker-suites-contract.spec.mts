import { jsonArray, jsonObject, jsonSequence, jsonValue } from '../Support/json.mts';
import { moduleBoundary } from '../Support/module-boundaries.mts';
import assert from 'node:assert/strict';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { test, mock } from 'node:test';
import type { SpawnOptionsWithoutStdio } from 'child_process';
const source = fileURLToPath(
  new URL('../../../scripts/testing/docker-suites.mts', import.meta.url),
);
for (const scenario of ['success', 'failure', 'signal', 'empty', 'spawn-error']) {
  void test(`Docker suite orchestration: ${scenario}`, async () => {
    const records = new Map<string, string>();
    const launches: string[][] = [];
    let active = 0;
    let maximumActive = 0;
    const exitCode = process.exitCode;
    const boundaries = [
      moduleBoundary('node:fs/promises', {
        namedExports: {
          mkdir: async () => {},
          readdir: async () =>
            scenario === 'empty' ? ['README.md'] : ['z.spec.mts', 'README.md', 'a.spec.mts'],
          writeFile: async (filename: string, data: string) => {
            records.set(path.basename(filename), data);
          },
        },
      }),
      moduleBoundary('node:child_process', {
        namedExports: {
          spawn: (
            command: unknown,
            args: string[],
            options?: SpawnOptionsWithoutStdio | undefined,
          ) => {
            assert.equal(command, process.execPath);
            launches.push(args);
            const code = (() => {
              if (launches.length === 2 && scenario === 'failure') {
                return 'process.exit(7)';
              }

              if (launches.length === 2 && scenario === 'signal') {
                return "process.kill(process.pid,'SIGTERM')";
              }

              return "process.stdout.write('out');process.stderr.write('err')";
            })();
            const child = realSpawn(
              scenario === 'spawn-error'
                ? '/nonexistent/docker-contract-command'
                : process.execPath,
              ['-e', code],
              options,
            );
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            child.once('close', () => {
              active -= 1;
            });
            return child;
          },
        },
      }),
    ];
    try {
      const execution = import(`${pathToFileURL(source)}?scenario=${scenario}`);

      if (['empty', 'spawn-error'].includes(scenario)) {
        await assert.rejects(execution, scenario === 'empty' ? /No integration tests/ : /ENOENT/);
        assert.equal(records.has('results.json'), false);

        if (scenario === 'empty') {
          assert.equal(launches.length, 0);
        }
      } else {
        await execution;
        const result = jsonValue(records.get('results.json') ?? '{}');
        assert.equal(launches.length, 7, 'one suite failure does not skip remaining suites');
        assert.equal(maximumActive, 7, 'independent suites start before waiting for completion');
        assert.equal(jsonSequence(jsonObject(result).results).length, 7);
        assert.equal(jsonObject(result).complete, scenario === 'success');
        assert.equal(process.exitCode, scenario === 'success' ? 0 : 1);
        assert.deepEqual(launches[1].slice(0, 2), ['--test', '--test-concurrency=1']);
        assert.ok(launches[1][2].endsWith('a.spec.mts'));
        assert.ok(launches[1][3].endsWith('z.spec.mts'));
        assert.equal((records.get('url-shortener.log') ?? '').includes('out'), true);
        assert.equal((records.get('url-shortener.log') ?? '').includes('err'), true);

        if (scenario === 'failure') {
          assert.equal(jsonObject(jsonArray(jsonObject(result).results)[1]).exitCode, 7);
        }

        if (scenario === 'signal') {
          assert.equal(jsonObject(jsonArray(jsonObject(result).results)[1]).signal, 'SIGTERM');
        }
      }
    } finally {
      process.exitCode = exitCode;
      for (const boundary of boundaries) {
        boundary.restore();
      }
    }
  });
}
