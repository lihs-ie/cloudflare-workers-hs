"""Real HTTP regressions for the multi-isolate WASM counter collector."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

SCRIPTS = Path(__file__).resolve().parents[1]


def load_script(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The local report merger is unrelated to the installed coverage.py collector.
# Restore sys.modules immediately so this test also works under coverage.py.
report = load_script('wasm_network_report', 'coverage.py')
runner = load_script('wasm_network_runner', 'run.py')
with patch.dict(sys.modules, {'coverage': report, 'run': runner}):
    collector = load_script('wasm_network_collector', 'wasm-coverage.py')


class WasmCollectorNetworkTests(unittest.TestCase):
    def collect(self, upload, expected_status, *, empty_suite=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'artifacts/testing/collection'
            calls = []
            if not empty_suite:
                suite = root / 'examples/minimal/test/integration'
                suite.mkdir(parents=True)
                (suite / 'fixture.spec.mjs').write_text('// subprocess boundary fixture')

            def fake_run(command, **kwargs):
                calls.append(command)
                if command[0] == 'node':
                    upload(kwargs['env']['WASM_COVERAGE_ENDPOINT'])
                elif command[0] == 'python3':
                    destination = Path(command[command.index('--output') + 1])
                    destination.write_text(json.dumps({'wasm_hpc': [], 'errors': [], 'complete': False}))
                else:
                    self.assertEqual(command[0], 'bash')
                return subprocess.CompletedProcess(command, 0)

            argv = ['wasm-coverage.py', '--example', 'minimal', '--output', str(output)]
            with patch.object(collector, 'ROOT', root), patch.object(collector, 'source_snapshot', return_value={'source': 'stable'}), \
                 patch.object(collector.subprocess, 'run', side_effect=fake_run), patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
                status = collector.main()
            self.assertEqual(status, expected_status)
            proof = json.loads((output / 'proof.json').read_text())
            snapshots = {name: (output / name).read_text() for name in proof['snapshots']}
            for name, digest in proof['snapshots'].items():
                self.assertEqual(hashlib.sha256((output / name).read_bytes()).hexdigest(), digest)
            pointer = root / 'artifacts/testing/wasm-coverage-latest.json'
            self.assertEqual(pointer.exists(), expected_status == 0)
            return proof, snapshots, calls

    def test_idle_connection_does_not_block_parallel_uploads_or_duplicate_snapshot_names(self):
        expected = {f'Tix [TixModule "Fixture" 123 1 [{number}]]' for number in range(32)}

        def upload(endpoint):
            address = urlsplit(endpoint)
            barrier = threading.Barrier(8)
            # An accepted client with an unfinished request must not monopolize
            # the listener while independent Workers upload their final counters.
            with socket.create_connection((address.hostname, address.port), timeout=3) as idle:
                self.assertGreater(idle.fileno(), -1)

                def worker(worker_number):
                    barrier.wait(timeout=3)
                    for offset in range(4):
                        number = worker_number * 4 + offset
                        body = f'Tix [TixModule "Fixture" 123 1 [{number}]]'.encode()
                        request = Request(endpoint, data=body, method='POST')
                        with urlopen(request, timeout=3) as response:
                            self.assertEqual(response.status, 204)
                            self.assertEqual(response.headers['Content-Length'], '0')
                            self.assertEqual(response.headers['Connection'], 'close')
                            self.assertEqual(response.read(), b'')

                with ThreadPoolExecutor(max_workers=8) as pool:
                    list(pool.map(worker, range(8)))

        proof, snapshots, calls = self.collect(upload, 0)
        self.assertEqual(proof['errors'], [])
        self.assertEqual(len(snapshots), 32)
        self.assertEqual(set(snapshots), {f'reactor-{number}.tix' for number in range(32)})
        self.assertEqual(set(snapshots.values()), expected)
        self.assertEqual(calls[-1].count('--wasm-tix'), 32)

    def test_truncated_valid_tix_body_is_rejected_without_snapshot(self):
        def upload(endpoint):
            address = urlsplit(endpoint)
            body = b'Tix [TixModule "Fixture" 123 1 [1]]'
            request = (
                f'POST {address.path} HTTP/1.1\r\n'
                f'Host: {address.hostname}\r\n'
                f'Content-Length: {len(body) + 10}\r\n'
                'Connection: close\r\n\r\n'
            ).encode() + body
            with socket.create_connection((address.hostname, address.port), timeout=3) as connection:
                connection.sendall(request)
                connection.shutdown(socket.SHUT_WR)
                with connection.makefile('rb') as response:
                    self.assertIn(b' 400 ', response.readline())
        proof, snapshots, calls = self.collect(upload, 1)
        self.assertEqual(snapshots, {})
        self.assertTrue(any('Incomplete coverage upload' in error for error in proof['errors']))
        self.assertFalse(any(command[0] == 'python3' for command in calls))

    def test_empty_suite_never_launches_unbounded_node_discovery(self):
        proof, snapshots, calls = self.collect(lambda endpoint: self.fail('Node must not execute'), 1, empty_suite=True)
        self.assertEqual(snapshots, {})
        self.assertTrue(any('No integration tests' in error for error in proof['errors']))
        self.assertFalse(any(command[0] == 'node' for command in calls))

    def test_invalid_upload_is_recorded_and_does_not_publish_a_success_pointer(self):
        def upload(endpoint):
            for url, body in [(endpoint + '/wrong', b'irrelevant'), (endpoint, b''),
                              (endpoint, b'not valid counters')]:
                with self.assertRaises(HTTPError) as raised:
                    urlopen(Request(url, data=body, method='POST'), timeout=3)
                with raised.exception as response:
                    self.assertEqual(response.code, 400)
                    self.assertEqual(response.headers['Content-Length'], '0')
                    self.assertEqual(response.read(), b'')
            # A rejected upload must not poison another Worker's valid upload.
            with urlopen(Request(endpoint, data=b'Tix [TixModule "Fixture" 123 1 [1]]', method='POST'), timeout=3) as response:
                self.assertEqual(response.status, 204)

        proof, snapshots, calls = self.collect(upload, 1)
        self.assertEqual(len(proof['errors']), 3)
        self.assertEqual(len(snapshots), 1)
        self.assertFalse(any(command[0] == 'python3' for command in calls))


if __name__ == '__main__':
    unittest.main()
