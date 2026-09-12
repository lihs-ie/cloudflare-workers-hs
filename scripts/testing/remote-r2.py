#!/usr/bin/env python3
"""Plan by default. Execute with explicit account approval and either usage evidence or a budget."""
import argparse
import datetime
import hashlib
import http.server
import http.client
import threading
from contextlib import contextmanager
import json
import os
import pathlib
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
WRANGLER = ROOT / 'examples/quickstart/node_modules/.bin/wrangler'
PREFIX = 'hs-remote-ssec-'
OBJECT = 'attachments/encrypted/remote-probe.bin'
ARCHIVE_OBJECT = 'archives/encrypted/remote-archive.bin'
SCOPE = 'remote-r2-ssec-multipart'

def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    os.chmod(temporary, 0o600)
    temporary.replace(path)

def plan(account=None):
    identifier = uuid.uuid4().hex
    return {'schema': 2, 'scope': SCOPE, 'identifier': identifier, 'account': account,
            'validationLimitations': ['SSE-C-specific error classification is unavailable: full passed remains false; positive-only success is incomplete and exits nonzero.'],
            'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'resource': {'kind': 'r2-bucket', 'identifier': PREFIX + identifier, 'state': 'planned'},
            'objects': [OBJECT, ARCHIVE_OBJECT], 'multipart': [], 'multipartIntent': False, 'multipartClosed': False, 'status': 'planned',
            'estimate': {'currency': 'USD', 'reviewedAt': '2026-09-08',
                         'classAPlanningAllowance': 32, 'classBPlanningAllowance': 32,
                         'objectBytes': 4096 + 5 * 1024 * 1024 + 3, 'timeoutSeconds': 180,
                         'roundedR2IncrementEstimate': 4.875,
                         'absoluteSpendingCap': False}}

def validate_upload(upload):
    if not isinstance(upload, dict) or set(upload) != {'key', 'identifier'} or upload['key'] != ARCHIVE_OBJECT:
        raise ValueError('Unexpected multipart cleanup scope')
    identifier = upload['identifier']
    if not isinstance(identifier, str) or not 1 <= len(identifier) <= 2048 or any(ord(char) < 32 for char in identifier):
        raise ValueError('Invalid multipart identifier')

def record_receipt(manifest, path, value):
    if value == {'phase': 'intent', 'key': ARCHIVE_OBJECT}:
        if manifest.get('multipartIntent') or manifest.get('multipart'):
            raise ValueError('Duplicate multipart creation')
        manifest['multipartIntent'] = True
    elif isinstance(value, dict) and value.get('phase') == 'created':
        upload = {key: item for key, item in value.items() if key != 'phase'}
        validate_upload(upload)
        if manifest.get('multipartIntent') is not True or manifest.get('multipart'):
            raise ValueError('Multipart receipt has no creation intent')
        manifest['multipart'] = [upload]
        manifest['multipartIntent'] = False
    elif isinstance(value, dict) and value.get('phase') == 'closed':
        upload = {key: item for key, item in value.items() if key != 'phase'}
        validate_upload(upload)
        if manifest.get('multipart') != [upload]:
            raise ValueError('Unknown closed upload')
        manifest['multipartClosed'] = True
    else:
        raise ValueError('Invalid receipt')
    save(path, manifest)

@contextmanager
def receipt_server(manifest, path):
    nonce = '/' + uuid.uuid4().hex
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if self.path != nonce or not 0 < size <= 4096:
                    raise ValueError('Rejected receipt')
                record_receipt(manifest, path, json.loads(self.rfile.read(size)))
                self.send_response(204)
            except Exception:
                self.send_response(400)
            self.end_headers()
    server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}{nonce}'
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

def validate_manifest(value):
    identifier = value.get('identifier', '')
    if value.get('schema') not in (1, 2) or not re.fullmatch('[a-f0-9]{32}', identifier):
        raise ValueError('Invalid run manifest')
    resource = value.get('resource', {})
    if resource.get('kind') != 'r2-bucket' or resource.get('identifier') != PREFIX + identifier:
        raise ValueError('Resource does not belong to this run')
    expected = [OBJECT] if value['schema'] == 1 else [OBJECT, ARCHIVE_OBJECT]
    if value['schema'] == 2 and value.get('scope') != SCOPE:
        raise ValueError('Unexpected validation scope')
    uploads = value.get('multipart', [])
    if not isinstance(uploads, list) or len(uploads) > 1:
        raise ValueError('Unexpected multipart receipt count')
    if value['schema'] == 1 and (uploads or value.get('multipartIntent') or value.get('multipartClosed')):
        raise ValueError('Legacy manifest cannot authorize multipart operations')
    for upload in uploads:
        validate_upload(upload)
    if value.get('objects') != expected:
        raise ValueError('Unexpected object deletion scope')
    if not re.fullmatch('[a-f0-9]{32}', value.get('account') or ''):
        raise ValueError('Explicit Cloudflare account is required')

