#!/usr/bin/env python3
"""Collect per-isolate Istanbul snapshots from real local workerd examples."""
import argparse
import datetime
import hashlib
import http.server
import json
import os
from pathlib import Path
import subprocess
import threading
import uuid
from run import source_snapshot

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ['minimal', 'static-assets', 'realtime', 'workflows', 'library-examples']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--example', action='append', choices=EXAMPLES)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = (args.output or ROOT / 'artifacts/testing' / ('workerd-js-coverage-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT / 'artifacts/testing') or output.exists():
        parser.error('Choose a new output under artifacts/testing')
    (output / 'snapshots').mkdir(parents=True)
    sources = source_snapshot()
    errors, commands, received = [], [], {}
    nonce = '/' + uuid.uuid4().hex
    snapshot_lock = threading.Lock()

    class Collector(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                self.connection.settimeout(10)
                size = int(self.headers.get('Content-Length', '0'))
                if self.path != nonce or not 0 < size <= 16 * 1024 * 1024:
                    raise ValueError('Invalid request')
                body = self.rfile.read(size)
                if len(body) != size:
                    raise ValueError('Incomplete upload')
                record = json.loads(body)
                if not isinstance(record['isolate'], str):
                    raise ValueError('Invalid isolate')
                bundle, isolate, sequence = record['bundle'], str(uuid.UUID(record['isolate'])), record['sequence']
                if not isinstance(bundle, str) or len(bundle) != 16 or any(c not in '0123456789abcdef' for c in bundle):
                    raise ValueError('Invalid bundle')
                if type(sequence) is not int or sequence < 1:
                    raise ValueError('Invalid sequence')
                manifest = json.loads((output / 'bundles' / bundle / 'manifest.json').read_text())
                if not isinstance(record['coverage'], dict) or not record['coverage'] or set(record['coverage']) - set(manifest):
                    raise ValueError('Unknown or empty source map')
                for name, entry in record['coverage'].items():
                    if not isinstance(entry, dict):
                        raise ValueError('Invalid coverage entry')
                    expected = manifest[name]['coverage']
                    if any(entry.get(k) != expected.get(k) for k in ['path', 'statementMap', 'branchMap', 'fnMap', 'inputSourceMap']):
                        raise ValueError('Instrumentation map changed')
                    for key in ['s', 'f', 'b']:
                        if not isinstance(entry[key], dict):
                            raise ValueError('Invalid counter map')
                        if set(entry[key]) != set(expected[key]):
                            raise ValueError('Counter keys changed')
                        for identifier, counts in entry[key].items():
                            if key == 'b':
                                if not isinstance(counts, list) or len(counts) != len(expected[key][identifier]):
                                    raise ValueError('Invalid branch arity')
                            elif type(counts) is not int:
                                raise ValueError('Invalid counter')
                            if any(type(count) is not int or count < 0 for count in (counts if key == 'b' else [counts])):
                                raise ValueError('Invalid counter')
                key = bundle + '-' + isolate
                with snapshot_lock:
                    previous = received.get(key)
                    if previous and previous['sequence'] == sequence and previous != record:
                        raise ValueError('Conflicting duplicate snapshot')
                    if previous and sequence > previous['sequence']:
                        for name, old_entry in previous['coverage'].items():
                            if name not in record['coverage']:
                                raise ValueError('Cumulative snapshot lost a source')
                            for metric in ['s', 'f', 'b']:
                                for identifier, old_counts in old_entry[metric].items():
                                    new_counts = record['coverage'][name][metric][identifier]
                                    pairs = zip(old_counts, new_counts) if metric == 'b' else [(old_counts, new_counts)]
                                    if any(new < old for old, new in pairs):
                                        raise ValueError('Cumulative counter regressed')
                    if not previous or sequence > previous['sequence']:
                        received[key] = record
                        (output / 'snapshots' / (key + '.json')).write_text(json.dumps(record))
                self.send_response(204)
            except (ValueError, OSError, KeyError, TypeError) as error:
                errors.append(str(error))
                self.send_response(400)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Collector)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env = dict(os.environ, WORKERD_JS_COVERAGE_ENDPOINT=f'http://127.0.0.1:{server.server_port}{nonce}', WORKERD_JS_COVERAGE_DIRECTORY=str(output))
    try:
        for example in args.example or EXAMPLES:
            before = len(received)
            tests = sorted((ROOT / 'examples' / example / 'test/integration').glob('*.spec.mjs'))
            if not tests:
                errors.append('No integration tests for ' + example)
                break
            command = ['node', '--test', '--test-concurrency=1', *[str(path.relative_to(ROOT)) for path in tests]]
            with (output / (example + '.log')).open('w') as log:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            commands.append({'command': command, 'exitCode': result.returncode, 'log': example + '.log',
                             'logSha256': hashlib.sha256((output / (example + '.log')).read_bytes()).hexdigest()})
            if result.returncode or len(received) == before:
                errors.append('Failed tests or no snapshots: ' + example)
                break
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
    with (output / 'report.log').open('w') as log:
        result = subprocess.run(['node', 'scripts/testing/Support/workerd_js_report.mjs', str(output)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        errors.append('Report failed')
    if source_snapshot() != sources:
        errors.append('Sources changed during collection')
    report = output / 'coverage-final.json'
    if not report.is_file():
        errors.append('Missing coverage report')
    proof = {'sources': sources, 'exit_code': 1 if errors else 0, 'errors': errors, 'commands': commands,
             'sha256': hashlib.sha256(report.read_bytes()).hexdigest() if report.is_file() else None,
             'snapshots': {str(p.relative_to(output)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (output / 'snapshots').glob('*.json')},
             'manifests': {str(p.relative_to(output)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (output / 'bundles').glob('*/manifest.json')},
             'semantics': 'Latest cumulative snapshot per bundle/isolate; never sum successive snapshots'}
    (output / 'proof.json').write_text(json.dumps(proof, indent=2))
    if not errors:
        (ROOT / 'artifacts/testing/workerd-js-coverage-latest.json').write_text(json.dumps({'report': str(report.relative_to(ROOT)), 'proof': str((output / 'proof.json').relative_to(ROOT))}))
    print(json.dumps({'output': str(output), 'errors': errors, 'isolates': len(received)}))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
