import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startWorkerProcess } from '../Support/worker-process.mts';

for (const scenario of ['healthy', 'unhealthy', 'early-exit', 'spawn-error', 'forced-shutdown']) {
  void test(`${scenario}: process startup preserves diagnostics and releases owned state`, async (context) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'worker-process-test-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    let state = '';
    let released = 0;
    const start = startWorkerProcess({
      directory,
      artifactDirectory: directory,
      startupTimeout: 5000,
      shutdownTimeout: 50,
      async release(): Promise<void> {
        released++;
      },
      command(port: number, storage: string): { executable: string; arguments: string[] } {
        state = storage;
        const program = (() => {
          if (scenario === 'early-exit') {
            return "process.stderr.write('early failure');process.exit(23)";
          }

          return `
          const http = require('node:http');
          const server = http.createServer((request, response) => {response.writeHead(${scenario === 'unhealthy' ? 503 : 200});response.end('ok');});
          server.listen(${port}, '127.0.0.1', () => process.stdout.write('ready'));
          process.on('SIGTERM', () => ${scenario === 'forced-shutdown' ? '{}' : 'server.close(() => process.exit(0))'});
        `;
        })();
        return {
          executable:
            scenario === 'spawn-error' ? path.join(directory, 'missing') : process.execPath,
          arguments: ['-e', program],
        };
      },
    });

    if (scenario === 'healthy' || scenario === 'forced-shutdown') {
      const running = await start;
      assert.equal((await fetch(running.base)).status, 200);
      await Promise.all([running.close(), running.close()]);
      assert.match(await readFile(running.logPath, 'utf8'), /ready/);
    } else {
      await assert.rejects(
        start,
        (() => {
          if (scenario === 'unhealthy') {
            return /503/;
          }

          if (scenario === 'early-exit') {
            return /23/;
          }

          return /ENOENT/;
        })(),
      );
    }

    assert.equal(released, 1);
    await assert.rejects(access(state), /ENOENT/);
  });
}
