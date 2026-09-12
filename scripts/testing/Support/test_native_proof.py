"""Reject stale, tampered, escaped or failed native command coverage evidence."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('native_proof_runner', Path(__file__).parents[1] / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class NativeProofTests(unittest.TestCase):
    def test_fresh_counters_and_independent_proof_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'artifacts/testing/native'
            (output / 'mix').mkdir(parents=True)
            tix = output / 'probe.tix'
            tix.write_text('Tix []')
            mix = output / 'mix/Main.mix'
            mix.write_bytes(b'fixture-mix')
            digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
            log = output / 'suite.log'
            log.write_text('Passed: 1\nFailed: 0\n')
            original = {'sources': {'Main.hs': 'current'}, 'exit_code': 0, 'errors': [],
                        'commands': [{'exitCode': 0, 'log': 'suite.log', 'logSha256': digest(log)}],
                        'snapshots': {'probe.tix': digest(tix)}, 'mixFiles': {'mix/Main.mix': digest(mix)}}
            proof = output / 'proof.json'
            pointer = root / 'artifacts/testing/native-tools-coverage-latest.json'

            def publish(value):
                proof.write_text(json.dumps(value))
                pointer.write_text(json.dumps({'proof': str(proof.relative_to(root)), 'sha256': digest(proof)}))

            publish(original)
            expected = ['--mix-dir', str(output / 'mix'), '--tix', str(tix)]
            publish({key: value for key, value in original.items() if key != 'exit_code'})
            self.assertEqual(runner.verified_hpc_arguments(root, proof, original['sources']), [])
            for code in [1, False, '0']:
                publish(original | {'exit_code': code})
                self.assertEqual(runner.verified_hpc_arguments(root, proof, original['sources']), [])
            log = output / 'suite.log'
            log.write_text('Passed: 1\nFailed: 0\n')
            host = original | {'exit_code': 0, 'commands': [{'exitCode': 0, 'log': 'suite.log', 'logSha256': digest(log)}]}
            publish(host)
            self.assertEqual(runner.verified_hpc_arguments(root, proof, original['sources']), expected)
            log.write_text('Passed: 0\nFailed: 1\n')
            self.assertEqual(runner.verified_hpc_arguments(root, proof, original['sources']), [])
            log.unlink()
            self.assertEqual(runner.verified_hpc_arguments(root, proof, original['sources']), [])
            publish(host | {'commands': [{'exitCode': 0, 'log': '../escaped.log', 'logSha256': 'bad'}]})
            self.assertEqual(runner.verified_hpc_arguments(root, proof, original['sources']), [])
            self.assertEqual(runner.verified_hpc_arguments(root, root.parent / 'escaped-proof.json', original['sources']), [])
            log.write_text('Passed: 1\nFailed: 0\n')
            publish(original)
            self.assertEqual(runner.native_coverage_arguments(root, original['sources']), expected)
            for change in [{'exit_code': 1}, {'exit_code': False}, {'exit_code': '0'}, {'exit_code': None},
                           {'commands': [{'exitCode': 0}]},
                           {'commands': [{'exitCode': 0, 'log': '../escaped.log', 'logSha256': 'bad'}]},
                           {'commands': [{'exitCode': 0, 'log': 'suite.log', 'logSha256': 'bad'}]},
                           {'sources': {}}, {'errors': ['failure']}, {'commands': []},
                           {'commands': [{'exitCode': 1}]}, {'commands': [{'exitCode': False}]}, {'snapshots': {}}, {'mixFiles': {}},
                           {'snapshots': []}, {'mixFiles': {'../outside.mix': 'bad'}},
                           {'snapshots': {'missing.tix': 'bad'}}, {'snapshots': {'probe.tix': 'bad'}}]:
                with self.subTest(change=change):
                    publish(original | change)
                    self.assertEqual(runner.native_coverage_arguments(root, original['sources']), [])
            publish(original)
            extra = output / 'mix/Unexpected.mix'
            extra.write_bytes(b'unrecorded')
            self.assertEqual(runner.native_coverage_arguments(root, original['sources']), [])
            extra.unlink()
            self.assertEqual(runner.native_coverage_arguments(root, original['sources']), expected)
            proof.write_text('{}')
            self.assertEqual(runner.native_coverage_arguments(root, original['sources']), [])
            pointer.write_text(json.dumps({'proof': '../outside.json', 'sha256': 'bad'}))
            self.assertEqual(runner.native_coverage_arguments(root, original['sources']), [])
            pointer.unlink()
            self.assertEqual(runner.native_coverage_arguments(root, original['sources']), [])
