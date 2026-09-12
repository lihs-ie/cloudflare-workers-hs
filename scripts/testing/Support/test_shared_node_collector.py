"""Isolated collector contracts; synthetic files never become production evidence."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts/testing'))
spec = importlib.util.spec_from_file_location('shared_node_collector', ROOT / 'scripts/testing/shared-node-coverage.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class SharedNodeCollectorTests(unittest.TestCase):
    def test_real_contract_registry_has_preload_and_no_worker_commands(self):
        commands = collector.contract_commands(ROOT)
        self.assertGreater(len(commands), 10)
        for command in commands:
            self.assertEqual(command[0:2], ['node', '--import'])
            self.assertIn('--experimental-test-module-mocks', command)
            self.assertTrue(command[-1].endswith('.spec.mjs'))
        self.assertIn('examples/quickstart/test/Support/Runtime/storage-bridge.spec.mjs', [c[-1] for c in commands])

    def test_failed_command_or_missing_raw_is_not_success(self):
        for failed in [False, True]:
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                output = root / 'out'
                def run(command, **kwargs):
                    kwargs['stdout'].write('isolated test output\n')
                    if 'workerd_js_report.mjs' in ' '.join(command):
                        (output / 'coverage-final.json').write_text('{}')
                    return type('Result', (), {'returncode': int(failed)})()
                with patch.object(collector, 'ROOT', root), patch.object(collector, 'source_snapshot', return_value={}), patch.object(collector, 'contract_commands', return_value=[['node', 'fixture.spec.mjs']]), patch.object(collector.subprocess, 'run', side_effect=run):
                    proof = collector.collect(output, {})
                self.assertEqual(proof['exit_code'], 1)
                self.assertIn('Missing shared instrumentation manifests or snapshots', proof['errors'])
                self.assertEqual(proof['commands'][0]['logSha256'], collector.digest(output / 'contract-0.log'))
                self.assertEqual(json.loads((output / 'proof.json').read_text()), proof)
                if failed:
                    self.assertIn('Node boundary command failed: fixture.spec.mjs', proof['errors'])


class SharedNodeCliTests(unittest.TestCase):
    def fixture_process(self, root, mode, calls):
        """Only the external Node boundary is replaced; Python writes its real proof."""
        import subprocess

        def execute(command, **options):
            calls.append(command)
            if command[-1] == 'fixture.spec.mjs':
                output = Path(options['env']['SHARED_JS_COVERAGE_DIRECTORY'])
                bundle = output / 'bundles/fixture'
                bundle.mkdir()
                (bundle / 'manifest.json').write_text('{}')
                (output / 'snapshots/fixture.json').write_text('{}')
                options['stdout'].write('one isolated contract passed\n')
                return subprocess.CompletedProcess(command, 4 if mode == 'node-failure' else 0)
            if 'workerd_js_report.mjs' in command[1]:
                output = Path(command[-1])
                (output / 'coverage-final.json').write_text('{}')
                options['stdout'].write('isolated report accepted\n')
                return subprocess.CompletedProcess(command, 0)
            self.assertIn('shared_js_report.mjs', command[1])
            if mode == 'merge-failure':
                return subprocess.CompletedProcess(command, 7)
            output = Path(command[-1])
            output.mkdir()
            (output / 'coverage-final.json').write_text('{}')
            (output / 'workerd-only.json').write_text('{}')
            (output / 'proof.json').write_text('{"isolated":true}')
            return subprocess.CompletedProcess(command, 0)
        return execute

    def test_successful_collection_requires_raw_and_detects_source_drift(self):
        for changed in [False, True]:
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                output = root / 'out'
                calls = []
                with patch.object(collector, 'ROOT', root), \
                        patch.object(collector, 'source_snapshot', return_value={'code.py': 'changed' if changed else 'current'}), \
                        patch.object(collector, 'contract_commands', return_value=[['node', 'fixture.spec.mjs']]), \
                        patch.object(collector.subprocess, 'run', side_effect=self.fixture_process(root, 'success', calls)):
                    proof = collector.collect(output, {'code.py': 'current'})
                self.assertEqual(proof['exit_code'], int(changed))
                self.assertEqual(proof['errors'], ['Sources changed during shared Node collection'] if changed else [])
                self.assertEqual(set(proof['manifests']), {'bundles/fixture/manifest.json'})
                self.assertEqual(set(proof['snapshots']), {'snapshots/fixture.json'})
                self.assertEqual(proof['sha256'], collector.digest(output / 'coverage-final.json'))
                self.assertEqual(len(calls), 2)

    def test_cli_output_guards_failure_pointer_preservation_and_success_publish(self):
        import contextlib
        import io
        for mode in ['explicit', 'default', 'existing', 'outside', 'node-failure', 'merge-failure']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                testing = root / 'artifacts/testing'
                testing.mkdir(parents=True)
                pointer = testing / 'shared-js-coverage-latest.json'
                pointer.write_text('prior successful pointer')
                output = root / 'outside' if mode == 'outside' else testing / 'fresh'
                if mode == 'existing':
                    output.mkdir()
                arguments = ['shared-node-coverage.py', '--workerd', str(root / 'workerd')]
                if mode != 'default':
                    arguments.extend(['--output', str(output)])
                calls = []
                with patch.object(collector, 'ROOT', root), patch.object(sys, 'argv', arguments), \
                        patch.object(collector, 'source_snapshot', return_value={'code.py': 'current'}), \
                        patch.object(collector, 'contract_commands', return_value=[['node', 'fixture.spec.mjs']]), \
                        patch.object(collector.subprocess, 'run', side_effect=self.fixture_process(root, mode, calls)), \
                        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    if mode in ['existing', 'outside']:
                        self.assertRaisesRegex(SystemExit, '2', collector.main)
                    else:
                        result = collector.main()
                        self.assertEqual(result, 1 if mode == 'node-failure' else 7 if mode == 'merge-failure' else 0)
                if mode in ['explicit', 'default']:
                    published = json.loads(pointer.read_text())
                    proof = root / published['proof']
                    self.assertEqual(published['proofSha256'], collector.digest(proof))
                    self.assertEqual(root / published['report'], proof.parent / 'coverage-final.json')
                    self.assertEqual(root / published['workerdOnly'], proof.parent / 'workerd-only.json')
                    self.assertEqual(calls[-1][-3], str(root / 'workerd'))
                else:
                    self.assertEqual(pointer.read_text(), 'prior successful pointer')
                    self.assertEqual(len(calls), 0 if mode in ['existing', 'outside'] else 2 if mode == 'node-failure' else 3)

    def test_direct_cli_help_and_missing_required_argument(self):
        import subprocess
        for arguments, success in [(['--help'], True), ([], False)]:
            with self.subTest(arguments=arguments):
                result = subprocess.run([sys.executable, collector.__file__, *arguments], capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0 if success else 2)
                self.assertIn('--workerd', result.stdout if success else result.stderr)


if __name__ == '__main__':
    unittest.main()
