import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startWorkerProcess } from '../Support/worker-process.mts';

void test('restart preserves caller-owned state until its owner removes it', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'worker-restart-'));
  const state = await mkdtemp(path.join(tmpdir(), 'worker-persisted-'));
  context.after(() =>
    Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(state, { recursive: true, force: true }),
    ]),
  );
  await writeFile(path.join(state, 'value'), 'persisted');

  for (let attempt = 0; attempt < 2; attempt++) {
    const runtime = await startWorkerProcess({
      directory,
      state,
      preserveState: true,
      artifactDirectory: directory,
      command(port: number): { executable: string; arguments: string[] } {
        return {
          executable: process.execPath,
          arguments: [
            '-e',
            `const server=require('node:http').createServer((request,response)=>response.end('ok'));server.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`,
          ],
        };
      },
    });
    await runtime.close();
    assert.equal(await readFile(path.join(state, 'value'), 'utf8'), 'persisted');
  }
});

void test('startup reports both the primary failure and cleanup failure', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'worker-cleanup-'));
  context.after(() => rm(directory, { recursive: true, force: true }));

  const runtime = startWorkerProcess({
    directory,
    artifactDirectory: directory,
    async release(): Promise<never> {
      throw new Error('cleanup failed');
    },
    command(): { executable: string; arguments: string[] } {
      return { executable: process.execPath, arguments: ['-e', 'process.exit(23)'] };
    },
  });

  await assert.rejects(runtime, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /23/);
    assert.match(String(error.errors[1]), /cleanup/);
    return true;
  });
});