def validate_approval(value, account):
    if value.get('account') != account or value.get('scope') != SCOPE:
        raise ValueError('Approval account or scope does not match')
    if value.get('costPolicy') == 'free-tier':
        evidence = value.get('usageEvidence', {})
        checked = datetime.datetime.fromisoformat(evidence.get('checkedAt', '').replace('Z', '+00:00'))
        age = (datetime.datetime.now(datetime.timezone.utc) - checked).total_seconds()
        if not 0 <= age <= 3600 or evidence.get('account') != account:
            raise ValueError('Fresh account-specific usage evidence is required')
        # Conservative headroom; telemetry is evidence, not a billing hard cap.
        for field, ceiling in [('classA', 900000), ('classB', 9000000), ('storagePeakBytes', 9000000000)]:
            observed = evidence.get(field)
            if isinstance(observed, bool) or not isinstance(observed, int) or not 0 <= observed < ceiling:
                raise ValueError('Insufficient free-tier headroom')
        if not re.fullmatch('[a-f0-9]{64}', evidence.get('sourceSha256', '')):
            raise ValueError('Usage source digest is required')
        if not value.get('approvedBy') or not value.get('approvedAt'):
            raise ValueError('Execution approval is required')
        return
    budget = value.get('approvedBudgetUsd')
    if isinstance(budget, bool) or not isinstance(budget, (int, float)) or not 4.875 <= budget < 1000:
        raise ValueError('Approved budget must be finite and at least USD 4.875')
    if not value.get('approvedBy') or not value.get('approvedAt') or value.get('acknowledgeNotHardCap') is not True:
        raise ValueError('Approval identity, timestamp and non-cap acknowledgement are required')

def api(account, method, suffix='', body=None):
    token = os.environ.get('CLOUDFLARE_API_TOKEN')
    if not token:
        raise ValueError('CLOUDFLARE_API_TOKEN is required for execution/cleanup')
    url = f'https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets{suffix}'
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method,
                                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data = json.load(response)
            if not data.get('success'):
                raise RuntimeError('Cloudflare operation rejected (response omitted)')
            return response.status, data.get('result')
    except urllib.error.HTTPError as error:
        with error:
            return error.code, None
    except urllib.error.URLError:
        raise RuntimeError('Cloudflare transport failed (details omitted)') from None

