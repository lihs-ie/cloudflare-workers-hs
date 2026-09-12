#!/usr/bin/env python3
"""Measure example Node helpers; workerd/shared TS uses canonical Istanbul lanes."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess

from run import source_snapshot

ROOT = Path(__file__).resolve().parents[2]
EXAMPLES = ('minimal', 'static-assets', 'realtime', 'workflows', 'library-examples', 'quickstart')
NODE_CONTRACT_SOURCES = (
    'examples/library-examples/test/Support/archive-fixture.ts',
    'examples/library-examples/test/Support/cache-purge.ts',
    'examples/library-examples/test/Support/client-policy.ts',
    'examples/library-examples/test/Support/jobs-settings.ts',
    'examples/library-examples/test/Support/client-stream.ts',
    'examples/library-examples/test/Support/queue-contracts.ts',
    'examples/library-examples/test/Support/jobs-queue.ts',
    'examples/library-examples/test/Support/jobs-state.ts',

    'examples/library-examples/worker/jobs-service.ts',
    'examples/realtime/worker/index.ts',
    'examples/realtime/test/Support/entry.ts',
    'examples/workflows/test/Support/entry.ts',
    'examples/workflows/test/Support/control-probe.ts',
    'examples/quickstart/test/Support/Production/http-contract.ts',
    'examples/quickstart/test/Support/Production/harness.ts',
    'examples/quickstart/test/Support/Runtime/harness.ts',
    'examples/quickstart/test/Support/Runtime/JWKS.ts',
)



def node_sources(sources):
    """Canonical Node inputs; shared Worker TypeScript stays in workerd maps."""
    return sorted(name for name in sources
                  if ((name.startswith('examples/') and name.endswith(('.mjs', '.mts')))
                      or name in ('scripts/testing/pack-consumer.mjs', 'scripts/testing/typecheck.mjs', 'scripts/testing/Support/node-tools.spec.mjs',
                                  'scripts/testing/Support/readiness.mjs', 'scripts/testing/Support/readiness.spec.mjs',
                                  'scripts/testing/Support/build-manifest-contract.spec.mjs',
                                  'scripts/testing/Support/dev-lifecycle-contract.spec.mjs', 'scripts/testing/Support/integration-diagnostics-contract.spec.mjs', 'scripts/testing/Support/vitest-config-contract.spec.mjs', 'scripts/testing/Support/dev-run-contract.spec.mjs', 'scripts/testing/Support/emergency-cleanup-contract.spec.mjs',
                                  'scripts/testing/Support/quickstart-manifest-contract.spec.mjs',
                                  'scripts/testing/Support/quickstart-config-contract.spec.mjs',
                                  'scripts/testing/Support/runtime-lifecycle-contract.spec.mjs',
                                  'scripts/testing/Support/docker-suites-contract.spec.mjs')
                      or name == 'examples/static-assets/public/app.js'
                      or name in ('examples/library-examples/test/Support/Remote/ssec-evidence.ts',
                                  'examples/library-examples/test/Support/Remote/ssec-probe.ts',
                                  'examples/library-examples/test/Support/Remote/cleanup-probe.ts',
                                  'examples/quickstart/test/Support/Dev/gateway.ts')
                      or (name.startswith('scripts/testing/Support/') and name.endswith('.mjs')))
                  and '/worker/' not in name and not name.endswith('.d.mts'))


def commands_for(example):
    if example == 'quickstart':
        return [['node', '--test', *[str(path.relative_to(ROOT)) for path in sorted((ROOT / 'examples/quickstart/test/Support/Coverage').glob('*.spec.mjs'))]],
                ['node', '--test', 'scripts/testing/Support/workerd_js_runtime.spec.mjs', 'scripts/testing/Support/workerd_js.spec.mjs', 'scripts/testing/Support/shared_js_instrumentation.spec.mjs', 'scripts/testing/Support/shared_js_report.spec.mjs', 'scripts/testing/Support/readiness.spec.mjs'],
                ['pnpm', '--dir', 'examples/quickstart', 'test:dev'],
                ['python3', 'scripts/testing/run.py', 'model'],
                ['node', '--test', 'examples/quickstart/test/Support/Production/http-contract.spec.mjs',
                 'examples/quickstart/test/Support/Runtime/storage-bridge.spec.mjs',
                 'examples/quickstart/test/Support/Production/harness-contract.spec.mjs',
                 'examples/quickstart/test/Support/Runtime/harness-contract.spec.mjs']]
    tests = sorted((ROOT / 'examples' / example / 'test/integration').glob('*.spec.mjs'))
    if not tests:
        raise ValueError('No integration tests for ' + example)
    commands = [['node', '--test', '--test-concurrency=1', *[str(path.relative_to(ROOT)) for path in tests]]]
    if example == 'library-examples':
        commands.append(['node', '--experimental-test-module-mocks', '--test',
                         'examples/library-examples/test/Support/Remote/ssec-probe-contract.spec.mjs'])
    contracts = sorted((ROOT / 'examples' / example / 'test/Support').glob('*contract*.spec.mjs'))
    if contracts:
        commands.append(['node', '--experimental-test-module-mocks', '--test', *[str(path.relative_to(ROOT)) for path in contracts]])
    return commands


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--example', action='append', choices=EXAMPLES)
    parser.add_argument('--tools', action='store_true', help='After all Workers close, measure typecheck and pack consumer (rebuilds npm dist)')
    args = parser.parse_args()
    output = (args.output or ROOT / 'artifacts/testing' / ('example-node-coverage-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT / 'artifacts/testing') or output.exists():
        parser.error('Choose a new output directory under artifacts/testing')
    output.mkdir(parents=True)
    sources = source_snapshot()
    raw = output / 'raw'
    raw.mkdir()
    env = dict(os.environ, NODE_V8_COVERAGE=str(raw))
    commands = []
    errors = []
    for example in args.example or EXAMPLES:
        for command in commands_for(example):
            log_name = example + '-' + str(len(commands)) + '.log'
            with (output / log_name).open('w') as log:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            commands.append({'command': command, 'exitCode': result.returncode, 'log': log_name})
            if result.returncode:
                errors.append('Test command failed: ' + example)
                break
        if errors:
            break
    if not errors and args.tools:
        contracts = sorted((ROOT / 'scripts/testing/Support').glob('*contract*.spec.mjs'))
        tool_tests = ['scripts/testing/Support/node-tools.spec.mjs', 'scripts/testing/Support/module-boundaries.spec.mjs',
                      *[str(path.relative_to(ROOT)) for path in contracts]]
        for command in [['node', '--experimental-test-module-mocks', '--test', *tool_tests],
                        ['node', 'scripts/testing/typecheck.mjs', '--check'],
                        ['node', 'scripts/testing/pack-consumer.mjs']]:
            log_name = 'tools-' + str(len(commands)) + '.log'
            with (output / log_name).open('w') as log:
                result = subprocess.run(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            commands.append({'command': command, 'exitCode': result.returncode, 'log': log_name})
            if result.returncode:
                errors.append('Tool command failed (see ' + log_name + '): ' + json.dumps(command))
                break
    config = output / 'c8.json'
    config.write_text(json.dumps({'all': True, 'include': node_sources(sources), 'exclude': [],
                                 'src': ['examples', 'scripts/testing'], 'extension': ['.mjs', '.mts', '.js', '.ts'], 'reporter': ['json', 'text', 'html'],
                                 'temp-directory': str(raw), 'reports-dir': str(output / 'report')}))
    c8 = ROOT / 'packages/worker-runtime/node_modules/c8/bin/c8.js'
    with (output / 'report.log').open('w') as log:
        report_run = subprocess.run(['node', str(c8), '--config', str(config), 'report'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    if report_run.returncode:
        errors.append('c8 report failed')
    report = output / 'report/coverage-final.json'
    if not report.is_file() or not list(raw.glob('*.json')):
        errors.append('Missing report or raw Node evidence')
    if sources != source_snapshot():
        errors.append('Source inputs changed during collection')
    proof = {'sources': sources, 'exit_code': 1 if errors else 0, 'errors': errors,
             'sha256': hashlib.sha256(report.read_bytes()).hexdigest() if report.is_file() else None,
             'commands': commands, 'nodeSources': node_sources(sources),
             'raw': {str(path.relative_to(output)): hashlib.sha256(path.read_bytes()).hexdigest() for path in raw.glob('*.json')},
             'routing': {'sharedTypeScript': 'workerd Istanbul; Node execution not represented as a second runtime proof',
                         'workerTypeScript': 'Node boundary contracts execute listed TypeScript but canonical c8 excludes them to preserve workerd Istanbul maps',
                         'nodeContractSources': NODE_CONTRACT_SOURCES},
             'collector': {'name': 'c8', 'version': json.loads((c8.parent.parent / 'package.json').read_text())['version']}}
    proof_path = output / 'proof.json'
    proof_path.write_text(json.dumps(proof, indent=2))
    if not errors:
        (ROOT / 'artifacts/testing/example-node-coverage-latest.json').write_text(json.dumps({'report': str(report.relative_to(ROOT)), 'proof': str(proof_path.relative_to(ROOT))}))
    print(json.dumps({'output': str(output), 'errors': errors, 'nodeSources': len(node_sources(sources))}))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
