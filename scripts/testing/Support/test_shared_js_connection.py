"""Reject damaged combined evidence and keep workerd-only metrics independent."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
from Support import coverage_evidence as evidence
spec = importlib.util.spec_from_file_location('shared_runner', Path(__file__).parents[1] / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class SharedConnectionTests(unittest.TestCase):
    def fixture(self, root):
        output = root / 'artifacts/testing/combined'
        output.mkdir(parents=True)
        report = output / 'coverage-final.json'
        workerd = output / 'workerd-only.json'
        for path in [report, workerd]:
            path.write_text('{}')
        proof = output / 'proof.json'
        content = {'sources': {'source.ts': 'current'}, 'exit_code': 0, 'errors': [], 'inputs': [],
                   'sha256': hashlib.sha256(report.read_bytes()).hexdigest(),
                   'workerdOnlySha256': hashlib.sha256(workerd.read_bytes()).hexdigest()}
        proof.write_text(json.dumps(content))
        pointer = output.parent / 'shared-js-coverage-latest.json'
        pointer.write_text(json.dumps({'report': str(report.relative_to(root)), 'proof': str(proof.relative_to(root)),
            'workerdOnly': str(workerd.relative_to(root)), 'proofSha256': hashlib.sha256(proof.read_bytes()).hexdigest()}))
        response = type('Result', (), {'returncode': 0, 'stdout': json.dumps({key: content[key] for key in ['sources', 'sha256', 'workerdOnlySha256', 'inputs']}), 'stderr': ''})()
        return proof, pointer, content, response

    def test_external_proof_is_rejected_before_verifier(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            root = Path(temporary).resolve()
            proof = Path(outside) / 'proof.json'
            proof.write_text('{}')
            link = root / 'proof-link.json'
            link.symlink_to(proof)
            with patch.object(evidence.subprocess, 'run') as verifier:
                for candidate in [proof, link]:
                    with self.subTest(candidate=candidate), self.assertRaisesRegex(ValueError, 'proof escapes repository'):
                        evidence.validated_shared_javascript(root, candidate, {})
                verifier.assert_not_called()

    def test_pointer_escape_falls_back_without_verification(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryDirectory() as outside:
            root = Path(temporary).resolve()
            _, pointer, content, _ = self.fixture(root)
            original = json.loads(pointer.read_text())
            with patch.object(evidence.subprocess, 'run') as verifier, patch.object(runner, 'workerd_javascript_coverage_arguments', return_value=['--istanbul', 'workerd.json']) as fallback:
                for key in ['report', 'proof', 'workerdOnly']:
                    with self.subTest(key=key):
                        pointer.write_text(json.dumps(dict(original, **{key: str(Path(outside) / 'outside.json')})))
                        self.assertEqual(runner.shared_javascript_coverage_arguments(root, content['sources']), ['--istanbul', 'workerd.json', '--workerd-only', 'workerd.json'])
                verifier.assert_not_called()
                self.assertEqual(fallback.call_count, 3)

    def test_pointer_report_mismatch_rejects_even_valid_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            _, pointer, content, response = self.fixture(root)
            original = json.loads(pointer.read_text())
            alternate = root / 'alternate.json'
            alternate.write_text('{}')
            with patch.object(evidence.subprocess, 'run', return_value=response) as verifier, patch.object(runner, 'workerd_javascript_coverage_arguments', return_value=['--istanbul', 'workerd.json']) as fallback:
                for key in ['report', 'workerdOnly']:
                    with self.subTest(key=key):
                        pointer.write_text(json.dumps(dict(original, **{key: 'alternate.json'})))
                        self.assertEqual(runner.shared_javascript_coverage_arguments(root, content['sources']), ['--istanbul', 'workerd.json', '--workerd-only', 'workerd.json'])
                self.assertEqual(verifier.call_count, 2)
                self.assertEqual(fallback.call_count, 2)

    def test_workerd_report_rejects_existing_non_javascript_source(self):
        import contextlib
        import io
        import subprocess
        spec = importlib.util.spec_from_file_location('shared_report_non_js', Path(__file__).parents[1] / 'coverage.py')
        reporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reporter)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
            source = root / 'notes.txt'
            source.write_text('not JavaScript')
            workerd = root / 'workerd.json'
            workerd.write_text(json.dumps({str(source): {'path': str(source),
                'statementMap': {'0': {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 14}}},
                's': {'0': 1}, 'branchMap': {}, 'b': {}, 'fnMap': {}, 'f': {}}}))
            self.assertIn('notes.txt', evidence.javascript_evidence(root, [workerd]))
            output = root / 'report.json'
            with patch.object(sys, 'argv', ['coverage.py', '--root', str(root), '--output', str(output), '--workerd-only', str(workerd)]), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(reporter.main(), 1)
            result = json.loads(output.read_text())
            self.assertEqual(result['errors'], ['Workerd-only report contains sources absent from inventory'])
            self.assertFalse(result['runtime_complete'])
            self.assertFalse(result['complete'])

    def test_verified_shared_replaces_workerd_and_bad_proof_falls_back(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            proof, pointer, content, response = self.fixture(root)
            with patch.object(evidence.subprocess, 'run', return_value=response), patch.object(runner, 'workerd_javascript_coverage_arguments', return_value=['--istanbul', 'workerd.json']) as fallback:
                self.assertEqual(runner.shared_javascript_coverage_arguments(root, content['sources']), ['--shared-js-proof', str(proof)])
                fallback.assert_not_called()
                for changed in [dict(content, exit_code=False), dict(content, exit_code=1), dict(content, errors=['failure']), dict(content, sources={})]:
                    proof.write_text(json.dumps(changed))
                    data = json.loads(pointer.read_text())
                    data['proofSha256'] = hashlib.sha256(proof.read_bytes()).hexdigest()
                    pointer.write_text(json.dumps(data))
                    self.assertEqual(runner.shared_javascript_coverage_arguments(root, content['sources']), ['--istanbul', 'workerd.json', '--workerd-only', 'workerd.json'])

    def test_missing_pointer_and_tampered_hash_never_accept_combined(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.object(runner, 'workerd_javascript_coverage_arguments', return_value=[]):
                self.assertEqual(runner.shared_javascript_coverage_arguments(root, {}), [])
                proof, pointer, content, response = self.fixture(root)
                proof.write_text('{}')
                self.assertEqual(runner.shared_javascript_coverage_arguments(root, content['sources']), [])

    def test_verifier_failure_response_and_report_mutation_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            proof, _, content, response = self.fixture(root)
            for result in [type('Result', (), {'returncode': 1, 'stderr': 'raw changed'})(), type('Result', (), {'returncode': 0, 'stdout': '{}'})()]:
                with patch.object(evidence.subprocess, 'run', return_value=result), self.assertRaises(ValueError):
                    evidence.validated_shared_javascript(root, proof, content['sources'])
            (proof.parent / 'workerd-only.json').write_text('changed')
            with patch.object(evidence.subprocess, 'run', return_value=response), self.assertRaisesRegex(ValueError, 'report changed'):
                evidence.validated_shared_javascript(root, proof, content['sources'])

    def test_report_keeps_combined_and_workerd_metrics_separate(self):
        import contextlib
        import io
        import subprocess
        spec = importlib.util.spec_from_file_location('shared_report', Path(__file__).parents[1] / 'coverage.py')
        reporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reporter)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True)
            source = root / 'worker.ts'
            source.write_text('export const value = 1;')
            def payload(hit):
                return {str(source): {'path': str(source), 'statementMap': {'0': {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 23}}}, 's': {'0': hit}, 'branchMap': {}, 'b': {}, 'fnMap': {}, 'f': {}}}
            combined, workerd = root / 'combined.json', root / 'workerd.json'
            combined.write_text(json.dumps(payload(1)))
            workerd.write_text(json.dumps(payload(0)))
            output = root / 'report.json'
            proof = root / 'proof.json'
            with patch.object(reporter, 'validated_shared_javascript', return_value={'combined': combined, 'workerdOnly': workerd, 'proof': proof}), patch.object(sys, 'argv', ['coverage.py', '--root', str(root), '--output', str(output), '--shared-js-proof', str(proof), '--istanbul', str(workerd)]), contextlib.redirect_stdout(io.StringIO()):
                reporter.main()
            result = json.loads(output.read_text())
            self.assertEqual(result['errors'], [])
            self.assertEqual(result['javascript']['shared_execution']['status'], 'measured')
            self.assertEqual(result['javascript']['files']['worker.ts']['metrics']['statements']['covered'], 1)
            self.assertEqual(result['javascript']['workerd_only']['files']['worker.ts']['metrics']['statements']['covered'], 0)
            self.assertFalse(next(s for s in result['sources'] if s['path'] == 'worker.ts')['javascript_execution']['workerd_only']['complete'])
            with patch.object(sys, 'argv', ['coverage.py', '--root', str(root), '--output', str(output), '--istanbul', str(workerd), '--workerd-only', str(workerd)]), contextlib.redirect_stdout(io.StringIO()):
                reporter.main()
            result = json.loads(output.read_text())
            self.assertEqual(result['javascript']['shared_execution']['status'], 'unmeasured')
            self.assertEqual(result['javascript']['workerd_only']['status'], 'measured')


if __name__ == '__main__':
    unittest.main()