def cleanup(manifest, path):
    validate_manifest(manifest)
    resource = manifest['resource']
    if resource['state'] == 'deleted':
        return
    if resource['state'] not in ('created', 'cleanup-pending'):
        raise ValueError('Creation is unconfirmed; refuse automatic deletion, reconcile manually')
    resource['state'] = 'cleanup-pending'
    save(path, manifest)
    environment = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': manifest['account'], 'WRANGLER_SEND_METRICS': 'false', 'CI': 'true'}
    if manifest.get('multipartIntent'):
        raise RuntimeError('Multipart creation is unconfirmed; reconcile before cleanup')
    uploads = manifest.get('multipart', [])
    if uploads and not manifest.get('multipartClosed'):
        result = run_worker(manifest, 'cleanup-probe.ts', {}, {'uploads': uploads})
        if result.get('passed') is not True:
            raise RuntimeError('Multipart abort failed; receipts retained')
        manifest['multipartClosed'] = True
        save(path, manifest)
    # No prefix/list deletion: only the fixed objects this probe can create.
    for key in manifest['objects']:
        result = subprocess.run([str(WRANGLER), 'r2', 'object', 'delete', resource['identifier'] + '/' + key, '--remote'],
                                cwd=ROOT, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        if result.returncode != 0:
            status, _ = api(manifest['account'], 'GET', '/' + resource['identifier'])
            if status != 404:
                raise RuntimeError('Object cleanup failed; manifest retained')
    status, _ = api(manifest['account'], 'DELETE', '/' + resource['identifier'])
    if status not in (200, 204, 404):
        raise RuntimeError('Bucket cleanup failed; manifest retained')
    resource['state'] = 'deleted'
    save(path, manifest)

def verify_build():
    """Reject missing, stale or altered WASM before any Cloudflare access."""
    result = subprocess.run([
        'node', '--input-type=module', '-e',
        'import { verifyBuild } from "./examples/library-examples/test/Support/build-manifest.mjs"; verifyBuild();',
    ], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    if result.returncode != 0:
        raise RuntimeError('Production WASM build verification failed; rebuild library-examples')
    proof = ROOT / 'examples/library-examples/worker/build.json'
    return {'manifestSha256': hashlib.sha256(proof.read_bytes()).hexdigest()}

def run_worker(manifest, entry, variables, payload):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='hs-remote-r2-') as directory:
        config = pathlib.Path(directory) / 'wrangler.json'
        config.write_text(json.dumps({'name': manifest['resource']['identifier'], 'account_id': manifest['account'],
            'main': str(ROOT / 'examples/library-examples/test/Support/Remote' / entry),
            'compatibility_date': json.loads((ROOT / 'examples/library-examples/wrangler.jsonc').read_text())['compatibility_date'], 'compatibility_flags': ['nodejs_compat'],
            'rules': [{'type': 'CompiledWasm', 'globs': ['**/*.wasm']}],
            'vars': {'EXAMPLE_MODE': 'remote-test', 'EXAMPLE_SECRET': 'non-sensitive-test-marker', **variables},
            'r2_buckets': [{'binding': 'EXAMPLE_BUCKET', 'bucket_name': manifest['resource']['identifier'], 'remote': True}]}))
        environment = {**os.environ, 'CLOUDFLARE_ACCOUNT_ID': manifest['account'], 'WRANGLER_SEND_METRICS': 'false', 'CI': 'true'}
        diagnostics = tempfile.TemporaryFile(mode='w+')
        process = subprocess.Popen([str(WRANGLER), 'dev', '--config', str(config), '--ip', '127.0.0.1', '--port', str(port)],
                                   cwd=directory, env=environment, stdout=diagnostics, stderr=diagnostics)
        try:
            deadline = time.monotonic() + 120
            while True:
                if process.poll() is not None:
                    diagnostics.seek(0)
                    output = diagnostics.read()
                    manifest['startupErrorKinds'] = re.findall(r'Could not resolve|Cannot find module|No such file|Unsupported|not exported|No matching export', output)
                    manifest['startupDiagnostics'] = {'exitCode': process.returncode, 'cloudflareCodes': re.findall(r'\[code: (\d+)\]', output), 'flags': [word for word in ['Authentication', 'permission', 'resolve', 'compatibility', 'CLOUDFLARE_API_TOKEN', 'login', 'SyntaxError', 'workers.dev'] if word in output]}
                    raise RuntimeError('Wrangler stopped before probe readiness; logs omitted')
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
                        if response.status == 200:
                            break
                except (urllib.error.URLError, TimeoutError, http.client.RemoteDisconnected, ConnectionResetError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('Probe startup timed out')
                time.sleep(0.25)
            request = urllib.request.Request(f'http://127.0.0.1:{port}/run', method='POST', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                with error:
                    if error.code == 500:
                        return json.load(error)
                    raise RuntimeError('Unexpected probe HTTP status') from None
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            diagnostics.close()

def probe_status(result):
    if result.get('passed') is True:
        return 'passed'
    if result.get('positiveChecksPassed') is True and result.get('negativeProof') == 'unverified':
        return 'incomplete'
    return 'failed'

def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', choices=['plan', 'execute', 'cleanup'], default='plan')
    parser.add_argument('--account')
    parser.add_argument('--approval', type=pathlib.Path)
    parser.add_argument('--manifest', type=pathlib.Path)
    args = parser.parse_args(arguments)
    if args.mode == 'plan':
        print(json.dumps(plan(args.account), indent=2))
        return 0
    if args.mode == 'cleanup':
        if not args.manifest:
            parser.error('cleanup requires --manifest')
        manifest = json.loads(args.manifest.read_text())
        if args.account != manifest.get('account'):
            parser.error('cleanup requires the matching --account')
        cleanup(manifest, args.manifest)
        return 0
    if not args.approval or not args.manifest:
        parser.error('execute requires --account, --approval and a new --manifest')
    manifest = plan(args.account)
    validate_manifest(manifest)
    approval = json.loads(args.approval.read_text())
    validate_approval(approval, args.account)
    if args.manifest.exists():
        parser.error('manifest already exists; use cleanup or a new path')
    manifest['buildEvidence'] = verify_build()
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest['approval'] = approval
    save(args.manifest, manifest)
    name = manifest['resource']['identifier']
    status, _ = api(args.account, 'GET', '/' + name)
    if status != 404:
        raise RuntimeError('Expected absent dedicated bucket; refusing creation')
    manifest['resource']['state'] = 'create-pending'
    save(args.manifest, manifest)
    status, result = api(args.account, 'POST', body={'name': name, 'storageClass': 'Standard'})
    if status not in (200, 201) or not isinstance(result, dict) or result.get('name') != name:
        raise RuntimeError('Creation unconfirmed; manifest retained for reconciliation')
    manifest['resource']['state'] = 'created'
    save(args.manifest, manifest)
    try:
        with receipt_server(manifest, args.manifest) as callback:
            manifest['result'] = run_worker(manifest, 'ssec-probe.ts', {'RECEIPT_URL': callback}, {})
        manifest['status'] = probe_status(manifest['result'])
    except Exception as error:
        manifest['status'] = 'failed'
        known = {'Wrangler stopped before probe readiness; logs omitted', 'Probe startup timed out', 'Unexpected probe HTTP status'}
        manifest['result'] = {'passed': False, 'reason': str(error) if str(error) in known else 'probe-failed-details-omitted', 'errorType': type(error).__name__}
    finally:
        # Persist evidence before deleting resources, including failed probes.
        save(args.manifest, manifest)
        cleanup(manifest, args.manifest)
    return 0 if manifest['status'] == 'passed' else 1

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(type(error).__name__ + ': remote validation failed; inspect the manifest, no secret diagnostics emitted', file=sys.stderr)
        sys.exit(1)
