import { test } from 'node:test';
import assert from 'node:assert/strict';

export function registerSocketFailureTests(request: {
  (path: string, method?: string): Promise<unknown>;
  (arg0: string): unknown;
}): void {
  void test('native TLS rejects the untrusted fixture certificate and a trusted connection recovers', async () => {
    assert.deepEqual(await request('/__fixture/socket/untrusted'), {
      openedRejected: true,
      closedRejected: true,
      closedState: true,
    });
    assert.deepEqual(await request('/tls'), {
      message: 'library-tls\n',
      upgraded: false,
      secureTransport: 'SecureTransportOn',
    });
  });
  void test('concurrent native socket closes settle and reject later writes before a new connection recovers', async () => {
    assert.deepEqual(await request('/__fixture/socket/close-race'), {
      bothCloseSucceeded: true,
      closedState: true,
      lateWriteRejected: true,
    });
    assert.deepEqual(await request('/tcp'), { message: 'api-catalog\n' });
  });
  void test('peer EOF before protocol completion preserves partial bytes and permits a fresh connection', async () => {
    assert.deepEqual(await request('/__fixture/socket/peer-disconnect'), {
      partialBody: true,
      closedState: true,
    });
    assert.deepEqual(await request('/tcp'), { message: 'api-catalog\n' });
  });
}
