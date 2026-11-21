import { jsonArray, jsonObject, jsonValue } from '../../../../scripts/testing/Support/json.mts';
import type { startRuntime } from '../Support/dev-runtime.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';

export function registerMiscExampleExtraCases(
  getRuntime: () => Awaited<ReturnType<typeof startRuntime>>,
): void {
  const send = (path: string, options: {} = {}): Promise<Response> =>
    fetch(getRuntime().base + path, { ...options, signal: AbortSignal.timeout(15000) });
  void test('application echo preserves Unicode and conflict preserves its explicit status', async () => {
    const echoed = await send('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify('日本語\\nquoted text'),
    });
    assert.equal(echoed.status, 200);
    assert.equal(await echoed.json(), '日本語\\nquoted text');
    const conflict = await send('/conflict');
    assert.equal(conflict.status, 409);
    await conflict.text();
  });
  void test('configuration accepts empty strings but only reports configured when both values are nonempty', async () => {
    for (const [mode, secret, configured] of [
      ['', '', false],
      ['ready', '', false],
      ['', 'secret-marker', false],
      ['ready', 'secret-marker', true],
    ] as const) {
      const response = await send(
        `/__fixture/misc/configuration?${new URLSearchParams({ mode, secret })}`,
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { configured, secretRedacted: true });
    }
  });
  void test('KV walkthrough preserves legitimate missing reads after concurrent deletion', async () => {
    const response = await send('/__fixture/misc/storage?mode=missing-values', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      json: null,
      binary: [],
      stream: Array.from(new TextEncoder().encode('stream value')),
    });
  });
  for (const mode of ['missing-stream', 'stream-error', 'oversized']) {
    void test(`KV walkthrough sanitizes ${mode}`, async () => {
      const response = await send(`/__fixture/misc/storage?mode=${mode}`, { method: 'POST' });
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'internal_error' });
    });
  }
  for (const path of ['/tcp', '/tcp-structured', '/tls']) {
    for (const mode of ['opened', 'write', 'finish', 'read', 'utf8', 'close', 'oversized']) {
      void test(`${path} sanitizes native ${mode} failure and closes the acquired socket`, async () => {
        const response = await send(
          `/__fixture/misc/socket?${new URLSearchParams({ path, mode })}`,
        );
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(jsonObject(result).status, 500);
        assert.deepEqual(jsonValue(jsonObject(result).body), { error: 'internal_error' });
        assert.equal(jsonArray(jsonObject(result).calls)[0], 'connect');
        assert.ok(jsonArray(jsonObject(result).calls).includes('close'));
      });
    }
  }
  for (const address of ['hostname', ':1234', 'host:0', 'host:65536', 'host:abc']) {
    void test(`structured socket rejects invalid configured endpoint ${address} before connecting`, async () => {
      const response = await send(`/__fixture/misc/socket?${new URLSearchParams({ address })}`);
      const result = await response.json();
      assert.equal(jsonObject(result).status, 500);
      assert.deepEqual(jsonObject(result).calls, []);
    });
  }
  void test('structured socket reports closed-promise rejection after close', async () => {
    const result = await (await send('/__fixture/misc/socket?mode=closed')).json();
    assert.equal(jsonObject(result).status, 500);
    assert.deepEqual(jsonValue(jsonObject(result).body), { error: 'internal_error' });
    assert.ok(jsonArray(jsonObject(result).calls).includes('close'));
  });
  void test('StartTLS native upgrade failure is sanitized and original socket is closed', async () => {
    const result = await (await send('/__fixture/misc/socket?path=/starttls&mode=upgrade')).json();
    assert.equal(jsonObject(result).status, 500);
    assert.ok(jsonArray(jsonObject(result).calls).includes('startTls'));
    assert.ok(jsonArray(jsonObject(result).calls).includes('close'));
  });
  for (const mode of ['write', 'upgraded-opened']) {
    void test(`StartTLS ${mode} fails safely and closes the acquired transport`, async () => {
      const result = await (
        await send(`/__fixture/misc/socket?path=/starttls&mode=${mode}`)
      ).json();
      assert.equal(jsonObject(result).status, 500);
      assert.deepEqual(jsonValue(jsonObject(result).body), { error: 'internal_error' });
      assert.ok(jsonArray(jsonObject(result).calls).includes('close'));
    });
  }
  for (const [scenario, mode] of [
    ['unknown', 'success'],
    ['close-race', 'opened'],
    ['peer-disconnect', 'opened'],
    ['peer-disconnect', 'write'],
  ] as const) {
    void test(`public socket failure helper handles ${scenario} with ${mode}`, async () => {
      const result = await (
        await send(`/__fixture/misc/support-socket?case=${scenario}&mode=${mode}`)
      ).json();
      assert.deepEqual(jsonObject(result).outcome, { rejected: true });
      assert.ok(jsonArray(jsonObject(result).calls).includes('close'));
    });
  }
  void test('storage validation helper rejects unknown dispatch', async () => {
    const response = await send('/__fixture/misc-storage-unknown');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { rejected: true });
  });
  void test('storage validation records native option refusal without assuming local acceptance', async () => {
    const response = await send('/__fixture/misc/storage-refusal');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(jsonObject(result).zeroLimitKeys, []);
    assert.deepEqual(jsonObject(result).malformedCursorKeys, []);
    assert.equal(jsonObject(result).negativeLimitAccepted, false);
    assert.equal(jsonObject(result).malformedCursorAccepted, false);
    assert.equal(jsonObject(result).recovered, 'not JSON');
  });
  void test('fresh structured socket succeeds after failure scenarios', async () => {
    const result = await (await send('/__fixture/misc/socket?mode=success')).json();
    assert.equal(jsonObject(result).status, 200);
    assert.deepEqual(jsonValue(jsonObject(result).body), {
      message: 'fixture greeting\n',
      port: 1234,
      state: 'SocketClosed',
    });
  });
  void test('service walkthrough sanitizes an upstream conflict endpoint that unexpectedly succeeds', async () => {
    const response = await send('/__fixture/misc/service');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  });
  void test('catalog walkthrough tolerates a concurrent deletion between seed and read', async () => {
    const response = await send('/__fixture/misc/database', { method: 'POST' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(jsonObject(result).written, true);
    assert.equal(jsonObject(result).firstPresent, false);
    assert.equal(jsonObject(result).rows, 0);
    assert.equal(jsonObject(result).title, null);
    const recovered = await send('/database/catalog', { method: 'POST' });
    assert.equal(recovered.status, 200);
    assert.equal(jsonObject(await recovered.json()).firstPresent, true);
  });
  void test('logging public helper rejects unknown profile and accepts the next valid call', async () => {
    const response = await send('/__fixture/misc-logging');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      rejected: true,
      recovered: { profile: 'warnings', reported: true },
    });
  });
  void test('unknown storage scenario fails without leaking diagnostics', async () => {
    const response = await send('/storage/unknown-scenario', { method: 'POST' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal_error' });
  });
}
