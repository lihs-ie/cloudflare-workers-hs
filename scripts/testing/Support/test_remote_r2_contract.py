"""Local HTTP/fake Wrangler contracts; never create Cloudflare resources."""
import contextlib
import datetime
import hashlib
import http.server
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('remote_r2_contract', Path(__file__).resolve().parents[1] / 'remote-r2.py')
remote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(remote)
ACCOUNT = 'a' * 32
SECRET = 'fixture-secret-must-not-appear'
FAKE = '''#!PYTHON
import http.server,json,os,pathlib,signal,sys
args=sys.argv[1:]
mode=os.environ.get('PROBE_MODE','ok')
if args[0]!='dev': sys.exit(int(os.environ.get('DELETE_EXIT','0')))
config=pathlib.Path(args[args.index('--config')+1])
pathlib.Path(os.environ['CAPTURE']).write_text(config.read_text())
if mode=='exit':
 print('Could not resolve fixture-secret-must-not-appear [code: 123] Authentication',flush=True)
 sys.exit(7)
if mode=='kill': signal.signal(signal.SIGTERM,signal.SIG_IGN)
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  self.send_response(201 if mode=='unready' else 200);self.end_headers()
 def do_POST(self):
  self.rfile.read(int(self.headers['Content-Length']))
  self.send_response(500 if mode=='500' else 403 if mode=='403' else 200);self.end_headers()
  self.wfile.write(json.dumps({'passed':mode!='500','payload':'synthetic'}).encode())
http.server.HTTPServer(('127.0.0.1',int(args[args.index('--port')+1])),Handler).serve_forever()
'''


@contextlib.contextmanager
def local_api(status=200, body=None):
    seen = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_GET(self):
            seen.append((self.command, self.path, self.headers.get('Authorization')))
            self.send_response(status)
            self.end_headers()
            self.wfile.write(json.dumps(body).encode())
        do_POST = do_GET
        do_DELETE = do_GET
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    original = urllib.request.urlopen
    def redirected(request, timeout):
        url = 'http://127.0.0.1:' + str(server.server_port) + request.selector
        return original(urllib.request.Request(url, data=request.data, headers=dict(request.header_items()), method=request.method), timeout=timeout)
    try:
        with patch.object(remote.urllib.request, 'urlopen', side_effect=redirected):
            yield seen
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


