"""Queue FFI boundary contract tests using actual JavaScript foreign imports.

Synthetic producers exercise compatibility with void and metrics responses. These
checks do not establish that a deployed Cloudflare runtime supports metrics, nor
do they replace the real WASM tests of the Haskell decoder and Queue bindings.
"""
import json
from pathlib import Path
import re
import subprocess
import unittest


SOURCE = (Path(__file__).resolve().parents[3] / 'cloudflare-workers/src/'
          'Cloudflare/Workers/Internal/FFI/Queue.hs')


class QueueNativeBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = SOURCE.read_text()
        imports = re.findall(
            r'foreign import javascript (?:safe|unsafe)\s+'
            r'(?:"""(.*?)"""|"([^"\n]*)")\s+(\w+)\s*::',
            source, re.S)
        cls.snippets = {name: multiline or single for multiline, single, name in imports}

    def check_javascript(self, assertions):
        script = '''
import assert from 'node:assert/strict';
const snippets = ''' + json.dumps(self.snippets) + ''';
const invoke = (name, ...args) => {
  assert.equal(typeof snippets[name], 'string', `Missing foreign import ${name}`);
  return Function('$1', '$2', '$3', `return (${snippets[name]});`)(...args);
};
''' + assertions
        result = subprocess.run(
            ['node', '--input-type=module'], input=script, text=True,
            capture_output=True, timeout=15, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_void_send_success_has_no_fabricated_metrics(self):
        self.check_javascript('''
for (const [name, method] of [
  ['jsQueueSendEnveloped', 'send'], ['jsQueueSendBatchEnveloped', 'sendBatch'],
]) {
  const result = await invoke(name, {[method]: async () => {}}, [], {});
  assert.equal(result.ok, true);
  assert.equal(result.value, undefined);
  assert.equal(invoke('jsResponseIsVoid', result.value), true);
}
''')

    def test_metrics_response_preserves_values_in_private_snapshot(self):
        self.check_javascript('''
const metrics = {backlogCount: 12, backlogBytes: 200, oldestMessageTimestamp: new Date(1000)};
for (const mode of [0, 1, 2]) {
  const input = mode === 2 ? metrics : {metadata: {metrics}};
  const normalized = invoke('jsNormalizeMetricsEnveloped', input, mode);
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.value, {backlogCount: 12, backlogBytes: 200, timestampMillis: 1000});
  assert.notEqual(normalized.value, metrics);
}
''')

    def test_rejected_send_is_not_success(self):
        self.check_javascript('''
for (const [name, method] of [
  ['jsQueueSendEnveloped', 'send'], ['jsQueueSendBatchEnveloped', 'sendBatch'],
]) {
  const result = await invoke(name, {[method]: async () => {
    throw new Error('queue rejected');
  }}, [], {});
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.match(result.message, /queue rejected/);
}
''')

    def test_invalid_metrics_are_caught_and_do_not_prevent_recovery(self):
        self.check_javascript('''
const good = {backlogCount: 1, backlogBytes: 2};
for (const bad of [null, {}, {backlogCount: -1, backlogBytes: 2},
  {backlogCount: NaN, backlogBytes: 2}, {backlogCount: 2 ** 54, backlogBytes: 2},
  {...good, oldestMessageTimestamp: new Date(NaN)},
  {get backlogCount() { throw new Error('getter failure'); }}]) {
  for (const mode of [0, 1, 2]) {
    assert.equal(invoke('jsNormalizeMetricsEnveloped', mode === 2 ? bad : {metadata: {metrics: bad}}, mode).ok, false);
    assert.equal(invoke('jsNormalizeMetricsEnveloped', good, 2).ok, true);
  }
}
let reads = 0;
const once = {get backlogCount() { if (++reads > 1) { throw new Error('read twice'); } return 9; }, backlogBytes: 2};
const snapshot = invoke('jsNormalizeMetricsEnveloped', once, 2);
assert.equal(snapshot.ok, true);
assert.equal(invoke('jsMetricsBacklogCount', snapshot.value), 9);
assert.equal(invoke('jsMetricsBacklogCount', snapshot.value), 9);
assert.equal(reads, 1);
''')

    def test_metrics_capability_is_explicit_and_preserves_failures(self):
        self.check_javascript('''
const absent = await invoke('jsQueueMetricsEnveloped', {});
assert.equal(absent.ok, false);
assert.match(absent.message, /Queue metrics are unavailable in this runtime/);
const metrics = {backlogCount: 12, backlogBytes: 200};
const supported = await invoke('jsQueueMetricsEnveloped', {metrics: async () => metrics});
assert.equal(supported.ok, true);
assert.equal(supported.value, metrics);
const failed = await invoke('jsQueueMetricsEnveloped', {metrics: async () => {
  throw new Error('metrics unavailable temporarily');
}});
assert.equal(failed.ok, false);
assert.match(failed.message, /metrics unavailable temporarily/);
''')

    def test_native_absence_is_distinct_from_invalid_extension(self):
        self.check_javascript('''
for (const input of [{}, {metadata: undefined}, {metadata: {}}]) {
  const result = invoke('jsNormalizeMetricsEnveloped', input, 1);
  assert.equal(result.ok, true);
  assert.equal(result.value, undefined);
}
assert.equal(invoke('jsNormalizeMetricsEnveloped', undefined, 0).value, undefined);
assert.equal(invoke('jsNormalizeMetricsEnveloped', undefined, 2).ok, false);
for (const mode of [0, 1]) {
  for (const metadata of [null, 42, 'broken', true, {metrics: null}]) {
    assert.equal(invoke('jsNormalizeMetricsEnveloped', {metadata}, mode).ok, false);
  }
}
''')
