import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
const pack = new URL('../pack-consumer.mjs', import.meta.url);
const typecheck = new URL('../typecheck.mts', import.meta.url);
let serial = 0;

for (const scenario of [
  'all',
  'selected-check',
  'unknown',
  'spawn-error',
  'exit-failure',
  'signal-exit',
]) {
  void test(`typecheck command preserves ${scenario} outcome`, async () => {
    const previous = process.argv;
    const calls: { command: string; args: string[]; options: unknown }[] = [];
    const exit = new Error('exited');
    const originalExit = process.exit;
    const error = new Error('cannot spawn');
    const directories = mock.module('node:fs', { namedExports: { mkdirSync(): void {} } });
    const processes = mock.module('node:child_process', {
      namedExports: {
        spawnSync(
          command: string,
          args: string[],
          options: unknown,
        ): { error: Error; status?: undefined } | { status: number | null; error?: undefined } {
          calls.push({ command, args, options });

          if (scenario === 'spawn-error') {
            return { error };
          }

          return {
            status: (() => {
              if (scenario === 'exit-failure') {
                return 2;
              }

              if (scenario === 'signal-exit') {
                return null;
              }

              return 0;
            })(),
          };
        },
      },
    });
    let exitCode;
    process.exit = (code) => {
      exitCode = code;
      throw exit;
    };
    process.argv = [
      process.execPath,
      typecheck.pathname,
      ...(() => {
        if (scenario === 'all') {
          return [];
        }

        if (scenario === 'unknown') {
          return ['../invalid'];
        }

        return ['minimal', '--check'];
      })(),
    ];
    try {
      const operation = import(typecheck.href + `?fixture=${++serial}`);

      if (['all', 'selected-check'].includes(scenario)) {
        await operation;
        assert.ok(calls.some((call) => call.command.endsWith('tsc')));
        assert.equal(
          calls
            .filter((call) => call.command.endsWith('wrangler'))
            .every((call) => call.args.includes('--check')),
          scenario === 'selected-check',
        );
      } else if (scenario === 'unknown') {
        await assert.rejects(operation, /Unknown/);
      } else if (scenario === 'spawn-error') {
        await assert.rejects(operation, error);
      } else {
        await assert.rejects(operation, exit);
        assert.equal(exitCode, scenario === 'exit-failure' ? 2 : 1);
      }
    } finally {
      process.argv = previous;
      process.exit = originalExit;
      processes.restore();
      directories.restore();
    }
  });
}
