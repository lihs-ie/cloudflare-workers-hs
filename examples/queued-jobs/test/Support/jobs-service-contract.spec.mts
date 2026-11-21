import type * as Module from 'node:module';
import { jsonObject } from '../../../../scripts/testing/Support/json.mts';
import {
  callTestMethod,
  constructTestBoundary,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
/** Node boundary contracts for the actual RPC service; no remote execution claim. */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

const hooks = registerHooks({
  resolve(
    specifier: string,
    context: Module.ResolveHookContext,
    nextResolve: (
      specifier: string,
      context?: Partial<Module.ResolveHookContext>,
    ) => Module.ResolveFnOutput,
  ): import('module').ResolveFnOutput {
    if (specifier === 'cloudflare:workers') {
      return {
        url: 'data:text/javascript,export class WorkerEntrypoint {}',
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});
let service;
try {
  service = await loadTestModule(new URL('../../worker/jobs-service.ts', import.meta.url).href);
} finally {
  hooks.deregister();
}

void test('RPC validation accepts exact byte and batch limits and resets duplicate state per call', () => {
  const validator = constructTestBoundary(service.JobsValidator);
  const jobs = Array.from({ length: 100 }, (_, index) => ({
    identifier: `job_${index}`,
    payload: 'é'.repeat(2048),
  }));
  assert.equal(callTestMethod(validator, 'validate', JSON.stringify(jobs)), 'accepted');
  assert.equal(callTestMethod(validator, 'validate', JSON.stringify(jobs)), 'accepted');
  assert.equal(
    callTestMethod(
      validator,
      'validate',
      JSON.stringify([{ identifier: 'a'.repeat(80), payload: 'x' }]),
    ),
    'accepted',
  );
});

void test('RPC validation rejects malformed batches before any writes', () => {
  const validator = constructTestBoundary(service.JobsValidator);
  for (const encoded of [
    '{',
    'null',
    '{}',
    '42',
    '"jobs"',
    '[]',
    JSON.stringify(
      Array.from({ length: 101 }, (_, index) => ({
        identifier: `j${index}`,
        payload: 'x',
      })),
    ),
  ]) {
    assert.equal(callTestMethod(validator, 'validate', encoded), 'invalid', encoded);
  }
  for (const job of [
    null,
    42,
    'job',
    {},
    { identifier: 42, payload: 'x' },
    { identifier: '', payload: 'x' },
    { identifier: 'a/b', payload: 'x' },
    { identifier: 'a'.repeat(81), payload: 'x' },
    { identifier: 'a' },
    { identifier: 'a', payload: 42 },
    { identifier: 'a', payload: '' },
    { identifier: 'a', payload: 'é'.repeat(2048) + 'x' },
  ]) {
    assert.equal(
      callTestMethod(validator, 'validate', JSON.stringify([job])),
      'invalid',
      JSON.stringify(job),
    );
  }
  assert.equal(
    callTestMethod(
      validator,
      'validate',
      JSON.stringify([
        { identifier: 'same', payload: 'one' },
        { identifier: 'same', payload: 'two' },
      ]),
    ),
    'invalid',
  );
});

void test('HTTP does not expose the RPC service', async () => {
  const response = callTestMethod(jsonObject(service.default), 'fetch');
  assert.equal(jsonObject(response).status, 404);
  assert.equal(await callTestMethod(response, 'text'), 'RPC service');
});
