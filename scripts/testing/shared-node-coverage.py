#!/usr/bin/env python3
"""Fresh Node boundary counters using exactly the workerd TypeScript instrumenter."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
from run import source_snapshot

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def contract_commands(root):
    tests = sorted(path for path in (root / 'examples').glob('*/test/Support/**/*contract*.spec.mjs'))
    tests.extend((root / 'scripts/testing/Support').glob('*contract*.spec.mjs'))
    tests.append(root / 'examples/quickstart/test/Support/Runtime/storage-bridge.spec.mjs')
    tests.append(root / 'examples/library-examples/test/integration/log-records.spec.mjs')
    tests = sorted(set(tests))
    return [['node', '--import', str(root / 'scripts/testing/Support/node_shared_coverage.mjs'),
             '--experimental-test-module-mocks', '--test', '--test-concurrency=1',
             str(path.relative_to(root))] for path in tests]


def collect(output, sources):
    output.mkdir(parents=True)
    (output / 'bundles').mkdir()
    (output / 'snapshots').mkdir()
    commands, errors = [], []
    inputs = output / 'inputs.json'
    inputs.write_text(json.dumps(sorted(sources)))
    env = dict(os.environ, SHARED_JS_COVERAGE_DIRECTORY=str(output), SHARED_JS_COVERAGE_INPUTS=str(inputs))
    env.pop('NODE_V8_COVERAGE', None)
    preload = (ROOT / 'scripts/testing/Support/node_shared_coverage.mjs').as_uri()
    env['NODE_OPTIONS'] = (env.get('NODE_OPTIONS', '') + ' --import=' + preload).strip()
    for index, command in enumerate(contract_commands(ROOT)):
        log_path = output / f'contract-{index}.log'
        with log_path.open('w') as log:
            result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        commands.append({'command': command, 'exitCode': result.returncode,
                         'log': log_path.name, 'logSha256': digest(log_path)})
        if result.returncode:
            errors.append('Node boundary command failed: ' + command[-1])
            break
    manifests = {str(p.relative_to(output)): digest(p) for p in (output / 'bundles').glob('*/manifest.json')}
    snapshots = {str(p.relative_to(output)): digest(p) for p in (output / 'snapshots').glob('*.json')}
    if not manifests or not snapshots:
        errors.append('Missing shared instrumentation manifests or snapshots')
    with (output / 'report.log').open('w') as log:
        result = subprocess.run(['node', 'scripts/testing/Support/workerd_js_report.mjs', str(output)],
                                cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    report = output / 'coverage-final.json'
    if result.returncode or not report.is_file():
        errors.append('Shared instrumentation report failed')
    if source_snapshot() != sources:
        errors.append('Sources changed during shared Node collection')
    proof = {'sources': sources, 'exit_code': 1 if errors else 0, 'errors': errors,
             'commands': commands, 'manifests': manifests, 'snapshots': snapshots,
             'sha256': digest(report) if report.is_file() else None,
             'semantics': 'Node boundary doubles; same authored TypeScript instrumenter as workerd, not Cloudflare execution'}
    (output / 'proof.json').write_text(json.dumps(proof, indent=2))
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--workerd', type=Path, required=True)
    args = parser.parse_args()
    output = (args.output or ROOT / 'artifacts/testing' / ('shared-js-coverage-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT / 'artifacts/testing') or output.exists():
        parser.error('Choose a new directory under artifacts/testing')
    output.mkdir(parents=True)
    proof = collect(output / 'node', source_snapshot())
    if proof['errors']:
        print(json.dumps({'output': str(output), 'errors': proof['errors']}))
        return 1
    result = subprocess.run(['node', 'scripts/testing/Support/shared_js_report.mjs',
                             str(args.workerd.resolve()), str(output / 'node'), str(output / 'combined')], cwd=ROOT)
    if result.returncode:
        return result.returncode
    report, proof_path = output / 'combined/coverage-final.json', output / 'combined/proof.json'
    (ROOT / 'artifacts/testing/shared-js-coverage-latest.json').write_text(json.dumps({
        'report': str(report.relative_to(ROOT)), 'proof': str(proof_path.relative_to(ROOT)),
        'proofSha256': digest(proof_path), 'workerdOnly': str((output / 'combined/workerd-only.json').relative_to(ROOT))}))
    print(json.dumps({'output': str(output), 'errors': []}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
