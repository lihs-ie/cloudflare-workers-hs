#!/usr/bin/env python3
"""Validate reviewed compiler contracts against actual successful compiler inputs."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from run import source_snapshot
from Support.coverage_evidence import compiler_config_dependencies

ROOT = Path(__file__).resolve().parents[2]


def validation_project(entry):
    explicit = entry.get('compiler_project')
    if explicit is not None:
        if explicit != 'examples/quickstart':
            raise ValueError('Unapproved explicit compiler project')
        return explicit, 'tsconfig.json'
    path = Path(entry['path'])
    if path.parts[:1] == ('examples',) and len(path.parts) >= 3:
        return 'examples/' + path.parts[1], 'tsconfig.json'
    if path.parts[:2] == ('packages', 'worker-runtime'):
        return 'packages/worker-runtime', 'tsconfig.check.json'
    raise ValueError('No approved compiler project for ' + entry['path'])


def compiler_projects(validations):
    return dict(validation_project(entry) for entry in validations)


def collect(root, output, snapshot):
    sources = snapshot()
    manifest = json.loads((root / 'scripts/testing/runtime-scope.json').read_text())
    validations = [entry for entry in manifest.get('validations', []) if entry['kind'] in ('declaration', 'type-contract')]
    if not validations:
        raise ValueError('No reviewed compile validations')
    commands = []
    proof = {'schema': 1, 'sources': sources, 'commands': commands, 'validated': [], 'errors': []}
    proof_path = output / 'proof.json'

    def command(argv, cwd, compiler=False):
        log = output / f'{len(commands):02d}.log'
        record = {'argv': argv, 'cwd': str(cwd.relative_to(root)), 'exitCode': None, 'inputs': [], 'log': str(log.relative_to(root))}
        commands.append(record)
        result = subprocess.run(argv, cwd=cwd, env={**os.environ, 'CI': 'true', 'WRANGLER_SEND_METRICS': 'false'}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        log.write_text(result.stdout)
        record['exitCode'] = result.returncode
        if result.returncode != 0:
            raise ValueError('Compiler/type-generation validation failed: ' + ' '.join(argv))
        if compiler:
            for line in result.stdout.splitlines():
                path = Path(line.strip())
                if not path.is_absolute():
                    continue
                path = path.resolve()
                if path.is_relative_to(root) and str(path.relative_to(root)) in sources:
                    record['inputs'].append(str(path.relative_to(root)))
            record['inputs'] = sorted(set(record['inputs']))
            if not record['inputs']:
                raise ValueError('Successful compiler did not report repository inputs')
        return len(commands) - 1

    try:
        projects = compiler_projects(validations)
        examples = [Path(project).name for project in projects if project.startswith('examples/')]
        if examples:
            # --check must not regenerate tracked declarations during the frozen run.
            command(['node', 'scripts/testing/typecheck.mjs', '--check', *examples], root)
        for project, config in projects.items():
            binary = root / ('examples/quickstart/node_modules/.bin/tsc' if project.startswith('examples/') else 'packages/worker-runtime/node_modules/.bin/tsc')
            index = command([str(binary), '--project', config, '--noEmit', '--listFiles'], root / project, compiler=True)
            dependencies = compiler_config_dependencies(root, commands[index])
            if not dependencies.issubset(sources):
                raise ValueError('Compiler configuration missing from source snapshot')
            for entry in validations:
                if validation_project(entry)[0] == project:
                    if entry['path'] not in commands[index]['inputs']:
                        raise ValueError('Reviewed contract is not a compiler input: ' + entry['path'])
                    proof['validated'].append({'path': entry['path'], 'kind': entry['kind'], 'commandIndex': index})
        if len(proof['validated']) != len(validations):
            raise ValueError('Not every reviewed contract was validated')
        if snapshot() != sources:
            raise ValueError('Source/config changed during compile validation')
    except (ValueError, OSError, subprocess.TimeoutExpired) as error:
        proof['errors'].append(str(error))
    proof['exit_code'] = 1 if proof['errors'] else 0
    proof_path.write_text(json.dumps(proof, indent=2) + '\n')
    if proof['errors']:
        return 1
    pointer = root / 'artifacts/testing/compile-validation-latest.json'
    pointer.parent.mkdir(parents=True, exist_ok=True)
    temporary = pointer.with_suffix('.tmp')
    temporary.write_text(json.dumps({'proof': str(proof_path.relative_to(root)), 'sha256': hashlib.sha256(proof_path.read_bytes()).hexdigest()}, indent=2) + '\n')
    temporary.replace(pointer)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = (args.output or ROOT / 'artifacts/testing' / ('compile-validation-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT) or output.exists():
        parser.error('Choose a new output directory inside the repository')
    output.mkdir(parents=True)
    code = collect(ROOT, output, source_snapshot)
    print('Compile validation: ' + str(output))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
