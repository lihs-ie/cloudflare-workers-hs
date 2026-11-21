import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  callTestBoundary,
  callTestMethod,
  loadTestModule,
} from '../../../../scripts/testing/Support/test-boundary.mts';
import { jsonArray, jsonObject, jsonSequence } from '../../../../scripts/testing/Support/json.mts';
const request = (path: string, options?: RequestInit): Request =>
  new Request('https://fixture.test' + path, options);
import { exerciseCachePurge } from './cache-purge.ts';
void test('custom cache fixture injects each response and records exact options', async () => {
  for (const scenario of ['success', 'missing', 'throw', 'malformed-success', 'null', 'rejected']) {
    const options = { tags: ['a'] };
    const result = await callTestBoundary(
      exerciseCachePurge,
      async (context: unknown, operation: unknown) => {
        assert.equal(operation, 'tags');

        if (scenario === 'missing') {
          assert.deepEqual(context, {});
          return '"missing"';
        }

        if (scenario === 'throw') {
          await assert.rejects(
            Promise.resolve(
              callTestMethod(jsonObject(jsonObject(context).cache), 'purge', options),
            ),
            /injected custom purge/,
          );
          return '"throw"';
        }

        const value = await callTestMethod(jsonObject(jsonObject(context).cache), 'purge', options);
        const expected: Record<string, unknown> = {
          success: { success: true, errors: [] },
          'malformed-success': { success: 'true', errors: [] },
          null: null,
          rejected: {
            success: false,
            errors: [{ code: 1001, message: 'fixture policy refusal' }],
          },
        };
        assert.deepEqual(value, expected[scenario]);
        return JSON.stringify(value);
      },
      request(scenario === 'success' ? '/' : `/?scenario=${scenario}&operation=tags`),
    );
    assert.deepEqual(
      jsonObject(await callTestMethod(result, 'json')).calls,
      scenario === 'missing' ? [] : [options],
    );
  }
  await assert.rejects(
    Promise.resolve(callTestBoundary(exerciseCachePurge, async () => 'invalid-json', request('/'))),
    SyntaxError,
  );
});
