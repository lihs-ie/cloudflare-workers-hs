import assert from 'node:assert/strict';
import { test } from 'vitest';
import { jwksCacheScenarios } from '../../../../tests/runtime/harness.js';

test('JWKS cache preserves TTL, throttling and concurrent refresh contracts in real WASM', async () => {
  const scenarios = await jwksCacheScenarios();

  assert.deepEqual(scenarios, [
    'ttl-boundary',
    'url-isolation',
    'expired-refresh-recovery',
    'uninformative-miss-recovery',
    'miss-throttle-boundary',
    'zero-ttl',
    'cached-ambiguity',
    'newer-throttle-survives-older-failure',
    'newer-key-survives-older-success',
    'foreign-url-survives-older-failure',
    'newer-miss-stamp-survives-older-failure',
  ]);
});
