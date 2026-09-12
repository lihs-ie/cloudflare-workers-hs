"""Real HTTP contracts for per-isolate cumulative coverage evidence."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout, redirect_stderr
import copy
import hashlib
import http.client
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit
import uuid

SCRIPTS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('workerd_collector', SCRIPTS / 'workerd-js-coverage.py')
# The driver imports the local runner; it must not shadow the coverage.py package.
RUN_SPEC = importlib.util.spec_from_file_location('workerd_collector_runner', SCRIPTS / 'run.py')
RUNNER = importlib.util.module_from_spec(RUN_SPEC)
RUN_SPEC.loader.exec_module(RUNNER)
with patch.dict(sys.modules, {'run': RUNNER}):
    COLLECTOR = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(COLLECTOR)

BUNDLE = '0123456789abcdef'
ISOLATE = 'dcba7654-0000-4000-8000-000000000000'


def entry(path):
    location = {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 10}}
    return {'path': path, 'statementMap': {'0': location},
            'fnMap': {'0': {'name': 'fixture', 'decl': location, 'loc': location, 'line': 1}},
            'branchMap': {'0': {'type': 'if', 'loc': location, 'locations': [location, location], 'line': 1}},
            's': {'0': 0}, 'f': {'0': 0}, 'b': {'0': [0, 0]}}


def post(endpoint, value, path_suffix='', headers=None):
    address = urlsplit(endpoint)
    body = value if isinstance(value, bytes) else json.dumps(value).encode()
    connection = http.client.HTTPConnection(address.hostname, address.port, timeout=3)
    try:
        connection.request('POST', address.path + path_suffix, body=body, headers=headers or {})
        response = connection.getresponse()
        status, headers = response.status, dict(response.getheaders())
        assert response.read() == b''
        return status, headers
    finally:
        connection.close()


class WorkerdCollectorTests(unittest.TestCase):
    def run_collection(self, upload, expected, *, test_code=0, report_code=0, missing_report=False,
                       changed=False, all_examples=False, empty_tests=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source = root / 'source.ts'
            source.write_text('export const fixture = 1;\n')
            sources = lambda: {'source.ts': hashlib.sha256(source.read_bytes()).hexdigest()}
            output = root / 'artifacts/testing/collection'
            if not empty_tests:
                for example in COLLECTOR.EXAMPLES:
                    test_path = root / 'examples' / example / 'test/integration/fixture.spec.mjs'
                    test_path.parent.mkdir(parents=True)
                    test_path.write_text('// Boundary fixture; never executed by these collector tests.\n')
            entries = {str(source): entry(str(source)), str(root / 'other.ts'): entry(str(root / 'other.ts'))}
            (root / 'other.ts').write_text('export const other = 1;\n')
            source_snapshot = lambda: {**sources(), 'other.ts': hashlib.sha256((root / 'other.ts').read_bytes()).hexdigest()}
            called = []

            def fake_run(command, **kwargs):
                called.append(command)
                if command[1] == '--test':
                    bundle = output / 'bundles' / BUNDLE
                    bundle.mkdir(parents=True, exist_ok=True)
                    bundle.joinpath('manifest.json').write_text(json.dumps({name: {
                        'sha256': hashlib.sha256(Path(name).read_bytes()).hexdigest(), 'coverage': value}
                        for name, value in entries.items()}))
                    upload(kwargs['env']['WORKERD_JS_COVERAGE_ENDPOINT'], copy.deepcopy(entries), len(called))
                    return subprocess.CompletedProcess(command, test_code)
                self.assertEqual(command[1], 'scripts/testing/Support/workerd_js_report.mjs')
                if not missing_report:
                    (output / 'coverage-final.json').write_text(json.dumps(entries))
                if changed:
                    source.write_text(source.read_text() + '// changed\n')
                return subprocess.CompletedProcess(command, report_code)

            argv = ['workerd-js-coverage.py', '--output', str(output)] + ([] if all_examples else ['--example', 'minimal'])
            with patch.object(COLLECTOR, 'ROOT', root), patch.object(COLLECTOR, 'source_snapshot', side_effect=source_snapshot), \
                 patch.object(COLLECTOR.subprocess, 'run', side_effect=fake_run), patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
                result = COLLECTOR.main()
            self.assertEqual(result, expected)
            proof = json.loads((output / 'proof.json').read_text())
            pointer = root / 'artifacts/testing/workerd-js-coverage-latest.json'
            self.assertEqual(pointer.exists(), expected == 0)
            records = [json.loads(path.read_text()) for path in sorted((output / 'snapshots').glob('*.json'))]
            for field in ['snapshots', 'manifests']:
                for name, digest in proof[field].items():
                    self.assertEqual(digest, hashlib.sha256((output / name).read_bytes()).hexdigest())
            if expected == 0:
                self.assertEqual(proof['sha256'], hashlib.sha256((output / 'coverage-final.json').read_bytes()).hexdigest())
            return proof, records, called

    def record(self, entries, sequence=1, isolate=ISOLATE):
        return {'bundle': BUNDLE, 'isolate': isolate, 'sequence': sequence, 'coverage': entries}

    def test_parallel_isolates_duplicate_and_old_snapshots_keep_only_latest_cumulative_values(self):
        def upload(endpoint, entries, _):
            address = urlsplit(endpoint)
            with socket.create_connection((address.hostname, address.port), timeout=3):
                def worker(number):
                    isolate = str(uuid.UUID(int=number + 1))
                    initial = self.record(copy.deepcopy(entries), isolate=isolate)
                    status, headers = post(endpoint, initial)
                    self.assertEqual((status, headers.get('Content-Length'), headers.get('Connection')), (204, '0', 'close'))
                    current = copy.deepcopy(initial)
                    current['sequence'] = 2
                    for value in current['coverage'].values():
                        value['s']['0'] = 3
                        value['f']['0'] = 2
                        value['b']['0'] = [1, 2]
                    for record in [current, current, initial]:
                        self.assertEqual(post(endpoint, record)[0], 204)
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(worker, range(4)))
        proof, records, _ = self.run_collection(upload, 0)
        self.assertEqual(proof['errors'], [])
        self.assertEqual(len(records), 4)
        self.assertTrue(all(record['sequence'] == 2 for record in records))
        self.assertTrue(all(value['s']['0'] == 3 for record in records for value in record['coverage'].values()))

    def test_malformed_protocol_and_maps_are_rejected_then_valid_upload_recovers(self):
        def upload(endpoint, entries, _):
            initial = self.record(entries)
            cases = [b'not JSON', [], {}, {**initial, 'bundle': 'not-a-bundle'},
                     {**initial, 'bundle': 'g' * 16}, {**initial, 'bundle': 42}, {**initial, 'bundle': 'f' * 16},
                     {**initial, 'isolate': 'invalid'}, {**initial, 'isolate': 42}, {**initial, 'isolate': []},
                     {**initial, 'sequence': True},
                     {**initial, 'sequence': 0}, {**initial, 'coverage': {}},
                     {**initial, 'coverage': {'unknown': {}}},
                     {**initial, 'coverage': list(entries)},
                     {**initial, 'coverage': {next(iter(entries)): None}}]
            for field, value in [('path', 'different'), ('s', {'unexpected': 0}), ('s', {'0': True}),
                                 ('b', {'0': [0]}), ('b', {'0': 'not-array'}), ('b', {'0': [0, -1]}),
                                 ('f', None)]:
                altered = copy.deepcopy(initial)
                altered['coverage'][next(iter(entries))][field] = value
                cases.append(altered)
            for record in cases:
                self.assertEqual(post(endpoint, record)[0], 400, repr(record))
            for length in ['invalid', '-1', str(16 * 1024 * 1024 + 1)]:
                self.assertEqual(post(endpoint, b'{}', headers={'Content-Length': length})[0], 400)
            self.assertEqual(post(endpoint, initial, '/wrong')[0], 400)
            self.assertEqual(post(endpoint, b'')[0], 400)
            self.assertEqual(post(endpoint, initial)[0], 204)
        proof, records, _ = self.run_collection(upload, 1)
        self.assertGreaterEqual(len(proof['errors']), 20)
        self.assertEqual(len(records), 1)

    def test_truncated_upload_is_rejected_even_if_received_bytes_are_valid_json(self):
        def upload(endpoint, entries, _):
            address = urlsplit(endpoint)
            body = json.dumps(self.record(entries)).encode()
            connection = http.client.HTTPConnection(address.hostname, address.port, timeout=3)
            try:
                connection.request('POST', address.path, body=body, headers={'Content-Length': str(len(body) + 1)})
                connection.sock.shutdown(socket.SHUT_WR)
                response = connection.getresponse()
                self.assertEqual(response.status, 400)
                self.assertEqual(response.read(), b'')
            finally:
                connection.close()
            self.assertEqual(post(endpoint, self.record(entries))[0], 204)
        proof, records, _ = self.run_collection(upload, 1)
        self.assertEqual(proof['errors'], ['Incomplete upload'])
        self.assertEqual(len(records), 1)

    def test_conflicting_duplicates_lost_sources_and_regressed_counters_are_rejected(self):
        def upload(endpoint, entries, _):
            initial = self.record(entries)
            for value in entries.values():
                value['s']['0'] = 2
                value['f']['0'] = 2
                value['b']['0'] = [2, 2]
            self.assertEqual(post(endpoint, initial)[0], 204)
            conflicting = copy.deepcopy(initial)
            conflicting['coverage'][next(iter(entries))]['s']['0'] = 3
            self.assertEqual(post(endpoint, conflicting)[0], 400)
            missing = copy.deepcopy(initial)
            missing['sequence'] = 2
            missing['coverage'].pop(next(iter(entries)))
            self.assertEqual(post(endpoint, missing)[0], 400)
            for metric, value in [('s', 1), ('f', 1), ('b', [2, 1])]:
                regressed = copy.deepcopy(initial)
                regressed['sequence'] = 2
                regressed['coverage'][next(iter(entries))][metric]['0'] = value
                self.assertEqual(post(endpoint, regressed)[0], 400)
            current = copy.deepcopy(initial)
            current['sequence'] = 3
            self.assertEqual(post(endpoint, current)[0], 204)
        proof, records, _ = self.run_collection(upload, 1)
        self.assertEqual(len(proof['errors']), 5)
        self.assertEqual(records[0]['sequence'], 3)

    def test_failed_test_report_and_source_change_do_not_publish_proof(self):
        def upload(endpoint, entries, _):
            self.assertEqual(post(endpoint, self.record(entries))[0], 204)
        for options in [dict(test_code=1), dict(report_code=1), dict(changed=True), dict(missing_report=True)]:
            with self.subTest(options=options):
                proof, _, _ = self.run_collection(upload, 1, **options)
                self.assertTrue(proof['errors'])

    def test_empty_integration_directory_fails_before_any_test_command(self):
        unexpected_upload = Mock()
        proof, records, commands = self.run_collection(unexpected_upload, 1, empty_tests=True)
        unexpected_upload.assert_not_called()
        self.assertEqual(proof['errors'], ['No integration tests for minimal'])
        self.assertEqual(proof['commands'], [])
        self.assertEqual(records, [])
        self.assertFalse(any(command[1] == '--test' for command in commands))

    def test_no_snapshots_is_failure_and_default_collection_visits_all_examples(self):
        proof, records, _ = self.run_collection(lambda *args: None, 1)
        self.assertEqual(records, [])
        self.assertIn('Failed tests or no snapshots', proof['errors'][0])
        def upload(endpoint, entries, number):
            self.assertEqual(post(endpoint, self.record(entries, isolate=str(uuid.UUID(int=number))))[0], 204)
        proof, records, _ = self.run_collection(upload, 0, all_examples=True)
        self.assertEqual(len(proof['commands']), len(COLLECTOR.EXAMPLES))
        self.assertEqual(len(records), len(COLLECTOR.EXAMPLES))

    def test_cli_rejects_outside_or_existing_output_and_unknown_examples(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            existing = root / 'artifacts/testing/existing'
            existing.mkdir(parents=True)
            for arguments in [['--output', str(existing)], ['--output', str(root / 'outside')], ['--example', 'unknown']]:
                with patch.object(COLLECTOR, 'ROOT', root), patch.object(sys, 'argv', ['collector', *arguments]), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    COLLECTOR.main()
                self.assertEqual(raised.exception.code, 2)

    def test_driver_and_test_cli_support_invalid_argument_replay(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / 'workerd-js-coverage.py'), '--example', 'unknown'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn('invalid choice', result.stderr)
        result = subprocess.run([sys.executable, __file__, 'WorkerdCollectorTests.test_cli_rejects_outside_or_existing_output_and_unknown_examples'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ran 1 test', result.stderr)


if __name__ == '__main__':
    unittest.main()
