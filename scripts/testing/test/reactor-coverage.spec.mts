import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { collectCoverageOnClose } from '../Support/reactor-coverage.mts';
import type { WorkerProcess } from '../Support/worker-process.mts';

for (const scenario of ['success', 'malformed-snapshots', 'upload-failure', 'cleanup-failure']) {
  void test(`${scenario}: coverage close drains snapshots and always closes the Worker once`, async (context) => {
    let uploads = 0;
    let closes = 0;
    const server = createServer((request, response) => {
      if (request.url === '/__fixture/coverage') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify(scenario === 'malformed-snapshots' ? ['ticks'] : ['one', 'two']),
        );
        return;
      }

      uploads++;
      request.resume();
      response.writeHead(scenario === 'upload-failure' ? 503 : 204);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const previous = process.env.WASM_COVERAGE_ENDPOINT;
    process.env.WASM_COVERAGE_ENDPOINT = `${base}/upload`;
    context.after(() => {
      if (previous === undefined) {
        delete process.env.WASM_COVERAGE_ENDPOINT;
      } else {
        process.env.WASM_COVERAGE_ENDPOINT = previous;
      }
    });
    const worker: WorkerProcess = {
      base,
      state: '/unused',
      logPath: '/unused',
      logs: () => '',
      getLogs: () => '',
      async close(): Promise<void> {
        closes++;

        if (scenario === 'cleanup-failure') {
          throw new Error('cleanup failed');
        }
      },
    };
    const observed = collectCoverageOnClose(worker, 2);
    const first = observed.close();
    assert.equal(observed.close(), first);

    if (scenario === 'success') {
      await first;
    } else {
      await assert.rejects(first, AggregateError);
    }

    assert.equal(closes, 1);
    assert.equal(
      uploads,
      (() => {
        if (scenario === 'malformed-snapshots') {
          return 0;
        }

        if (scenario === 'upload-failure') {
          return 1;
        }

        return 2;
      })(),
    );
  });
}
