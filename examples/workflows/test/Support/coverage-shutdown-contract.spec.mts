import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeWorkflowCoverageSnapshots } from './coverage-shutdown.ts';

void test('completed Workflow snapshots are transferred once and later snapshots remain available', (t) => {
  const previous = globalThis.workflowCoverageSnapshots;
  t.after(() => {
    globalThis.workflowCoverageSnapshots = previous;
  });
  globalThis.workflowCoverageSnapshots = ['first', 'second'];

  assert.deepEqual(takeWorkflowCoverageSnapshots(), ['first', 'second']);
  assert.deepEqual(takeWorkflowCoverageSnapshots(), []);
  globalThis.workflowCoverageSnapshots.push('later');
  assert.deepEqual(takeWorkflowCoverageSnapshots(), ['later']);
});