class RemoteR2ContractTests(unittest.TestCase):
    def test_api_local_transport_success_rejection_http_and_no_token(self):
        with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': SECRET}):
            with local_api(body={'success': True, 'result': {'name': 'fixture'}}) as seen:
                self.assertEqual(remote.api(ACCOUNT, 'POST', body={'name': 'fixture'}), (200, {'name': 'fixture'}))
                self.assertEqual(seen[0][2], 'Bearer ' + SECRET)
            with local_api(404, {'secret': SECRET}):
                self.assertEqual(remote.api(ACCOUNT, 'GET'), (404, None))
            with local_api(body={'success': False, 'secret': SECRET}):
                with self.assertRaisesRegex(RuntimeError, 'response omitted'):
                    remote.api(ACCOUNT, 'GET')
            with patch.object(remote.urllib.request, 'urlopen', side_effect=urllib.error.URLError(SECRET)):
                with self.assertRaisesRegex(RuntimeError, 'details omitted') as caught:
                    remote.api(ACCOUNT, 'GET')
                self.assertNotIn(SECRET, str(caught.exception))
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, 'TOKEN is required'):
            remote.api(ACCOUNT, 'GET')

    def test_receipt_http_rejects_bad_input_and_persists_lifecycle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            manifest = remote.plan(ACCOUNT)
            upload = {'key': remote.ARCHIVE_OBJECT, 'identifier': 'upload'}
            with remote.receipt_server(manifest, path) as url:
                for target, data in [(url + 'wrong', b'{}'), (url, b''), (url, b'{'), (url, b'x' * 4097)]:
                    with self.assertRaises(urllib.error.HTTPError) as caught:
                        urllib.request.urlopen(urllib.request.Request(target, data=data), timeout=2)
                    self.assertEqual(caught.exception.code, 400)
                    caught.exception.close()
                for payload in [{'phase': 'intent', 'key': remote.ARCHIVE_OBJECT}, {'phase': 'created', **upload}, {'phase': 'closed', **upload}]:
                    with urllib.request.urlopen(urllib.request.Request(url, data=json.dumps(payload).encode()), timeout=2) as response:
                        self.assertEqual(response.status, 204)
                self.assertTrue(json.loads(path.read_text())['multipartClosed'])
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_invalid_manifest_receipt_and_approval_boundaries(self):
        for change in [{'schema': 9}, {'identifier': 'invalid'}, {'scope': 'other'}, {'multipart': {}}, {'multipart': [{}, {}]}, {'account': None}, {'schema': 1, 'multipartIntent': True}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                remote.validate_manifest({**remote.plan(ACCOUNT), **change})
        for identifier in ['', 'x' * 2049, '\x00', None]:
            with self.assertRaises(ValueError):
                remote.validate_upload({'key': remote.ARCHIVE_OBJECT, 'identifier': identifier})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'manifest.json'
            manifest = remote.plan(ACCOUNT)
            for payload in [{}, {'phase': 'closed', 'key': remote.ARCHIVE_OBJECT, 'identifier': 'unknown'}]:
                with self.assertRaises(ValueError):
                    remote.record_receipt(manifest, path, payload)
            remote.record_receipt(manifest, path, {'phase': 'intent', 'key': remote.ARCHIVE_OBJECT})
            with self.assertRaises(ValueError):
                remote.record_receipt(manifest, path, {'phase': 'intent', 'key': remote.ARCHIVE_OBJECT})
        approval = {'account': ACCOUNT, 'scope': remote.SCOPE, 'costPolicy': 'free-tier', 'usageEvidence': {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'account': ACCOUNT, 'classA': 0, 'classB': 0, 'storagePeakBytes': 0, 'sourceSha256': 'a' * 64}}
        with self.assertRaisesRegex(ValueError, 'Execution approval'):
            remote.validate_approval(approval, ACCOUNT)

    @contextlib.contextmanager
    def fixture(self, mode='ok'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wrangler = root / 'wrangler'
            wrangler.write_text(FAKE.replace('PYTHON', sys.executable, 1))
            wrangler.chmod(0o755)
            config = root / 'examples/library-examples/wrangler.jsonc'
            config.parent.mkdir(parents=True)
            config.write_text('{"compatibility_date":"2026-09-01"}')
            capture = root / 'capture.json'
            with patch.object(remote, 'ROOT', root), patch.object(remote, 'WRANGLER', wrangler), patch.dict(os.environ, {'CAPTURE': str(capture), 'PROBE_MODE': mode}):
                yield root

    def test_actual_probe_process_http_success_and_errors_always_terminate(self):
        for mode in ['ok', '500', '403', 'exit', 'unready', 'kill']:
            with self.subTest(mode=mode), self.fixture(mode) as root:
                manifest = remote.plan(ACCOUNT)
                original_popen = subprocess.Popen
                processes = []
                def start(*args, **kwargs):
                    process = original_popen(*args, **kwargs)
                    processes.append(process)
                    if mode == 'kill':
                        original_wait = process.wait
                        def wait(timeout=None):
                            if timeout == 10:
                                raise subprocess.TimeoutExpired('synthetic stubborn child', 10)
                            return original_wait(timeout)
                        process.wait = wait
                    return process
                ready = []
                original_open = urllib.request.urlopen
                def health_open(*args, **kwargs):
                    response = original_open(*args, **kwargs)
                    ready.append(True)
                    return response
                timer = patch.object(remote.time, 'monotonic', side_effect=lambda: 121 if ready else 0) if mode == 'unready' else contextlib.nullcontext()
                opener = patch.object(remote.urllib.request, 'urlopen', side_effect=health_open) if mode == 'unready' else contextlib.nullcontext()
                with patch.object(remote.subprocess, 'Popen', side_effect=start), timer, opener:
                    if mode in ['403', 'exit', 'unready']:
                        with self.assertRaises(RuntimeError) as caught:
                            remote.run_worker(manifest, 'ssec-probe.ts', {}, {})
                        self.assertNotIn(SECRET, str(caught.exception))
                    else:
                        self.assertEqual(remote.run_worker(manifest, 'ssec-probe.ts', {'MARKER': 'fixture'}, {})['passed'], mode != '500')
                self.assertIsNotNone(processes[0].poll())
                config = json.loads((root / 'capture.json').read_text())
                self.assertTrue(config['r2_buckets'][0]['remote'])
                if mode == 'exit':
                    self.assertNotIn(SECRET, json.dumps(manifest))

    def test_cleanup_real_delete_child_and_local_http_error_reconciliation(self):
        for status, deleted in [(404, True), (200, False)]:
            with self.fixture() as root, patch.dict(os.environ, {'DELETE_EXIT': '1', 'CLOUDFLARE_API_TOKEN': SECRET}), local_api(status, {'success': True}):
                manifest = remote.plan(ACCOUNT)
                manifest['resource']['state'] = 'created'
                path = root / 'manifest.json'
                if deleted:
                    remote.cleanup(manifest, path)
                    self.assertEqual(manifest['resource']['state'], 'deleted')
                else:
                    with self.assertRaisesRegex(RuntimeError, 'Object cleanup failed'):
                        remote.cleanup(manifest, path)
                    self.assertEqual(json.loads(path.read_text())['resource']['state'], 'cleanup-pending')

    def test_execute_persists_status_and_cleans_up_after_every_probe_outcome(self):
        for outcome in [{'passed': True}, {'positiveChecksPassed': True, 'negativeProof': 'unverified'}, RuntimeError('Unexpected probe HTTP status'), RuntimeError(SECRET)]:
            with self.subTest(outcome=str(outcome)), self.fixture() as root:
                approval = root / 'approval.json'
                approval.write_text(json.dumps({'scope': remote.SCOPE, 'account': ACCOUNT, 'approvedBudgetUsd': 5,
                    'approvedBy': 'fixture', 'approvedAt': '2026-09-01', 'acknowledgeNotHardCap': True}))
                path = root / 'manifest.json'
                calls = []
                def api(account, method, suffix='', body=None):
                    calls.append(method)
                    if method == 'GET':
                        return 404, None
                    if method == 'POST':
                        return 201, {'name': body['name']}
                    return 204, None
                probe = patch.object(remote, 'run_worker', side_effect=outcome) if isinstance(outcome, Exception) else patch.object(remote, 'run_worker', return_value=outcome)
                with patch.object(remote, 'api', side_effect=api), patch.object(remote, 'verify_build', return_value={'synthetic': True}), probe:
                    result = remote.main(['execute', '--account', ACCOUNT, '--approval', str(approval), '--manifest', str(path)])
                saved = json.loads(path.read_text())
                self.assertEqual(result, 0 if outcome == {'passed': True} else 1)
                self.assertEqual(saved['resource']['state'], 'deleted')
                self.assertEqual(calls, ['GET', 'POST', 'DELETE'])
                self.assertNotIn(SECRET, path.read_text())

    def test_cli_guards_creation_reconciliation_and_cleanup_mode(self):
        with self.fixture() as root:
            approval = root / 'approval.json'
            approval.write_text(json.dumps({'scope': remote.SCOPE, 'account': ACCOUNT, 'approvedBudgetUsd': 5,
                'approvedBy': 'fixture', 'approvedAt': '2026-09-01', 'acknowledgeNotHardCap': True}))
            path = root / 'manifest.json'
            for args in [['cleanup'], ['execute']]:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    remote.main(args)
            path.write_text(json.dumps(remote.plan(ACCOUNT)))
            for args in [['cleanup', '--manifest', str(path), '--account', 'other'],
                         ['execute', '--account', ACCOUNT, '--approval', str(approval), '--manifest', str(path)]]:
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    remote.main(args)
            path.unlink()
            for responses, message in [([(200, {})], 'Expected absent'), ([(404, None), (500, {})], 'Creation unconfirmed')]:
                with patch.object(remote, 'verify_build', return_value={}), patch.object(remote, 'api', side_effect=responses), self.assertRaisesRegex(RuntimeError, message):
                    remote.main(['execute', '--account', ACCOUNT, '--approval', str(approval), '--manifest', str(path)])
                path.unlink()
            manifest = remote.plan(ACCOUNT)
            manifest['resource']['state'] = 'deleted'
            path.write_text(json.dumps(manifest))
            self.assertEqual(remote.main(['cleanup', '--manifest', str(path), '--account', ACCOUNT]), 0)

    def test_build_proof_and_public_cli_error_omit_diagnostics(self):
        with self.fixture() as root:
            proof = root / 'examples/library-examples/worker/build.json'
            proof.parent.mkdir(parents=True)
            proof.write_text('{}')
            with patch.object(remote.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
                self.assertEqual(remote.verify_build()['manifestSha256'], hashlib.sha256(b'{}').hexdigest())
            for arguments in [[], ['execute', '--account', SECRET, '--approval', str(root / 'missing'), '--manifest', str(root / 'm')]]:
                result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1] / 'remote-r2.py'), *arguments], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0 if not arguments else 1)
                self.assertNotIn(SECRET, result.stdout + result.stderr)
