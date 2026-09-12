import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('testing_run', Path(__file__).parents[1] / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunEvidenceTests(unittest.TestCase):
    def test_runner_requires_one_nonempty_success_per_target(self):
        success = '  Passed: 2\n  Failed: 0\n'
        self.assertTrue(runner.successful_summaries(success * 2, 2))
        for log in ['', success, success * 3, success + 'Passed: 0\nFailed: 0\n', success + 'Passed: 1\nFailed: 1\n']:
            self.assertFalse(runner.successful_summaries(log, 2))

    def test_javascript_proof_rejects_modified_source_report_and_failed_run(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / 'coverage.json'
            proof_file = Path(directory) / 'proof.json'
            report.write_text('{}')
            sources = {'source.cts': 'first'}
            proof = {'sources': sources, 'exit_code': 0, 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()}
            proof_file.write_text(json.dumps(proof))
            self.assertTrue(runner.valid_javascript_proof(report, proof_file, sources))
            self.assertFalse(runner.valid_javascript_proof(report, proof_file, {'source.cts': 'second'}))
            report.write_text('{"stale":true}')
            self.assertFalse(runner.valid_javascript_proof(report, proof_file, sources))
            report.write_text('{}')
            proof['exit_code'] = 1
            proof_file.write_text(json.dumps(proof))
            self.assertFalse(runner.valid_javascript_proof(report, proof_file, sources))
            proof_file.write_text('null')
            self.assertFalse(runner.valid_javascript_proof(report, proof_file, sources))

    def test_process_lanes_require_successful_builds_and_preserve_failure(self):
        import io
        from contextlib import redirect_stdout, redirect_stderr
        from unittest.mock import Mock
        lane_commands = {
            'dev': [['bash', 'scripts/build-wasm.sh', 'runtime-tests'], ['bash', 'scripts/build-wasm.sh'], ['pnpm', 'run', 'test:dev']],
            'docker': [['bash', 'scripts/build-wasm.sh', 'runtime-tests'], ['bash', 'scripts/build-wasm.sh'],
                       ['node', 'scripts/testing/typecheck.mjs', 'quickstart'],
                       ['bash', 'examples/library-examples/scripts/build.sh'],
                       ['node', 'scripts/testing/typecheck.mjs', 'library-examples'],
                       ['bash', 'examples/minimal/scripts/build.sh'],
                       ['node', 'scripts/testing/typecheck.mjs', 'minimal'],
                       ['bash', 'examples/static-assets/scripts/build.sh'],
                       ['node', 'scripts/testing/typecheck.mjs', 'static-assets'],
                       ['bash', 'examples/realtime/scripts/build.sh'],
                       ['node', 'scripts/testing/typecheck.mjs', 'realtime'],
                       ['bash', 'examples/workflows/scripts/build.sh'],
                       ['node', 'scripts/testing/typecheck.mjs', 'workflows'],
                       ['pnpm', 'run', 'test:docker']],
            'library-examples': [['bash', 'examples/library-examples/scripts/build.sh'],
                                 ['node', 'scripts/testing/typecheck.mjs', 'library-examples'],
                                 ['node', '--test', '--test-concurrency=1', 'examples/library-examples/test/integration/library.spec.mjs']],
            'minimal': [['bash', 'examples/minimal/scripts/build.sh'],
                        ['node', 'scripts/testing/typecheck.mjs', 'minimal'],
                        ['node', '--test', '--test-concurrency=1', 'examples/minimal/test/integration/http.spec.mjs']],
        }
        for name in ['static-assets', 'realtime', 'workflows']:
            lane_commands[name] = [['bash', 'examples/' + name + '/scripts/build.sh'],
                ['node', 'scripts/testing/typecheck.mjs', name],
                ['node', '--test', '--test-concurrency=1', 'examples/' + name + '/test/integration/http.spec.mjs']]
        for lane, expected in lane_commands.items():
            for failing_step in range(len(expected)):
                with self.subTest(lane=lane, failing_step=failing_step), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    example = root / 'examples/quickstart'
                    example.mkdir(parents=True)
                    for name, filename in [('library-examples', 'library'), ('minimal', 'http'), ('static-assets', 'http'), ('realtime', 'http'), ('workflows', 'http')]:
                        tests = root / 'examples' / name / 'test/integration'
                        tests.mkdir(parents=True)
                        (tests / (filename + '.spec.mjs')).write_text('')
                    children = []
                    for step in range(failing_step + 1):
                        child = Mock(stdout=iter([]))
                        child.wait.return_value = 7 if step == failing_step else 0
                        children.append(child)
                    with patch.object(runner, 'ROOT', root), patch.object(runner, 'EXAMPLE', example), \
                         patch.object(runner, 'source_snapshot', return_value={}), \
                         patch.object(runner.sys, 'argv', ['run.py', lane]), \
                         patch.object(runner.subprocess, 'Popen', side_effect=children) as process, \
                         redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                        self.assertEqual(runner.main(), 7)
                    commands = [call.args[0] for call in process.call_args_list]
                    self.assertEqual(commands, expected[:failing_step + 1])
                    evidence = json.loads(next((root / 'artifacts/testing').rglob('run.json')).read_text())
                    self.assertEqual(evidence['commands'][-1]['exit_code'], 7)

    def test_wasm_evidence_requires_current_sources_and_untampered_counters(self):
        import hashlib
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'artifacts/testing/probe'
            (output / 'mix').mkdir(parents=True)
            (output / 'one.tix').write_text('counters')
            (output / 'mix/one.mix').write_text('positions')
            proof = {'sources': {'A.hs': 'current'}, 'errors': [], 'commands': [{'exitCode': 0}],
                     'snapshots': {'one.tix': hashlib.sha256(b'counters').hexdigest()},
                     'mixFiles': {'mix/one.mix': hashlib.sha256(b'positions').hexdigest()}}
            (output / 'proof.json').write_text(json.dumps(proof))
            (root / 'artifacts/testing/wasm-coverage-latest.json').write_text(json.dumps({'proof': 'artifacts/testing/probe/proof.json'}))
            self.assertIn('--wasm-tix', runner.wasm_coverage_arguments(root, proof['sources']))
            self.assertEqual(runner.wasm_coverage_arguments(root, {'A.hs': 'old'}), [])
            for code in [False, True, '0', None, 1]:
                invalid = proof | {'commands': [{'exitCode': code}]}
                (output / 'proof.json').write_text(json.dumps(invalid))
                self.assertEqual(runner.wasm_coverage_arguments(root, proof['sources']), [], code)
            (output / 'proof.json').write_text(json.dumps(proof))
            (output / 'one.tix').write_text('tampered')
            self.assertEqual(runner.wasm_coverage_arguments(root, proof['sources']), [])

    def test_python_proof_rejects_stale_and_tampered_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'artifacts/testing/python'
            output.mkdir(parents=True)
            report = output / 'python.json'
            report.write_text('{}')
            sources = {'code.py': 'current'}
            (output / 'proof.json').write_text(json.dumps({'sources': sources, 'exit_code': 0, 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()}))
            (output.parent / 'python-coverage-latest.json').write_text(json.dumps({'report': 'artifacts/testing/python/python.json', 'proof': 'artifacts/testing/python/proof.json'}))
            self.assertIn('--python-json', runner.python_coverage_arguments(root, sources))
            for code in [False, True, '0', None, 1]:
                (output / 'proof.json').write_text(json.dumps({'sources': sources, 'exit_code': code, 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()}))
                self.assertEqual(runner.python_coverage_arguments(root, sources), [], code)
            (output / 'proof.json').write_text(json.dumps({'sources': sources, 'exit_code': 0, 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()}))
            self.assertEqual(runner.python_coverage_arguments(root, {'code.py': 'stale'}), [])
            report.write_text('{"tampered": true}')
            self.assertEqual(runner.python_coverage_arguments(root, sources), [])

    def test_snapshot_covers_new_extensions_and_binary_fixtures(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ['entry.cts', 'view.tsx', 'script.cjs', 'code.lhs', 'flake.nix', 'fixture.bin']
            for name in names:
                (root / name).write_bytes(b'first')
            with patch.object(runner, 'ROOT', root), patch.object(runner.subprocess, 'check_output', return_value=('\0'.join(names) + '\0').encode()):
                initial = runner.source_snapshot()
                self.assertEqual(set(initial), set(names))
                (root / 'fixture.bin').write_bytes(b'second')
                self.assertNotEqual(initial, runner.source_snapshot())

    def test_npm_pointer_requires_matching_successful_proof_inside_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / 'artifacts/testing'
            output.mkdir(parents=True)
            pointer = output / 'npm-coverage-latest.json'
            report = output / 'coverage.json'
            proof = output / 'proof.json'
            sources = {'source.ts': 'current'}
            self.assertEqual(runner.npm_coverage_arguments(root, sources), [])
            report.write_text('{}')
            valid = {'sources': sources, 'exit_code': 0, 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()}
            pointer.write_text(json.dumps({'report': str(report.relative_to(root)), 'proof': str(proof.relative_to(root))}))
            proof.write_text(json.dumps(valid))
            self.assertEqual(runner.npm_coverage_arguments(root, sources), ['--istanbul', str(report.resolve())])
            for patch in [{'sources': {}}, {'exit_code': 1}, {'sha256': 'tampered'}]:
                proof.write_text(json.dumps(dict(valid, **patch)))
                self.assertEqual(runner.npm_coverage_arguments(root, sources), [])
            pointer.write_text(json.dumps({'report': '../outside', 'proof': str(proof.relative_to(root))}))
            self.assertEqual(runner.npm_coverage_arguments(root, sources), [])
            pointer.write_text('not JSON')
            self.assertEqual(runner.npm_coverage_arguments(root, sources), [])

    def test_example_node_and_production_require_separate_matching_proofs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            example = root / 'examples/quickstart'
            report = example / 'test-artifacts/coverage/production/coverage-final.json'
            report.parent.mkdir(parents=True)
            report.write_text('{}')
            sources = {'worker.ts': 'current'}
            proof = report.with_name('run-proof.json')
            self.assertEqual(runner.production_coverage_arguments(example, sources), [])
            proof.write_text(json.dumps({'sources': sources, 'exit_code': 0, 'sha256': hashlib.sha256(report.read_bytes()).hexdigest()}))
            self.assertEqual(runner.production_coverage_arguments(example, sources), ['--istanbul', str(report)])
            self.assertEqual(runner.production_coverage_arguments(example, {}), [])
            pointer = root / 'artifacts/testing/example-node-coverage-latest.json'
            pointer.parent.mkdir(parents=True)
            self.assertEqual(runner.example_node_coverage_arguments(root, sources), [])
            pointer.write_text(json.dumps({'report': str(report.relative_to(root)), 'proof': str(proof.relative_to(root))}))
            self.assertEqual(runner.example_node_coverage_arguments(root, sources), ['--istanbul', str(report)])
            self.assertEqual(runner.npm_coverage_arguments(root, sources), [])
            report.write_text('{"tampered": true}')
            self.assertEqual(runner.example_node_coverage_arguments(root, sources), [])
            self.assertEqual(runner.production_coverage_arguments(example, sources), [])


if __name__ == '__main__':
    unittest.main()
