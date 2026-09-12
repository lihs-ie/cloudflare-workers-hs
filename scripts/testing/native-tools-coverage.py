#!/usr/bin/env python3
"""Measure native executable tools with fresh, per-invocation HPC destinations."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from run import source_snapshot
from Support.host_plugin_probe import collect as collect_plugin

ROOT = Path(__file__).resolve().parents[2]
TARGETS = {'discovery': 'testing-support:exe:sydtest-discover-layer', 'oracle': 'conformance-oracle:exe:regenerate-conformance-golden'}


def log_evidence(output, log):
    path = (output / log).resolve()
    if not path.is_relative_to(output.resolve()):
        raise ValueError('Command log escapes native proof directory')
    return {'log': str(path.relative_to(output.resolve())), 'logSha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def run_probe(binary, arguments, cwd, output, label, expected_success, expected_message, environment):
    tix = output / (label + '.tix')
    if tix.exists():
        raise ValueError('Refusing existing probe counters: ' + str(tix))
    command = [str(binary), *map(str, arguments)]
    completed = subprocess.run(command, cwd=cwd, env={**environment, 'HPCTIXFILE': str(tix)}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
    (output / (label + '.log')).write_text(completed.stdout)
    if (completed.returncode == 0) != expected_success or expected_message not in completed.stdout:
        raise ValueError('Unexpected native tool result: ' + label)
    if not tix.is_file() or not tix.read_text().startswith('Tix ['):
        raise ValueError('Native executable produced no HPC evidence: ' + label)
    return {'command': command, 'processExitCode': completed.returncode, 'expectedSuccess': expected_success, 'assertionsPassed': True, 'exitCode': 0, 'tix': tix.name, **log_evidence(output, label + '.log')}


def collect(root, output, snapshot):
    sources = snapshot()
    proof = {'sources': sources, 'commands': [], 'snapshots': {}, 'mixFiles': {}, 'errors': []}
    build = output / 'build'
    environment = dict(os.environ)
    ffi = Path('/opt/homebrew/opt/libffi/include')
    if sys.platform == 'darwin' and ffi.is_dir():
        environment['C_INCLUDE_PATH'] = str(ffi) + (os.pathsep + environment['C_INCLUDE_PATH'] if environment.get('C_INCLUDE_PATH') else '')
    environment.pop('HPCTIXFILE', None)
    binaries = {}
    try:
        command = ['cabal', 'build', *TARGETS.values(), '--project-file=cabal.project', '--builddir=' + str(build), '--enable-coverage', '-j2']
        with (output / 'build.log').open('w') as log:
            built = subprocess.run(command, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT, timeout=600)
        proof['commands'].append({'command': command, 'exitCode': built.returncode, **log_evidence(output, 'build.log')})
        if built.returncode:
            raise ValueError('Native tool coverage build failed')
        for name, target in TARGETS.items():
            result = subprocess.run(['cabal', 'list-bin', target, '--project-file=cabal.project', '--builddir=' + str(build)], cwd=root, env=environment, capture_output=True, text=True, check=True, timeout=30)
            binary = Path(result.stdout.strip()).resolve()
            if not binary.is_relative_to(build) or not binary.is_file():
                raise ValueError('Native executable is not in the isolated build')
            binaries[name] = binary
        fixtures = output / 'fixtures'
        layer = fixtures / 'test/unit'
        layer.mkdir(parents=True)
        (layer / 'Spec.hs').write_text('')
        (layer / 'HTTPSpec.hs').write_text('module HTTPSpec where\nspec = pure ()\n')
        (fixtures / 'test/Support').mkdir()
        (fixtures / 'test/Support/HiddenSpec.hs').write_text('')
        generated = fixtures / 'generated.hs'
        proof['commands'].append(run_probe(binaries['discovery'], [layer / 'Spec.hs', layer / 'Spec.hs', generated], fixtures, output, 'discovery-success', True, '', environment))
        content = generated.read_text()
        if 'HTTPSpec' not in content or 'HiddenSpec' in content:
            raise ValueError('Discovery did not preserve layer isolation')
        proof['commands'].append(run_probe(binaries['discovery'], [], fixtures, output, 'discovery-invalid-arguments', False, 'expected GHC source, input and output paths', environment))
        golden = fixtures / 'reference.json'
        proof['commands'].append(run_probe(binaries['oracle'], [golden], fixtures, output, 'oracle-success', True, '', environment))
        expected = root / 'conformance-oracle/test/Support/Golden/reference.json'
        if json.loads(golden.read_text()) != json.loads(expected.read_text()):
            raise ValueError('Oracle CLI generated a different contract document')
        proof['commands'].append(run_probe(binaries['oracle'], [], fixtures, output, 'oracle-invalid-arguments', False, 'Usage: regenerate-conformance-golden', environment))
        for mode in ['compat', 'wasm']:
            plugin = collect_plugin(root, output / ('compiler-' + mode), wasm_plugin=mode == 'wasm')
            if plugin['status'] != 'passed':
                raise ValueError('Compiler plugin behavior probe failed')
            records = plugin.get('commandRecords', [])
            if not records or [record.get('command') for record in records] != plugin['commands']:
                raise ValueError('Compiler plugin command evidence is incomplete')
            for record in records:
                plugin_output = output / ('compiler-' + mode)
                log = log_evidence(plugin_output, record['log'])
                if type(record.get('exitCode')) is not int or record['exitCode'] != 0 or record.get('logSha256') != log['logSha256']:
                    raise ValueError('Compiler plugin command evidence is invalid')
                proof['commands'].append({'command': record['command'], 'exitCode': 0, 'kind': 'compiler-contract',
                                          **log_evidence(output, str(Path('compiler-' + mode) / log['log']))})
            plugin_tix = output / ('compiler-' + mode + '.tix')
            shutil.copyfile(root / plugin['tix'], plugin_tix)
            proof['snapshots'][plugin_tix.name] = hashlib.sha256(plugin_tix.read_bytes()).hexdigest()
            original_mix = root / plugin['mix']
            relative_mix = Path('mix/compiler-' + mode) / original_mix.parent.name / original_mix.name
            copied_mix = output / relative_mix
            copied_mix.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original_mix, copied_mix)
            proof['mixFiles'][str(relative_mix)] = hashlib.sha256(copied_mix.read_bytes()).hexdigest()
            proof.setdefault('compilerContracts', []).append({'mode': mode, 'proof': str((output / ('compiler-' + mode) / 'proof.json').relative_to(root)), 'prim': plugin['prim']})
            if mode == 'compat':
                interfaces = list((output / 'compiler-compat/build').rglob('Prim.hi'))
                if len(interfaces) != 1:
                    raise ValueError('Expected one fresh Prim interface')
                saved_interface = output / 'Prim.hi'
                shutil.copyfile(interfaces[0], saved_interface)
                dump = subprocess.run(['ghc', '--show-iface', str(saved_interface)], capture_output=True, text=True, check=True, timeout=30)
                dump_file = output / 'Prim.interface'
                dump_file.write_text(dump.stdout)
                ghc = Path(shutil.which('ghc')).resolve()
                version = subprocess.check_output(['ghc', '--numeric-version'], text=True).strip()
                proof['commands'].append({'command': ['ghc', '--show-iface', str(saved_interface)], 'exitCode': 0, **log_evidence(output, 'Prim.interface')})
                proof['compileValidations'] = [{'path': 'cloudflare-workers/shim/compat/GHC/Wasm/Prim.hs', 'kind': 'haskell-reexport',
                    'interface': {'path': saved_interface.name, 'sha256': hashlib.sha256(saved_interface.read_bytes()).hexdigest()},
                    'dump': {'path': dump_file.name, 'sha256': hashlib.sha256(dump_file.read_bytes()).hexdigest()},
                    'compiler': {'path': str(ghc), 'sha256': hashlib.sha256(ghc.read_bytes()).hexdigest(), 'version': version},
                    'probe': {'path': 'compiler-compat/probe.log', 'sha256': hashlib.sha256((output / 'compiler-compat/probe.log').read_bytes()).hexdigest()}}]

        for mix in build.rglob('*.mix'):
            relative = Path('mix') / mix.relative_to(build)
            destination = output / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(mix, destination)
            proof['mixFiles'][str(relative)] = hashlib.sha256(destination.read_bytes()).hexdigest()
        for record in proof['commands']:
            if 'tix' in record:
                proof['snapshots'][record['tix']] = hashlib.sha256((output / record['tix']).read_bytes()).hexdigest()
        if not proof['mixFiles'] or len(proof['snapshots']) != 6:
            raise ValueError('Incomplete native tool coverage')
        if snapshot() != sources:
            raise ValueError('Source/config changed during native tool verification')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        proof['errors'].append(str(error))
    proof['exit_code'] = 1 if proof['errors'] else 0
    proof_path = output / 'proof.json'
    proof_path.write_text(json.dumps(proof, indent=2) + '\n')
    if proof['errors']:
        return 1
    pointer = root / 'artifacts/testing/native-tools-coverage-latest.json'
    pointer.write_text(json.dumps({'proof': str(proof_path.relative_to(root)), 'sha256': hashlib.sha256(proof_path.read_bytes()).hexdigest()}, indent=2) + '\n')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = (args.output or ROOT / 'artifacts/testing' / ('native-tools-coverage-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT / 'artifacts/testing') or output.exists():
        parser.error('Choose a new output directory inside artifacts/testing')
    output.mkdir(parents=True)
    code = collect(ROOT, output, source_snapshot)
    print('Native tool evidence: ' + str(output))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
