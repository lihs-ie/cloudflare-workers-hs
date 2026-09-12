"""Runner routing and evidence trust contracts with isolated external executors."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('run_lane_contract', Path(__file__).parents[1] / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunLaneTests(unittest.TestCase):
    def run_lane(self, root, lane, args=(), failure=None, reports=True, drift=False, summaries=True):
        example = root / 'examples/quickstart'
        example.mkdir(parents=True, exist_ok=True)
        calls = []
        def execute(command, **kwargs):
            calls.append((command, kwargs))
            if failure == 'spawn':
                raise FileNotFoundError('isolated missing executable')
            if reports:
                for name in ('runtime', 'production'):
                    report = example / ('test-artifacts/coverage/' + name + '/coverage-final.json')
                    report.parent.mkdir(parents=True, exist_ok=True)
                    report.write_text('{}')
            count = sum(':test:' in item for item in command)
            child = Mock(stdout=iter(['Passed: 1\nFailed: 0\n'] * count if summaries else ['empty suite\n']))
            child.wait.return_value = 8 if len(calls) - 1 == failure else 0
            return child
        snapshots = iter([{'source': 'before'}] + [{'source': 'after' if drift else 'before'}] * 6)
        with patch.object(runner, 'ROOT', root), patch.object(runner, 'EXAMPLE', example), patch.object(runner, 'source_snapshot', side_effect=lambda: next(snapshots)), patch.object(runner.sys, 'argv', ['run.py', lane, '--seed', '19', '--examples', '3', *args]), patch.object(runner.subprocess, 'Popen', side_effect=execute), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            code = runner.main()
        evidence = json.loads(next((root / 'artifacts/testing').rglob('run.json')).read_text())
        self.assertEqual(evidence['seed'], 19)
        self.assertEqual(evidence['examples'], 3)
        self.assertEqual(calls[0][1]['env']['SYDTEST_RETRIES'], '0')
        self.assertEqual(calls[0][1]['env']['SYDTEST_MAX_SUCCESS'], '3')
        return code, [item[0] for item in calls], evidence

    def test_host_conformance_replay_match_summary_and_spawn_contracts(self):
        for lane in ('host', 'conformance', 'replay'):
            for mode in ('success', 'empty', 'failure', 'spawn'):
                with self.subTest(lane=lane, mode=mode), tempfile.TemporaryDirectory() as directory:
                    args = ['--match', 'name with spaces']
                    if lane == 'replay':
                        args += ['--target', 'quickstart:test:unit']
                    code, commands, evidence = self.run_lane(Path(directory), lane, args, failure='spawn' if mode == 'spawn' else 0 if mode == 'failure' else None, summaries=mode != 'empty')
                    self.assertEqual(code, {'success': 0, 'empty': 1, 'failure': 8, 'spawn': 127}[mode])
                    self.assertIn("--test-options=--match 'name with spaces'", commands[0])
                    self.assertEqual(evidence['commands'][0]['exit_code'], 0 if mode == 'empty' else code)

    def test_integration_proof_requires_success_report_and_stable_source(self):
        for failure, reports, drift in [(None, True, False), (0, True, False), (1, True, False), (2, True, False), (3, True, False), (None, False, False), (None, True, True)]:
            with self.subTest(failure=failure, reports=reports, drift=drift), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                code, commands, _ = self.run_lane(root, 'integration', failure=failure, reports=reports, drift=drift)
                self.assertEqual(code, 8 if failure is not None else 1 if drift else 0)
                runtime = root / 'examples/quickstart/test-artifacts/coverage/runtime/run-proof.json'
                production = root / 'examples/quickstart/test-artifacts/coverage/production/run-proof.json'
                self.assertEqual(runtime.exists(), reports and not drift and failure not in (0, 1))
                self.assertEqual(production.exists(), reports and not drift and failure not in (0, 2, 3))
                if runtime.exists():
                    proof = json.loads(runtime.read_text())
                    self.assertEqual(proof['sha256'], hashlib.sha256(b'{}').hexdigest())
                if drift:
                    self.assertEqual(json.loads(next((root / 'artifacts').rglob('changed-inputs.json')).read_text()), ['source'])
                self.assertEqual(commands[0], ['pnpm', 'run', 'build:runtime'])

    def test_model_build_stops_before_cabal_on_failure(self):
        for failure in (None, 0, 1, 2):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                code, commands, _ = self.run_lane(Path(directory), 'model', failure=failure)
                self.assertEqual(code, 0 if failure is None else 8)
                self.assertEqual(len(commands), 3 if failure is None else failure + 1)
                if failure is None:
                    self.assertIn('quickstart:test:model', commands[-1])

    def test_empty_example_never_starts_unbounded_node_discovery(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'No integration tests'):
                self.run_lane(Path(directory), 'minimal')

    def test_cli_rejects_invalid_counts_and_missing_replay_target(self):
        for args in (['host', '--examples', '0'], ['replay'], ['unknown']):
            result = subprocess.run([sys.executable, str(Path(runner.__file__)), *args], text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 2)
            self.assertIn('error:', result.stderr)

    def test_hpc_and_native_evidence_reject_missing_logs_extra_mix_and_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'artifacts/testing/native'
            (output / 'mix').mkdir(parents=True)
            for name in ('sample.tix', 'mix/sample.mix', 'command.log'):
                (output / name).write_text(name)
            digest = lambda name: hashlib.sha256((output / name).read_bytes()).hexdigest()
            valid = {'sources': {'A.hs': 'source'}, 'errors': [], 'exit_code': 0, 'commands': [{'exitCode': 0, 'log': 'command.log', 'logSha256': digest('command.log')}], 'snapshots': {'sample.tix': digest('sample.tix')}, 'mixFiles': {'mix/sample.mix': digest('mix/sample.mix')}}
            proof = output / 'proof.json'
            pointer = output.parent / 'native-tools-coverage-latest.json'
            self.assertEqual(runner.native_coverage_arguments(root, valid['sources']), [])
            for changes in ({}, {'exit_code': True}, {'commands': []}, {'commands': [{'exitCode': False}]}, {'errors': ['failed']}, {'sources': {}}, {'snapshots': {}}, {'mixFiles': {}}, {'snapshots': {'../escape.tix': 'bad'}}, {'commands': [{'exitCode': 0, 'log': '../escape.log', 'logSha256': 'bad'}]}):
                proof.write_text(json.dumps({**valid, **changes}))
                args = runner.verified_hpc_arguments(root, proof, valid['sources'])
                self.assertEqual(bool(args), not changes, changes)
            proof.write_text(json.dumps(valid))
            pointer.write_text(json.dumps({'proof': str(proof.relative_to(root)), 'sha256': digest('proof.json')}))
            self.assertIn('--tix', runner.native_coverage_arguments(root, valid['sources']))
            (output / 'mix/extra.mix').write_text('unlisted')
            self.assertEqual(runner.native_coverage_arguments(root, valid['sources']), [])
            proof.write_text('{}')
            self.assertEqual(runner.native_coverage_arguments(root, valid['sources']), [])
            self.assertEqual(runner.verified_hpc_arguments(root, root.parent / 'outside', {}), [])
            proof.write_text('null')
            self.assertEqual(runner.verified_hpc_arguments(root, proof, {}), [])

    def test_workerd_snapshots_manifests_are_part_of_trusted_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'artifacts/testing/js'
            output.mkdir(parents=True)
            report = output / 'coverage.json'
            report.write_text('{}')
            (output / 'snapshot').write_text('snapshot')
            (output / 'manifest').write_text('manifest')
            proof = output / 'proof.json'
            pointer = output.parent / 'workerd-js-coverage-latest.json'
            self.assertEqual(runner.workerd_javascript_coverage_arguments(root, {}), [])
            pointer.write_text(json.dumps({'report': str(report.relative_to(root)), 'proof': str(proof.relative_to(root))}))
            valid = {'sources': {}, 'exit_code': 0, 'sha256': hashlib.sha256(b'{}').hexdigest(), 'errors': [], 'commands': [{'exitCode': 0}], 'snapshots': {'snapshot': hashlib.sha256(b'snapshot').hexdigest()}, 'manifests': {'manifest': hashlib.sha256(b'manifest').hexdigest()}}
            for changes in ({}, {'errors': ['failed']}, {'commands': []}, {'commands': [{'exitCode': 1}]}, {'snapshots': {}}, {'manifests': {}}, {'snapshots': {'../escape': 'bad'}}, {'manifests': {'missing': 'bad'}}):
                proof.write_text(json.dumps({**valid, **changes}))
                self.assertEqual(bool(runner.workerd_javascript_coverage_arguments(root, {})), not changes, changes)

    def test_coverage_lane_forwards_only_verified_inputs_and_requested_options(self):
        import types
        for mode in ('valid', 'host-failure', 'stale-js', 'no-js', 'model-failure', 'plain'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                example = root / 'examples/quickstart'
                example.mkdir(parents=True)
                javascript = example / 'test-artifacts/coverage/runtime/coverage-final.json'
                if mode != 'no-js':
                    javascript.parent.mkdir(parents=True)
                    javascript.write_text('{}')
                    javascript.with_name('run-proof.json').write_text(json.dumps({'sources': {} if mode == 'stale-js' else {'source': 'before'}, 'exit_code': 0, 'sha256': hashlib.sha256(b'{}').hexdigest()}))
                seen = []
                def collect(repo, output, targets, snapshot, **kwargs):
                    seen.extend(targets)
                    (output / 'mix').mkdir(parents=True)
                    for name in ('one.tix', 'mix/one.mix', 'command.log'):
                        (output / name).write_text('fixture')
                    digest = hashlib.sha256(b'fixture').hexdigest()
                    proof = {'sources': snapshot(), 'exit_code': 1 if mode == 'host-failure' else 0, 'errors': [], 'commands': [{'exitCode': 0, 'log': 'command.log', 'logSha256': digest}], 'snapshots': {'one.tix': digest}, 'mixFiles': {'mix/one.mix': digest}}
                    (output / 'proof.json').write_text(json.dumps(proof))
                    return proof
                module = types.ModuleType('Support.host_coverage')
                module.collect = collect
                with patch.dict(sys.modules, {'Support.host_coverage': module}), patch.object(runner.sys, 'platform', 'linux'):
                    code, commands, _ = self.run_lane(root, 'coverage', [] if mode == 'plain' else ['--report-only', '--compile-proof', str(root / 'compile.json'), '--native-compile-proof', str(root / 'native.json'), '--shell-json', str(root / 'shell.json')], reports=False, failure=0 if mode == 'model-failure' else None)
                self.assertEqual(code, 8 if mode == 'model-failure' else 1 if mode == 'host-failure' else 0)
                merged = commands[-1]
                for flag in ('--report-only', '--compile-proof', '--native-compile-proof', '--shell-json'):
                    self.assertEqual(flag in merged, mode != 'plain')
                self.assertEqual('--host-proof' in merged, mode != 'host-failure')
                self.assertEqual('--istanbul' in merged, mode not in ('stale-js', 'no-js'))
                self.assertEqual('quickstart:test:model' in seen, mode != 'model-failure')

    def test_wasm_and_python_pointer_escape_empty_evidence_and_malformed_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'artifacts/testing/probe'
            output.mkdir(parents=True)
            pointer = output.parent / 'wasm-coverage-latest.json'
            proof = output / 'proof.json'
            pointer.write_text(json.dumps({'proof': '../outside'}))
            self.assertEqual(runner.wasm_coverage_arguments(root, {}), [])
            pointer.write_text(json.dumps({'proof': str(proof.relative_to(root))}))
            for changes in ({'snapshots': {}}, {'mixFiles': {}}, {'commands': []}, {'commands': [{'exitCode': 1}]}, {'errors': ['failed']}):
                proof.write_text(json.dumps({'sources': {}, 'commands': [{'exitCode': 0}], 'errors': [], 'snapshots': {'one.tix': 'fixture'}, 'mixFiles': {'mix/one.mix': 'fixture'}, **changes}))
                self.assertEqual(runner.wasm_coverage_arguments(root, {}), [])
            pointer = output.parent / 'python-coverage-latest.json'
            pointer.write_text(json.dumps({'report': '../outside', 'proof': str(proof.relative_to(root))}))
            self.assertEqual(runner.python_coverage_arguments(root, {}), [])
            pointer.write_text('broken JSON')
            self.assertEqual(runner.python_coverage_arguments(root, {}), [])
