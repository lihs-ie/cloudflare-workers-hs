"""Isolated CLI contracts; fake Node/c8 evidence is not example coverage."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / 'scripts/testing/example-node-coverage.py'
BOOTSTRAP = '''import importlib.util, pathlib, sys, types
root = pathlib.Path(sys.argv[2])
runner = types.ModuleType('run')
runner.source_snapshot = lambda: {'examples/minimal/test/integration/basic.spec.mjs': (root / 'source').read_text()}
sys.modules['run'] = runner
source = pathlib.Path(sys.argv[1])
sys.argv = [str(source), *sys.argv[3:]]
spec = importlib.util.spec_from_file_location('example_node_contract', source)
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
module.ROOT = root
raise SystemExit(module.main())
'''
FAKE = '''#!PYTHON
import json, os, pathlib, sys
root = pathlib.Path.cwd()
mode = os.environ.get('FIXTURE_MODE', '')
args = sys.argv[1:]
with (root / 'calls').open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
if '--config' in args:
    config = json.loads(pathlib.Path(args[args.index('--config') + 1]).read_text())
    if mode != 'missing-report':
        report = pathlib.Path(config['reports-dir'])
        report.mkdir()
        (report / 'coverage-final.json').write_text('{}')
    sys.exit(9 if mode == 'report-failure' else 0)
if mode != 'empty-raw':
    raw = pathlib.Path(os.environ['NODE_V8_COVERAGE'])
    (raw / ('fixture-' + str(os.getpid()) + '.json')).write_text('{"result":[]}')
if mode == 'source-change':
    (root / 'source').write_text('changed')
if (mode == 'model-failure' and args == ['scripts/testing/run.py', 'model']) or mode == 'test-failure' or (mode == 'tool-failure' and '--experimental-test-module-mocks' in args):
    sys.exit(7)
'''


class ExampleNodeCollectorTests(unittest.TestCase):
    def fixture(self, root):
        binary = root / 'bin'
        binary.mkdir()
        for name in ('node', 'pnpm', 'python3'):
            path = binary / name
            path.write_text(FAKE.replace('PYTHON', sys.executable, 1))
            path.chmod(0o755)
        (root / 'source').write_text('original')
        for example in ('minimal', 'static-assets', 'realtime', 'workflows', 'library-examples'):
            path = root / 'examples' / example / 'test/integration/basic.spec.mjs'
            path.parent.mkdir(parents=True)
            path.write_text('// synthetic fixture\n')
        quick = root / 'examples/quickstart/test/Support/Coverage/sample.spec.mjs'
        quick.parent.mkdir(parents=True)
        quick.write_text('// synthetic fixture\n')
        package = root / 'packages/worker-runtime/node_modules/c8/package.json'
        package.parent.mkdir(parents=True)
        package.write_text('{"version":"fixture-contract"}')

    def execute(self, root, mode='', arguments=()):
        env = dict(os.environ, PATH=str(root / 'bin') + os.pathsep + os.environ['PATH'], FIXTURE_MODE=mode)
        return subprocess.run([sys.executable, '-c', BOOTSTRAP, str(COLLECTOR), str(root), *arguments],
                              cwd=root, env=env, text=True, capture_output=True, timeout=30)

    def test_all_examples_and_tools_publish_matching_contract_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.fixture(root)
            result = self.execute(root, arguments=('--tools',))
            self.assertEqual(result.returncode, 0, result.stderr)
            pointer = json.loads((root / 'artifacts/testing/example-node-coverage-latest.json').read_text())
            proof = json.loads((root / pointer['proof']).read_text())
            self.assertEqual(proof['exit_code'], 0)
            self.assertEqual(proof['errors'], [])
            self.assertEqual(len(proof['commands']), 14)
            self.assertEqual(proof['commands'][5]['command'],
                             ['node', '--experimental-test-module-mocks', '--test',
                              'examples/library-examples/test/Support/Remote/ssec-probe-contract.spec.mjs'])
            self.assertEqual(proof['commands'][9]['command'], ['python3', 'scripts/testing/run.py', 'model'])
            self.assertEqual(proof['commands'][10]['command'], ['node', '--test', 'examples/quickstart/test/Support/Production/http-contract.spec.mjs',
                              'examples/quickstart/test/Support/Runtime/storage-bridge.spec.mjs',
                              'examples/quickstart/test/Support/Production/harness-contract.spec.mjs',
                              'examples/quickstart/test/Support/Runtime/harness-contract.spec.mjs'])
            self.assertEqual(proof['collector']['version'], 'fixture-contract')
            self.assertEqual(proof['sha256'], hashlib.sha256((root / pointer['report']).read_bytes()).hexdigest())
            output = (root / pointer['proof']).parent
            self.assertEqual(len(proof['raw']), 14)
            for name, digest in proof['raw'].items():
                self.assertEqual(digest, hashlib.sha256((output / name).read_bytes()).hexdigest())
            config = json.loads((output / 'c8.json').read_text())
            self.assertTrue(config['all'])
            self.assertEqual(config['exclude'], [])
            self.assertEqual(config['include'], proof['nodeSources'])
            self.assertEqual(proof['sources'], {'examples/minimal/test/integration/basic.spec.mjs': 'original'})

    def test_failures_never_replace_success_pointer_and_stop_test_work(self):
        for mode, error, count in (
            ('test-failure', 'Test command failed: minimal', 1),
            ('model-failure', 'Test command failed: quickstart', 4),
            ('tool-failure', 'Tool command failed (see tools-1.log): ' + json.dumps(['node', '--experimental-test-module-mocks', '--test', 'scripts/testing/Support/node-tools.spec.mjs', 'scripts/testing/Support/module-boundaries.spec.mjs']), 2),
            ('report-failure', 'c8 report failed', 1),
            ('missing-report', 'Missing report or raw Node evidence', 1),
            ('empty-raw', 'Missing report or raw Node evidence', 1),
            ('source-change', 'Source inputs changed during collection', 1),
        ):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                self.fixture(root)
                output = root / 'artifacts/testing/failure'
                output.parent.mkdir(parents=True)
                pointer = output.parent / 'example-node-coverage-latest.json'
                pointer.write_text('previous-success')
                arguments = ['--output', str(output), '--example', 'quickstart' if mode == 'model-failure' else 'minimal']
                if mode in ('tool-failure', 'test-failure', 'model-failure'):
                    arguments.append('--tools')
                result = self.execute(root, mode, arguments)
                self.assertEqual(result.returncode, 1, result.stderr)
                proof = json.loads((output / 'proof.json').read_text())
                self.assertEqual(proof['errors'], [error])
                self.assertEqual(proof['exit_code'], 1)
                self.assertEqual(len(proof['commands']), count)
                self.assertEqual(pointer.read_text(), 'previous-success')
                self.assertEqual(proof['sha256'] is None, mode == 'missing-report')

    def test_output_guards_and_missing_integration_fail_before_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.fixture(root)
            existing = root / 'artifacts/testing/existing'
            existing.mkdir(parents=True)
            for output in (root / 'outside', existing):
                result = self.execute(root, arguments=('--output', str(output)))
                self.assertEqual(result.returncode, 2)
                self.assertIn('Choose a new output directory', result.stderr)
            (root / 'examples/minimal/test/integration/basic.spec.mjs').unlink()
            result = self.execute(root, arguments=('--example', 'minimal'))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('No integration tests for minimal', result.stderr)
            self.assertFalse((root / 'calls').exists())

    def test_public_help_does_not_collect(self):
        result = subprocess.run([sys.executable, str(COLLECTOR), '--help'],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--example', result.stdout)
        self.assertIn('--tools', result.stdout)

    def test_source_partition_excludes_workers_and_declarations(self):
        runner = type(sys)('run')
        runner.source_snapshot = lambda: {}
        with patch.dict(sys.modules, {'run': runner}):
            spec = importlib.util.spec_from_file_location('example_node_collector_contract', COLLECTOR)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        included = [
            'examples/a/test/a.mjs', 'examples/a/test/b.mts',
            'scripts/testing/pack-consumer.mjs', 'scripts/testing/typecheck.mjs',
            'scripts/testing/Support/node-tools.spec.mjs', 'examples/static-assets/public/app.js',
            'examples/library-examples/test/Support/Remote/ssec-evidence.ts',
            'examples/library-examples/test/Support/Remote/ssec-probe.ts',
            'examples/library-examples/test/Support/Remote/cleanup-probe.ts',
            'examples/quickstart/test/Support/Dev/gateway.ts',
            'scripts/testing/Support/workerd_js_runtime.spec.mjs',
            'scripts/testing/Support/readiness.mjs',
            'scripts/testing/Support/readiness.spec.mjs',
        ]
        included.extend(['scripts/testing/Support/build-manifest-contract.spec.mjs',
                         'scripts/testing/Support/dev-lifecycle-contract.spec.mjs'])
        excluded = ['examples/a/worker/a.mjs', 'examples/a/types.d.mts', 'other/a.mjs',
                    'examples/a/app.ts', 'scripts/testing/Support/workerd_js.txt']
        self.assertEqual(module.node_sources(included + excluded + list(module.NODE_CONTRACT_SOURCES)), sorted(included))

    def test_support_contracts_are_registered_with_module_mock_support(self):
        spec = importlib.util.spec_from_file_location('node_support_routes', COLLECTOR)
        module = importlib.util.module_from_spec(spec)
        runner = type(sys)('run')
        runner.source_snapshot = lambda: {}
        with patch.dict(sys.modules, {'run': runner}):
            spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            self.fixture(root)
            contract = root / 'examples/minimal/test/Support/sample-contracts.spec.mjs'
            contract.parent.mkdir(parents=True)
            contract.write_text('// registered contract')
            with patch.object(module, 'ROOT', root):
                commands = module.commands_for('minimal')
            self.assertEqual(commands[-1], ['node', '--experimental-test-module-mocks', '--test',
                                           'examples/minimal/test/Support/sample-contracts.spec.mjs'])

    def test_repository_contract_specs_all_have_a_standard_entrypoint(self):
        runner = type(sys)('run')
        runner.source_snapshot = lambda: {}
        with patch.dict(sys.modules, {'run': runner}):
            spec = importlib.util.spec_from_file_location('node_repository_routes', COLLECTOR)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        commands = [command for example in module.EXAMPLES for command in module.commands_for(example)]
        registered = {argument for command in commands for argument in command if argument.endswith('.spec.mjs')}
        expected = {
            str(path.relative_to(ROOT))
            for example in module.EXAMPLES
            for path in (ROOT / 'examples' / example / 'test/Support').glob('*contract*.spec.mjs')
        }
        expected.update({
            'examples/quickstart/test/Support/Production/http-contract.spec.mjs',
            'examples/quickstart/test/Support/Runtime/storage-bridge.spec.mjs',
            'examples/quickstart/test/Support/Production/harness-contract.spec.mjs',
            'examples/quickstart/test/Support/Runtime/harness-contract.spec.mjs',
        })
        self.assertTrue(expected)
        self.assertEqual(expected - registered, set())
        self.assertTrue(set(module.NODE_CONTRACT_SOURCES).isdisjoint(
            module.node_sources(module.NODE_CONTRACT_SOURCES)))
