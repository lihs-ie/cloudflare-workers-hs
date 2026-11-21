#!/usr/bin/env python3
"""Shared local/CI commands. Preserve failing exit codes and replay evidence."""
import argparse
import datetime
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / 'examples/url-shortener'
LIBRARY_RUNTIME = ROOT / 'tests/runtime'
HOST = [
    'cloudflare-workers:test:unit', 'cloudflare-workers:test:host-testkit-unit',
    'servant-cloudflare-workers:test:unit', 'servant-cloudflare-workers-client:test:unit',
    'servant-cloudflare-workers-access:test:unit', 'url-shortener:test:unit',
    'conformance-oracle:test:unit', 'url-shortener-domain:test:unit',
    'url-shortener-management:test:unit',
    'testing-support:test:integration', 'workflow-example:test:unit',
    'minimal-worker:test:unit', 'static-assets-worker:test:unit', 'realtime-worker:test:unit',
]


def source_snapshot():
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    sources = {}
    for name in sorted(set(names)):
        path = ROOT / name
        # Hash fixtures and configuration too, including new extensions. Only
        # repository-level narrative documentation is outside execution inputs.
        if name and path.is_file() and Path(name).parts[0] != 'docs' and name != 'README.md':
            sources[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return sources


def valid_javascript_proof(report, proof_file, sources):
    try:
        proof = json.loads(proof_file.read_text())
        return (proof['sources'] == sources and type(proof['exit_code']) is int and proof['exit_code'] == 0
                and proof['sha256'] == hashlib.sha256(report.read_bytes()).hexdigest())
    except (OSError, ValueError, KeyError, TypeError):
        return False



def wasm_coverage_arguments(root, sources):
    try:
        pointer = json.loads((root / 'artifacts/testing/wasm-coverage-latest.json').read_text())
        proof_file = (root / pointer['proof']).resolve()
        if not proof_file.is_relative_to(root.resolve()):
            return []
        proof = json.loads(proof_file.read_text())
        if proof['sources'] != sources or proof['errors'] or not proof['commands'] or any(type(command['exitCode']) is not int or command['exitCode'] != 0 for command in proof['commands']):
            return []
        if not proof['snapshots'] or not proof['mixFiles']:
            return []
        output = proof_file.parent
        for name, expected in {**proof['snapshots'], **proof['mixFiles']}.items():
            path = (output / name).resolve()
            if not path.is_relative_to(output) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                return []
        arguments = ['--wasm-mix-dir', str(output / 'mix')]
        if proof.get('compiler'):
            from Support.coverage_evidence import host_projection_proof
            host_projection_proof(root, proof_file, runtime='wasm')
            arguments.extend(['--wasm-proof', str(proof_file)])
        for name in sorted(proof['snapshots']):
            arguments.extend(['--wasm-tix', str(output / name)])
        for report in proof.get('javascriptReports', []):
            path = (output / report['path']).resolve()
            if not path.is_relative_to(output) or hashlib.sha256(path.read_bytes()).hexdigest() != report['sha256']:
                return []
            arguments.extend(['--istanbul', str(path)])
        return arguments
    except (OSError, ValueError, KeyError, TypeError):
        return []


def python_coverage_arguments(root, sources):
    try:
        pointer = json.loads((root / 'artifacts/testing/python-coverage-latest.json').read_text())
        report, proof = [(root / pointer[key]).resolve() for key in ['report', 'proof']]
        if not all(path.is_relative_to(root.resolve()) for path in [report, proof]):
            return []
        return ['--python-json', str(report)] if valid_javascript_proof(report, proof, sources) else []
    except (OSError, ValueError, KeyError, TypeError):
        return []


def verified_hpc_arguments(root, proof_path, sources):
    """Validate the exact fresh HPC input set before handing it to aggregation."""
    try:
        root = root.resolve()
        proof_path = proof_path.resolve()
        if not proof_path.is_relative_to(root):
            return []
        proof = json.loads(proof_path.read_text())
        if type(proof['exit_code']) is not int or proof['exit_code'] != 0:
            return []
        if proof['sources'] != sources or proof['errors'] or not proof['commands'] or any(type(record['exitCode']) is not int or record['exitCode'] != 0 for record in proof['commands']):
            return []
        for record in proof['commands']:
            log_path = (proof_path.parent / record['log']).resolve()
            if not log_path.is_relative_to(proof_path.parent) or hashlib.sha256(log_path.read_bytes()).hexdigest() != record['logSha256']:
                return []
        for category in ['snapshots', 'mixFiles']:
            if not proof[category]:
                return []
            for name, digest in proof[category].items():
                path = (proof_path.parent / name).resolve()
                if not path.is_relative_to(proof_path.parent) or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    return []
        mix_root = proof_path.parent / 'mix'
        actual_mix = {str(path.relative_to(proof_path.parent)) for path in mix_root.rglob('*.mix')}
        if actual_mix != set(proof['mixFiles']):
            return []
        arguments = ['--mix-dir', str(mix_root)]
        for name in sorted(proof['snapshots']):
            arguments.extend(['--tix', str(proof_path.parent / name)])
        return arguments
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []


def native_coverage_arguments(root, sources, pointer_name='native-tools-coverage-latest.json'):
    """Accept fresh native CLI/driver counters only with intact run evidence."""
    try:
        root = root.resolve()
        pointer = json.loads((root / 'artifacts/testing' / pointer_name).read_text())
        proof_path = (root / pointer['proof']).resolve()
        if not proof_path.is_relative_to(root) or hashlib.sha256(proof_path.read_bytes()).hexdigest() != pointer['sha256']:
            return []
        return verified_hpc_arguments(root, proof_path, sources)
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []


def istanbul_pointer_arguments(root, sources, pointer_name):
    """Accept Istanbul output only with successful matching source evidence."""
    try:
        pointer = json.loads((root / 'artifacts/testing' / pointer_name).read_text())
        report, proof = [(root / pointer[key]).resolve() for key in ['report', 'proof']]
        if not all(path.is_relative_to(root.resolve()) for path in [report, proof]):
            return []
        return ['--istanbul', str(report)] if valid_javascript_proof(report, proof, sources) else []
    except (OSError, ValueError, KeyError, TypeError):
        return []


def npm_coverage_arguments(root, sources):
    return istanbul_pointer_arguments(root, sources, 'npm-coverage-latest.json')


def example_node_coverage_arguments(root, sources):
    arguments = istanbul_pointer_arguments(root, sources, 'example-node-coverage-latest.json')
    if not arguments:
        return []
    try:
        from Support.v8_queries import canonical_report
        pointer = json.loads((root / 'artifacts/testing/example-node-coverage-latest.json').read_text())
        path = (root / pointer['proof']).resolve()
        proof = json.loads(path.read_text())
        for record in proof.get('queryProvenance', []):
            inputs = []
            for field in ['raw', 'canonical']:
                artifact = (path.parent / record[field]).resolve()
                if not artifact.is_relative_to(path.parent) or hashlib.sha256(artifact.read_bytes()).hexdigest() != record[field + 'Sha256']:
                    return []
                inputs.append(json.loads(artifact.read_text()))
            expected, rewrites = canonical_report(root, inputs[0], sources, proof['nodeSources'])
            if expected != inputs[1] or rewrites != record['rewrites']:
                return []
        return arguments
    except (OSError, ValueError, TypeError, KeyError):
        return []


def workerd_javascript_coverage_arguments(root, sources):
    """Require intact isolate snapshots and instrumentation manifests as well."""
    arguments = istanbul_pointer_arguments(root, sources, 'workerd-js-coverage-latest.json')
    if not arguments:
        return []
    try:
        pointer = json.loads((root / 'artifacts/testing/workerd-js-coverage-latest.json').read_text())
        proof_path = (root / pointer['proof']).resolve()
        proof = json.loads(proof_path.read_text())
        if proof['errors'] or not proof['commands'] or any(type(command['exitCode']) is not int or command['exitCode'] != 0 for command in proof['commands']):
            return []
        for category in ['snapshots', 'manifests']:
            if not proof[category]:
                return []
            for name, expected in proof[category].items():
                path = (proof_path.parent / name).resolve()
                if not path.is_relative_to(proof_path.parent) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                    return []
        return arguments
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return []


def shared_javascript_coverage_arguments(root, sources):
    """Prefer authenticated shared counters; retain an explicit workerd-only fallback."""
    from Support.coverage_evidence import validated_shared_javascript
    try:
        root = root.resolve()
        pointer = json.loads((root / 'artifacts/testing/shared-js-coverage-latest.json').read_text())
        paths = {key: (root / pointer[key]).resolve() for key in ('report', 'proof', 'workerdOnly')}
        if not all(path.is_relative_to(root) for path in paths.values()):
            raise ValueError('Shared JavaScript pointer escapes repository')
        if hashlib.sha256(paths['proof'].read_bytes()).hexdigest() != pointer['proofSha256']:
            raise ValueError('Shared JavaScript pointer proof hash differs')
        verified = validated_shared_javascript(root, paths['proof'], sources)
        if paths['report'] != verified['combined'] or paths['workerdOnly'] != verified['workerdOnly']:
            raise ValueError('Shared JavaScript pointer report differs')
        return ['--shared-js-proof', str(paths['proof'])]
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
        fallback = workerd_javascript_coverage_arguments(root, sources)
        return fallback + ['--workerd-only', fallback[1]] if fallback else []


def haskell_coverage_arguments(root, sources):
    try:
        pointer = json.loads((root / 'artifacts/testing/haskell-validation-latest.json').read_text())
        path = (root / pointer['proof']).resolve()
        if not path.is_relative_to(root.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != pointer['sha256']:
            return []
        proof = json.loads(path.read_text())
        if proof['sources'] != sources or proof['exit_code'] != 0 or proof['errors']:
            return []
        return ['--haskell-proof', str(path)]
    except (OSError, ValueError, TypeError, KeyError):
        return []


def shell_coverage_arguments(root, sources):
    """Discover successful kcov output while preserving per-script source matching."""
    try:
        pointer = json.loads((root / 'artifacts/testing/shell-coverage-latest.json').read_text())
        report_path = (root / pointer['report']).resolve()
        if not report_path.is_relative_to(root.resolve()):
            return []
        if hashlib.sha256(report_path.read_bytes()).hexdigest() != pointer['sha256']:
            return []
        report = json.loads(report_path.read_text())
        if (report['schema'] != 1 or report['collector']['name'] != 'kcov'
                or not report['files'] or type(report['contracts']['passed']) is not int
                or report['contracts']['passed'] <= 0):
            return []
        if any(sources.get(path) != entry['sha256'] for path, entry in report['files'].items()):
            return []
        return ['--shell-json', str(report_path)]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def compile_coverage_arguments(root, sources):
    """Accept only the compiler producer's current, content-matched pointer."""
    try:
        pointer = json.loads((root / 'artifacts/testing/compile-validation-latest.json').read_text())
        proof_path = (root / pointer['proof']).resolve()
        if not proof_path.is_relative_to(root.resolve()):
            return []
        if hashlib.sha256(proof_path.read_bytes()).hexdigest() != pointer['sha256']:
            return []
        proof = json.loads(proof_path.read_text())
        if (proof['sources'] != sources or proof['errors']
                or type(proof['exit_code']) is not int or proof['exit_code'] != 0
                or not proof['validated'] or not proof['commands']
                or any(type(command['exitCode']) is not int or command['exitCode'] != 0 for command in proof['commands'])):
            return []
        return ['--compile-proof', str(proof_path)]
    except (OSError, ValueError, KeyError, TypeError):
        return []


def production_coverage_arguments(example, sources):
    report = example / 'test-artifacts/coverage/production/coverage-final.json'
    proof = report.with_name('run-proof.json')
    return ['--istanbul', str(report)] if valid_javascript_proof(report, proof, sources) else []


def successful_summaries(log, target_count):
    passed = re.findall(r'^\s*Passed:\s+(\d+)', log, re.M)
    failed = re.findall(r'^\s*Failed:\s+(\d+)', log, re.M)
    return (len(passed) == target_count and len(failed) == target_count
            and all(int(n) > 0 for n in passed) and all(int(n) == 0 for n in failed))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lane', choices=['host', 'conformance', 'integration', 'model', 'coverage', 'replay', 'dev', 'docker', 'api-catalog', 'queued-jobs', 'minimal', 'static-assets', 'realtime', 'workflows'])
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--examples', type=int, default=100)
    parser.add_argument('--target', help='Cabal test target for replay')
    parser.add_argument('--match', help='Sydtest test-name filter for replay')
    parser.add_argument('--host-proof', type=Path, help='Aggregate existing authenticated host evidence without rerunning suites')
    parser.add_argument('--report-only', action='store_true', help='Coverage evidence only; does not assert completion')
    parser.add_argument('--compile-proof', type=Path, help='Successful compiler input/source proof for the coverage lane')
    parser.add_argument('--native-compile-proof', type=Path, help='Native compiler evidence for verified Haskell reexports')
    parser.add_argument('--shell-json', type=Path, help='Source-matched kcov evidence for the coverage lane; branches remain unmeasured')
    parser.add_argument('--skip-runtime-build', action='store_true',
                        help='Reuse a runtime WASM artifact built earlier in the same CI job')
    args = parser.parse_args()
    if args.examples <= 0:
        parser.error('--examples must be positive')
    if args.lane == 'replay' and not args.target:
        parser.error('replay requires --target')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = ROOT / 'artifacts/testing' / f'{args.lane}-{stamp}'
    output.mkdir(parents=True)
    env = os.environ.copy()
    # macOS GHC HPC emits C stubs whose RTS header needs libffi headers.
    ffi = Path('/opt/homebrew/opt/libffi/include')
    if sys.platform == 'darwin' and (ffi / 'ffi.h').exists():
        env['C_INCLUDE_PATH'] = str(ffi) + (os.pathsep + env['C_INCLUDE_PATH'] if env.get('C_INCLUDE_PATH') else '')
    env.update(SYDTEST_SEED=str(args.seed), SYDTEST_MAX_SUCCESS=str(args.examples),
               SYDTEST_RETRIES='0', SYDTEST_GOLDEN_START='False', SYDTEST_GOLDEN_RESET='False',
               SYDTEST_COLOUR='False', SYDTEST_SKIP_PASSED='False')
    records = []
    initial_sources = source_snapshot()
    javascript = EXAMPLE / 'test-artifacts/coverage/runtime/coverage-final.json'
    javascript_proof = javascript.with_name('run-proof.json')

    def run(command, cwd=ROOT):
        log = output / f'{len(records):02d}.log'
        print('+ ' + ' '.join(command), flush=True)
        record = {'command': command, 'cwd': str(cwd.relative_to(ROOT)) or '.', 'log': log.name}
        records.append(record)
        try:
            with log.open('w') as stream:
                process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
                for line in process.stdout:
                    stream.write(line)
                    print(line, end='', flush=True)
                code = process.wait()
        except OSError as error:
            log.write_text(str(error) + '\n')
            print(error, file=sys.stderr)
            code = 127
        record['exit_code'] = code
        (output / 'run.json').write_text(json.dumps({'lane': args.lane, 'seed': args.seed,
            'examples': args.examples, 'report_only': args.report_only, 'sources': initial_sources,
            'commands': records}, indent=2) + '\n')
        return code

    def cabal(targets):
        command = ['cabal', 'test', *targets, '--project-file=cabal.project',
                   '--builddir=dist-testing',
                   '-j2', '--keep-going', '--test-show-details=direct']
        if args.match:
            # Cabal parses test-options as a command line: quote the filter explicitly.
            import shlex
            command.append('--test-options=' + shlex.join(['--match', args.match]))
        code = run(command)
        if code == 0:
            log = (output / records[-1]['log']).read_text()
            if not successful_summaries(log, len(targets)):
                print('Missing, empty or failed runner summary; refusing a successful Cabal exit.', file=sys.stderr)
                code = 1
        return code

    codes = []
    if args.lane == 'host':
        codes.append(cabal(HOST))
    elif args.lane == 'conformance':
        codes.append(cabal(['servant-cloudflare-workers:test:conformance']))
    elif args.lane == 'replay':
        codes.append(cabal([args.target]))
    elif args.lane in ('integration', 'model'):
        library_build = 0 if args.skip_runtime_build else run(['pnpm', 'run', 'build:runtime'], ROOT / 'tests/runtime')
        codes.append(library_build)
        build = library_build if library_build else (0 if args.skip_runtime_build or args.lane == 'model' else run(['pnpm', 'run', 'build:runtime'], EXAMPLE))
        codes.append(build)
        if build == 0:
            if args.lane == 'integration':
                library_tests = run(['pnpm', 'run', 'test:runtime:coverage'], ROOT / 'tests/runtime')
                codes.append(library_tests)
                library_report = ROOT / 'tests/runtime/test-artifacts/coverage/runtime/coverage-final.json'
                if library_tests == 0 and library_report.exists() and initial_sources == source_snapshot():
                    library_report.with_name('run-proof.json').write_text(json.dumps({
                        'sources': initial_sources, 'exit_code': 0,
                        'sha256': hashlib.sha256(library_report.read_bytes()).hexdigest(),
                        'run': str(output.relative_to(ROOT)),
                    }, indent=2) + '\n')
                runtime = run(['pnpm', 'run', 'test:runtime:coverage'], EXAMPLE)
                codes.append(runtime)
                if runtime == 0 and javascript.exists() and initial_sources == source_snapshot():
                    javascript_proof.write_text(json.dumps({'sources': initial_sources,
                        'sha256': hashlib.sha256(javascript.read_bytes()).hexdigest(),
                        'run': str(output.relative_to(ROOT)), 'exit_code': 0}, indent=2) + '\n')
                production = run(['bash', 'scripts/build-wasm.sh'], EXAMPLE)
                codes.append(production)
                if production == 0:
                    production_tests = run(['pnpm', 'run', 'test:integration', '--coverage'], EXAMPLE)
                    codes.append(production_tests)
                    production_report = EXAMPLE / 'test-artifacts/coverage/production/coverage-final.json'
                    if production_tests == 0 and production_report.exists() and initial_sources == source_snapshot():
                        production_report.with_name('run-proof.json').write_text(json.dumps({
                            'sources': initial_sources, 'exit_code': 0,
                            'sha256': hashlib.sha256(production_report.read_bytes()).hexdigest(),
                            'run': str(output.relative_to(ROOT)),
                        }, indent=2) + '\n')
            else:
                bundle = run(['pnpm', 'run', 'build:model'], ROOT / 'tests/runtime')
                codes.append(bundle)
                if bundle == 0:
                    codes.append(cabal(['runtime-contracts:test:model']))
    elif args.lane in ('dev', 'docker'):
        for target in [['runtime-tests'], []]:
            codes.append(run(['bash', 'scripts/build-wasm.sh', *target], EXAMPLE))
            if codes[-1] != 0:
                break
        if all(code == 0 for code in codes):
            if args.lane == 'docker':
                codes.append(run(['node', 'scripts/testing/typecheck.mts', 'url-shortener']))
                for example in ['api-catalog', 'queued-jobs', 'minimal', 'static-assets', 'realtime', 'workflows']:
                    if any(code != 0 for code in codes):
                        break
                    code = run(['bash', 'examples/' + example + '/scripts/build.sh'])
                    codes.append(code)
                    if code != 0:
                        break
                    code = run(['node', 'scripts/testing/typecheck.mts', example])
                    codes.append(code)
                    if code != 0:
                        break
            if all(code == 0 for code in codes):
                codes.append(run(['pnpm', 'run', 'test:' + args.lane], EXAMPLE))
    elif args.lane in ('api-catalog', 'queued-jobs', 'minimal', 'static-assets', 'realtime', 'workflows'):
        example = 'examples/' + args.lane
        library = run(['bash', example + '/scripts/build.sh'])
        codes.append(library)
        if library == 0:
            library = run(['node', 'scripts/testing/typecheck.mts', args.lane])
            codes.append(library)
        if library == 0:
            tests = sorted(str(path.relative_to(ROOT)) for path in (ROOT / example / 'test/integration').glob('*.spec.mts'))
            if not tests:
                raise RuntimeError('No integration tests found for ' + example)
            codes.append(run(['node', '--test', '--test-concurrency=1', *tests]))
    elif args.lane == 'coverage':
        host_proof_path = args.host_proof
        if host_proof_path is None:
            directory = ROOT / 'dist-testing-coverage'
            model_build = 0 if args.skip_runtime_build else run(['pnpm', 'run', 'build:runtime'], ROOT / 'tests/runtime')
            codes.append(model_build)
            if model_build == 0:
                model_build = run(['pnpm', 'run', 'build:model'], ROOT / 'tests/runtime')
                codes.append(model_build)
            targets = HOST + ['servant-cloudflare-workers:test:conformance']
            if model_build == 0:
                targets.append('runtime-contracts:test:model')
            from Support.host_coverage import collect
            host_output = output / 'host'
            host_proof = collect(ROOT, host_output, targets, source_snapshot,
                                 match=args.match, build_directory=directory, environment=env)
            codes.append(host_proof['exit_code'])
            host_proof_path = host_output / 'proof.json'
        host_arguments = verified_hpc_arguments(ROOT, host_proof_path, initial_sources)
        if not host_arguments:
            print('Host coverage evidence is incomplete or invalid; refusing it.', file=sys.stderr)
            codes.append(1)
        command = [sys.executable, 'scripts/testing/coverage.py', '--output', str(output / 'coverage.json')]
        command.extend(host_arguments)
        if host_arguments:
            command.extend(['--host-proof', str(host_proof_path.resolve())])
        if javascript.exists():
            if valid_javascript_proof(javascript, javascript_proof, initial_sources):
                command.extend(['--istanbul', str(javascript)])
            else:
                print('JS coverage has no matching successful run/source proof; leaving it unmeasured.', file=sys.stderr)
        for report in [ROOT / 'tests/runtime/test-artifacts/coverage/runtime/coverage-final.json',
                       EXAMPLE / 'test-artifacts/coverage/production/coverage-final.json']:
            if report.exists() and valid_javascript_proof(report, report.with_name('run-proof.json'), initial_sources):
                command.extend(['--istanbul', str(report)])
        command.extend(wasm_coverage_arguments(ROOT, initial_sources))
        command.extend(native_coverage_arguments(ROOT, initial_sources))
        command.extend(python_coverage_arguments(ROOT, initial_sources))
        command.extend(haskell_coverage_arguments(ROOT, initial_sources))
        command.extend(npm_coverage_arguments(ROOT, initial_sources))
        command.extend(example_node_coverage_arguments(ROOT, initial_sources))
        command.extend(shared_javascript_coverage_arguments(ROOT, initial_sources))
        if args.compile_proof:
            command.extend(['--compile-proof', str(args.compile_proof.resolve())])
        else:
            command.extend(compile_coverage_arguments(ROOT, initial_sources))
        if args.native_compile_proof:
            command.extend(['--native-compile-proof', str(args.native_compile_proof.resolve())])
        if args.shell_json:
            command.extend(['--shell-json', str(args.shell_json.resolve())])
        else:
            command.extend(shell_coverage_arguments(ROOT, initial_sources))
        if args.report_only:
            command.append('--report-only')
        codes.append(run(command))
    final_sources = source_snapshot()
    if initial_sources != final_sources:
        changes = sorted(name for name in initial_sources.keys() | final_sources.keys()
                         if initial_sources.get(name) != final_sources.get(name))
        (output / 'changed-inputs.json').write_text(json.dumps(changes, indent=2) + '\n')
        print('Source/config inputs changed during validation; rerun against a stable tree.', file=sys.stderr)
        codes.append(1)
    print(f'Evidence: {output}')
    return next((code for code in codes if code != 0), 0)


if __name__ == '__main__':
    raise SystemExit(main())
