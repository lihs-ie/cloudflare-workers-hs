import { jsonObject, jsonString } from '../../../../scripts/testing/Support/json.mts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startRuntime } from '../Support/dev-runtime.mts';

void test(
  'coverage upload rejection propagates and the next Workflow request recovers',
  {
    timeout: 90000,
    skip: process.env.WASM_COVERAGE_ENDPOINT
      ? false
      : 'Requires the instrumented WASM build and a live coverage collector',
  },
  async (t) => {
    const worker = await startRuntime();
    t.after(worker.dispose);
    const failure = await fetch(`${worker.base}/__coverage/upload-failure`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(failure.status, 200);
    const result = await failure.json();
    assert.equal(jsonObject(result).rejected, true);
    assert.equal(jsonObject(result).attempts, 1);
    assert.match(jsonString(jsonObject(result).message), /Coverage upload failed: 503/);
    // This real upload must finish before health resolves. Its snapshot also
    // proves the subsequent production invocation remains usable. Each Workflow
    // request intentionally creates its own reactor; this is not same-reactor proof.
    const recovered = await fetch(`${worker.base}/health`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(recovered.status, 200, `logs: ${worker.logPath}`);
    assert.deepEqual(await recovered.json(), { status: 'ok' });
  },
);

void test(
  'fixture reactor upload failure is observed independently and the same instance recovers',
  {
    timeout: 90000,
    skip: process.env.WASM_COVERAGE_ENDPOINT
      ? false
      : 'Requires the instrumented WASM build and a live coverage collector',
  },
  async (t) => {
    const worker = await startRuntime();
    t.after(worker.dispose);
    const response = await fetch(`${worker.base}/__coverage/upload-failure?mode=fixture`, {
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(jsonObject(result).mode, 'fixture');
    assert.equal(jsonObject(result).rejected, true);
    assert.equal(jsonObject(result).attempts, 1);
    assert.equal(jsonObject(result).operations, 3);
    assert.match(jsonString(jsonObject(result).message), /Coverage upload failed: 503/);
    assert.deepEqual(jsonObject(result).recovered, { ok: true, state: 'WorkflowPaused' });
    assert.deepEqual(jsonObject(result).confirmed, jsonObject(result).recovered);
    const health = await fetch(`${worker.base}/health`, { signal: AbortSignal.timeout(10000) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
  },
);

void test(
  'production reactor upload failure is captured by a subsequent snapshot from the same instance',
  {
    timeout: 90000,
    skip: process.env.WASM_COVERAGE_ENDPOINT
      ? false
      : 'Requires the instrumented WASM build and a live coverage collector',
  },
  async (t) => {
    const worker = await startRuntime();
    t.after(worker.dispose);
    const response = await fetch(
      `${worker.base}/__coverage/upload-failure?mode=production-reactor`,
      {
        signal: AbortSignal.timeout(10000),
      },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(jsonObject(result).mode, 'production-reactor');
    assert.equal(jsonObject(result).rejected, true);
    assert.equal(jsonObject(result).attempts, 1);
    assert.equal(jsonObject(result).operations, 3);
    assert.match(jsonString(jsonObject(result).message), /Coverage upload failed: 503/);
    assert.deepEqual(jsonObject(result).recovered, { status: 'ok' });
    assert.deepEqual(jsonObject(result).confirmed, jsonObject(result).recovered);
  },
);
