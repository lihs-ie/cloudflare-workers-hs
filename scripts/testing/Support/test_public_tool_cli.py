"""Real isolated CLI contracts; compiler/Docker stand-ins are not runtime evidence."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
BOOTSTRAP = '''import importlib.util, pathlib, sys, types
source = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
sys.path.insert(0, str(source.parent))
runner = types.ModuleType('run')
runner.source_snapshot = lambda: {str(p.relative_to(root)): 'fixture' for p in root.rglob('*') if p.is_file() and p.suffix in ('.json', '.ts') and 'artifacts' not in p.parts}
sys.modules['run'] = runner
sys.argv = [str(source), *sys.argv[3:]]
spec = importlib.util.spec_from_file_location('isolated_public_cli', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.ROOT = root
raise SystemExit(module.main())
'''
FAKE = '''#!PYTHON
import json, os, pathlib, sys
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
args = sys.argv[1:]
with (root / 'calls').open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
mode = os.environ.get('FIXTURE_MODE', '')
if pathlib.Path(sys.argv[0]).name == 'docker':
    operation = args[0]
    if operation == 'build':
        pathlib.Path(args[args.index('--iidfile') + 1]).write_text('sha256:isolated')
    if operation == 'create':
        print('owned-fixture')
    sys.exit(7 if operation == mode else 0)
if '--listFiles' in args:
    print('compiler banner')
    print('/outside/irrelevant.ts')
    for path in (root / 'compiler-inputs').read_text().splitlines():
        print(root / path)
sys.exit(9 if mode == 'compile-failure' else 0)
'''


class PublicToolCliTests(unittest.TestCase):
    def execute(self, root, script, *args, mode=''):
        return subprocess.run([sys.executable, '-c', BOOTSTRAP, str(ROOT / 'scripts/testing' / script), str(root), *map(str, args)],
                              cwd=root, env={**os.environ, 'FIXTURE_ROOT': str(root), 'FIXTURE_MODE': mode, 'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH']},
                              text=True, capture_output=True, timeout=30)

    def test_direct_entrypoints_fail_before_external_side_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.binary(root, 'bin/docker')
            for script in ('registration.py', 'api-execution-evidence.py', 'compile-validation.py', 'dev-docker.py'):
                result = subprocess.run([sys.executable, str(ROOT / 'scripts/testing' / script), '--invalid-option'], cwd=root,
                                        env={**os.environ, 'FIXTURE_ROOT': str(root), 'FIXTURE_MODE': 'info', 'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH']},
                                        text=True, capture_output=True, timeout=30)
                self.assertNotEqual(result.returncode, 0, script)
                self.assertIn('returned non-zero exit status' if script == 'dev-docker.py' else 'usage:', result.stderr)

    def binary(self, root, relative):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(FAKE.replace('PYTHON', sys.executable, 1))
        path.chmod(0o755)

    def test_registration_cli_diagnostics_output_and_default_layers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layer = root / 'pkg/test/unit'
            layer.mkdir(parents=True)
            (layer / 'OneSpec.hs').write_text('import Data.List\nimport MissingCases\nimport OtherSpec\nspec = pure ()\n')
            (layer / 'OtherSpec.hs').write_text('spec = pure ()\n')
            (layer / 'one.spec.ts').write_text('import { value } from "external";\n')
            output = root / 'reports/registration.json'
            result = self.execute(root, 'registration.py', '--root', root, '--layer', 'pkg/test/unit', '--layer', 'pkg/test/unit', '--output', output)
            self.assertEqual(result.returncode, 1, result.stderr)
            report = json.loads(output.read_text())
            for expected in ('unresolved test module', 'imports another entry', 'duplicate test layer'):
                self.assertTrue(any(expected in error for error in report['errors']), report)
                self.assertIn(expected, result.stdout)
            (layer / 'OneSpec.hs').write_text('spec = pure ()\n')
            (root / 'pkg/pkg.cabal').write_text('other-modules: OneSpec OtherSpec')
            support = root / 'pkg/test/Support/subdirectory'
            support.mkdir(parents=True)
            (support / 'fixture.txt').write_text('not a registration file')
            result = self.execute(root, 'registration.py', '--root', root, '--layer', 'pkg/test/unit')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['errors'], [])
            empty = root / 'empty'
            empty.mkdir()
            result = self.execute(root, 'registration.py', '--root', root, '--layer', 'empty')
            self.assertIn('no test entrypoints', result.stdout)
            result = self.execute(root, 'registration.py', '--root', root)
            self.assertEqual(result.returncode, 1)
            self.assertIn('missing required test layer', result.stdout)

    def test_api_cli_hashes_inputs_and_rejects_unusable_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory = root / 'inventory.json'
            inventory.write_text(json.dumps({'source_sha256': {'A.hs': 'exact'}, 'rows': [{'source': 'A.hs', 'name': 'run'}]}))
            coverage = root / 'coverage.json'
            report = {'sources': [{'path': 'A.hs', 'sha256': 'exact'}], 'host_hpc': [{'sources': ['B.hs'], 'module': 'B', 'hash': 'wrong-module', 'bindings': [{'name': 'run', 'hits': 1}]}, {'sources': ['A.hs'], 'module': 'A', 'hash': '42', 'bindings': [{'name': 'other', 'hits': 1}, {'name': 'run', 'hits': 0}, {'name': 'run', 'hits': 2}]}]}
            coverage.write_text(json.dumps(report))
            output = root / 'output/evidence.json'
            result = self.execute(root, 'api-execution-evidence.py', '--inventory', inventory, '--coverage', coverage, '--output', output)
            self.assertEqual(result.returncode, 0, result.stderr)
            proof = json.loads(output.read_text())
            self.assertEqual(proof['summary'], {'candidates': 1, 'bindingEntriesObserved': 1})
            self.assertEqual(len(proof['rows'][0]['executed_evidence']), 1)
            self.assertEqual(proof['inputs'][str(coverage)], hashlib.sha256(coverage.read_bytes()).hexdigest())
            report['errors'] = ['incomplete collection']
            coverage.write_text(json.dumps(report))
            before = output.read_bytes()
            result = self.execute(root, 'api-execution-evidence.py', '--inventory', inventory, '--coverage', coverage, '--output', output)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), before)
            coverage.write_text('{broken')
            result = self.execute(root, 'api-execution-evidence.py', '--inventory', inventory, '--coverage', coverage, '--output', output)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), before)

    def test_compile_cli_proof_inputs_and_failure_pointer(self):
        for mode in ('success', 'missing-contract', 'missing-config', 'compile-failure', 'empty-validations', 'existing-output', 'outside-output'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                project = root / 'packages/worker-runtime'
                project.mkdir(parents=True)
                contract = 'packages/worker-runtime/contract.ts'
                (root / contract).write_text('export {};')
                (project / 'other.ts').write_text('export {};')
                if mode != 'missing-config':
                    (project / 'tsconfig.check.json').write_text('{}')
                manifest = root / 'scripts/testing/runtime-scope.json'
                manifest.parent.mkdir(parents=True)
                manifest.write_text(json.dumps({'validations': [] if mode == 'empty-validations' else [{'path': contract, 'kind': 'type-contract'}]}))
                (root / 'compiler-inputs').write_text('packages/worker-runtime/other.ts' if mode == 'missing-contract' else contract)
                self.binary(root, 'packages/worker-runtime/node_modules/.bin/tsc')
                output = root / 'artifacts/testing/result'
                pointer = root / 'artifacts/testing/compile-validation-latest.json'
                pointer.parent.mkdir(parents=True)
                pointer.write_text('prior-proof')
                if mode == 'existing-output':
                    output.mkdir()
                result = self.execute(root, 'compile-validation.py', '--output', '/outside/output' if mode == 'outside-output' else output, mode=mode)
                if mode == 'success':
                    self.assertEqual(result.returncode, 0, result.stderr)
                    proof = json.loads((output / 'proof.json').read_text())
                    self.assertEqual(proof['validated'], [{'path': contract, 'kind': 'type-contract', 'commandIndex': 0}])
                    self.assertEqual(proof['commands'][0]['inputs'], [contract])
                    self.assertEqual(json.loads(pointer.read_text())['sha256'], hashlib.sha256((output / 'proof.json').read_bytes()).hexdigest())
                else:
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertEqual(pointer.read_text(), 'prior-proof')

    def test_compile_snapshot_must_include_configuration_and_multiple_projects(self):
        spec = importlib.util.spec_from_file_location('public_cli_compile_contract', ROOT / 'scripts/testing/compile-validation.py')
        module = importlib.util.module_from_spec(spec)
        sys.path.insert(0, str(ROOT / 'scripts/testing'))
        try:
            spec.loader.exec_module(module)
        finally:
            sys.path.pop(0)
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            entries = []
            sources = {}
            for project in ('examples/minimal', 'packages/worker-runtime'):
                path = root / project
                path.mkdir(parents=True)
                config = path / ('tsconfig.json' if project.startswith('examples') else 'tsconfig.check.json')
                config.write_text('{}')
                contract = project + '/contract.ts'
                (root / contract).write_text('export {};')
                sources[contract] = 'fixture'
                sources[str(config.relative_to(root))] = 'fixture'
                entries.append({'path': contract, 'kind': 'type-contract'})
            manifest = root / 'scripts/testing/runtime-scope.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'validations': entries}))
            def execute(argv, **kwargs):
                return subprocess.CompletedProcess(argv, 0, str(kwargs['cwd'] / 'contract.ts') + '\n')
            for missing in (False, True):
                output = root / ('missing' if missing else 'complete')
                output.mkdir()
                snapshot = dict(sources)
                if missing:
                    del snapshot['examples/minimal/tsconfig.json']
                with patch.object(module.subprocess, 'run', side_effect=execute):
                    self.assertEqual(module.collect(root, output, lambda: snapshot), int(missing))
                proof = json.loads((output / 'proof.json').read_text())
                if missing:
                    self.assertIn('Compiler configuration missing', proof['errors'][0])
                else:
                    self.assertEqual(len(proof['validated']), 2)

    def test_docker_cli_cleanup_exit_and_argument_forwarding(self):
        for mode in ('success', 'info', 'build', 'create', 'start', 'cp', 'rm'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.binary(root, 'bin/docker')
                result = self.execute(root, 'dev-docker.py', 'minimal', '--fixture', mode=mode)
                calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()]
                self.assertEqual(result.returncode == 0, mode == 'success', result.stderr)
                reports = list((root / 'artifacts/testing/docker').glob('run-*.json'))
                if mode in ('info', 'build', 'create'):
                    self.assertEqual(reports, [])
                    self.assertNotIn('rm', [call[0] for call in calls])
                else:
                    self.assertEqual(calls[-1], ['rm', '--force', 'owned-fixture'])
                    self.assertIn(['create', 'sha256:isolated', 'minimal', '--fixture'], calls)
                    self.assertEqual(len(reports), 1)
                    report = json.loads(reports[0].read_text())
                    self.assertEqual(report['exitCode'], 7 if mode in ('start', 'cp') else 0)
                    self.assertEqual(report['artifactCopyExitCode'], 7 if mode == 'cp' else 0)
