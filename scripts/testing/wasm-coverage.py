#!/usr/bin/env python3
"""Build and execute instrumented workerd tests; collect real reactor counters."""
import argparse
import datetime
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import shutil
import threading
import uuid

from run import source_snapshot

ROOT = Path(__file__).resolve().parents[2]
# Keep the local report parser distinct from the installed coverage.py collector.
_report_spec = importlib.util.spec_from_file_location('wasm_counter_report', Path(__file__).with_name('coverage.py'))
_report = importlib.util.module_from_spec(_report_spec)
_report_spec.loader.exec_module(_report)
parse_tix = _report.parse_tix
EXAMPLES = ['quickstart', 'library-examples', 'minimal', 'static-assets', 'realtime', 'workflows']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--example', action='append', choices=EXAMPLES, help='Repeat to collect selected example reactors')
    parser.add_argument('--all-examples', action='store_true', help='Collect all six existing examples')
    args = parser.parse_args()
    if args.all_examples and args.example:
        parser.error('Use --all-examples or --example, not both')
    output = (args.output or ROOT / 'artifacts/testing' / ('wasm-coverage-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT):
        parser.error("--output must be inside the repository")
    output.mkdir(parents=True, exist_ok=True)
    sources = source_snapshot()
    env = dict(os.environ, WASM_PROJECT_FILE='cabal-wasm-coverage.project', WASM_BUILD_DIR='dist-wasm-coverage')
    commands = []

    def execute(command, name):
        with (output / name).open('w') as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        commands.append({'command': command, 'exitCode': result.returncode, 'log': name})
        return result.returncode

    mix_directory = output / 'mix'
    nonce = '/' + uuid.uuid4().hex
    snapshots = []
    errors = []
    snapshot_lock = threading.Lock()

    class Collector(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                self.connection.settimeout(10)
                size = int(self.headers.get('Content-Length', '0'))
                if self.path != nonce or not 0 < size <= 16 * 1024 * 1024:
                    raise ValueError('Invalid coverage upload')
                payload = self.rfile.read(size)
                if len(payload) != size:
                    raise ValueError('Incomplete coverage upload')
                body = payload.decode()
                parse_tix(body)
                with snapshot_lock:
                    name = 'reactor-' + str(len(snapshots)) + '.tix'
                    (output / name).write_text(body)
                    snapshots.append(name)
                self.send_response(204)
            except (ValueError, OSError) as error:
                errors.append(str(error))
                self.send_response(400)
            self.send_header('Content-Length', '0')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True

    # Independent isolates can leave idle keep-alive connections open. A
    # single request thread must not prevent another isolate's upload.
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Collector)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    env.update(WASM_COVERAGE='1', WASM_COVERAGE_ENDPOINT=f'http://127.0.0.1:{server.server_port}{nonce}')
    try:
        code = 0
        for example in EXAMPLES if args.all_examples else args.example or ['quickstart']:
            env['WASM_BUILD_DIR'] = 'dist-wasm-coverage' if example == 'quickstart' else 'dist-' + example + '-coverage'
            build = ['bash', 'examples/quickstart/scripts/build-wasm.sh', 'runtime-tests'] if example == 'quickstart' else ['bash', 'examples/' + example + '/scripts/build.sh']
            code = execute(build, example + '-build.log')
            if code:
                break
            if example == 'quickstart':
                tests = ['pnpm', '--dir', 'examples/quickstart', 'test:runtime']
            else:
                suite = sorted((ROOT / ('examples/' + example + '/test/integration')).glob('*.spec.mjs'))
                if not suite:
                    errors.append('No integration tests for ' + example)
                    code = 1
                    break
                tests = ['node', '--test', '--test-concurrency=1', *[str(path.relative_to(ROOT)) for path in suite]]
            before = len(snapshots)
            code = execute(tests, example + '-tests.log')
            if example == 'quickstart' and len(snapshots) == before:
                errors.append('No snapshots for quickstart runtime isolates')
            if example == 'quickstart' and not code:
                # The fixture reactor does not execute application modules. Build
                # the real multi-Worker entry point and observe every invocation,
                # including Queue, Scheduled and Durable Object isolates.
                code = execute(['bash', 'examples/quickstart/scripts/build-wasm.sh', 'quickstart'], 'quickstart-production-build.log')
                if not code:
                    production_before = len(snapshots)
                    code = execute(['pnpm', '--dir', 'examples/quickstart', 'test:integration'], 'quickstart-production-tests.log')
                    if len(snapshots) == production_before:
                        errors.append('No snapshots for quickstart production isolates')
                if not code:
                    dev_before = len(snapshots)
                    code = execute(['pnpm', '--dir', 'examples/quickstart', 'test:dev'], 'quickstart-dev-tests.log')
                    if len(snapshots) == dev_before:
                        errors.append('No snapshots for quickstart wrangler dev workers')
            if len(snapshots) == before:
                errors.append('No snapshots for ' + example)
            packages = ['cloudflare-workers', 'servant-cloudflare-workers', 'servant-cloudflare-workers-access', 'servant-cloudflare-workers-client', 'examples/' + example]
            if example == 'quickstart':
                packages += ['examples/quickstart/packages/domain', 'examples/quickstart/packages/infrastructure', 'examples/quickstart/apps/management']
            for package in packages:
                parent = ROOT / package / '.hpc'
                for directory in parent.glob('wasm*') if parent.is_dir() else []:
                    shutil.copytree(directory, mix_directory / package / directory.name, dirs_exist_ok=True)
            if code:
                break
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
    if source_snapshot() != sources:
        errors.append('Sources changed during coverage execution')
    if not snapshots:
        errors.append('No WASM coverage snapshots received')
    proof = {'runtime': 'workerd', 'sources': sources, 'commands': commands, 'errors': errors,
             'mixFiles': {str(path.relative_to(output)): hashlib.sha256(path.read_bytes()).hexdigest() for path in mix_directory.rglob('*.mix')},
             'snapshots': {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in snapshots}}
    (output / 'proof.json').write_text(json.dumps(proof, indent=2))
    if code or errors:
        print(json.dumps({'exitCode': code, 'errors': errors, 'output': str(output)}))
        return code or 1
    command = ['python3', 'scripts/testing/coverage.py', '--wasm-mix-dir', str(mix_directory), '--output', str(output / 'coverage.json'), '--report-only']
    for name in snapshots:
        command += ['--wasm-tix', str(output / name)]
    code = execute(command, 'report.log')
    report = json.loads((output / 'coverage.json').read_text()) if not code else {}
    print(json.dumps({'output': str(output), 'snapshots': len(snapshots), 'wasmModules': len(report.get('wasm_hpc', [])), 'errors': report.get('errors'), 'complete': report.get('complete')}))
    if not code and not report.get('errors'):
        (ROOT / 'artifacts/testing/wasm-coverage-latest.json').write_text(json.dumps({'proof': str((output / 'proof.json').relative_to(ROOT))}))
    return code or (1 if report.get('errors') else 0)


if __name__ == '__main__':
    raise SystemExit(main())
