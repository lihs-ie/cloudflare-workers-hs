"""Do not accept a report whose per-isolate execution evidence was changed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('workerd_proof_runner', Path(__file__).parents[1] / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class WorkerdProofTests(unittest.TestCase):
    def test_valid_proof_and_individually_corrupted_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'artifacts/testing/workerd'
            output.mkdir(parents=True)
            report = output / 'report.json'
            report.write_text('{}')
            snapshot = output / 'snapshot.json'
            snapshot.write_text('{"executed":true}')
            manifest = output / 'manifest.json'
            manifest.write_text('{"source":"worker.ts"}')
            digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
            original = {'sources': {'worker.ts': 'source-hash'}, 'exit_code': 0, 'sha256': digest(report),
                        'errors': [], 'commands': [{'exitCode': 0}],
                        'snapshots': {'snapshot.json': digest(snapshot)}, 'manifests': {'manifest.json': digest(manifest)}}
            proof = output / 'proof.json'
            pointer = root / 'artifacts/testing/workerd-js-coverage-latest.json'
            pointer.write_text(json.dumps({'report': str(report.relative_to(root)), 'proof': str(proof.relative_to(root))}))
            proof.write_text(json.dumps(original))
            self.assertEqual(runner.workerd_javascript_coverage_arguments(root, original['sources']), ['--istanbul', str(report)])
            changes = [{'errors': ['bad snapshot']}, {'commands': []}, {'commands': [{'exitCode': 1}]},
                       {'snapshots': {}}, {'manifests': {}}, {'snapshots': {'snapshot.json': 'wrong'}},
                       {'manifests': {'missing.json': 'wrong'}}, {'snapshots': {'../outside.json': 'wrong'}},
                       {'exit_code': 1}, {'sources': {'worker.ts': 'changed'}}, {'snapshots': []}]
            for change in changes:
                with self.subTest(change=change):
                    proof.write_text(json.dumps(original | change))
                    self.assertEqual(runner.workerd_javascript_coverage_arguments(root, original['sources']), [])
            proof.write_text(json.dumps(original))
            snapshot.write_text('{"executed":false}')
            self.assertEqual(runner.workerd_javascript_coverage_arguments(root, original['sources']), [])
