import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fetchReadiness } from '../Support/readiness.mts';
import type { RequestListener, IncomingMessage, ServerResponse } from 'http';

async function fixture(t: test.TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

void test('readiness waits for a successful body beyond the former one-second cutoff', async (t) => {
  const url = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.flushHeaders();
    setTimeout(() => response.end('ready'), 1100);
  });
  const response = await fetchReadiness(url, Date.now() + 5000);
  assert.equal(response.status, 200);
  assert.equal(response.bodyUsed, true);
});

void test('readiness keeps the startup deadline active while the body stalls', async (t) => {
  const url = await fixture(t, (_request, response) => {
    response.writeHead(200);
    response.flushHeaders();
  });
  await assert.rejects(fetchReadiness(url, Date.now() + 100));
});

void test('readiness exposes HTTP failures without retrying', async (t) => {
  let requests = 0;
  const url = await fixture(t, (_request, response) => {
    requests += 1;
    response.writeHead(500);
    response.end('failed');
  });
  const response = await fetchReadiness(url, Date.now() + 5000);
  assert.equal(response.status, 500);
  assert.equal(requests, 1);
});
