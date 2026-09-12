"""The documented direct unittest entrypoints select tests and report failures."""
import os
from pathlib import Path
import subprocess
import sys
import unittest


class DiagnosticEntrypointTests(unittest.TestCase):
    def test_direct_entrypoints_select_one_contract_and_reject_unknown_test(self):
        support = Path(__file__).resolve().parent
        selections = {
            'test_registration.py': 'RegistrationTests.test_valid_records_identity_not_only_count',
            'test_run.py': 'RunEvidenceTests.test_runner_requires_one_nonempty_success_per_target',
            'coverage_checks.py': 'CoverageChecks.test_boolean_requires_both_outcomes',
            'test_shared_js_connection.py': 'SharedConnectionTests.test_missing_pointer_and_tampered_hash_never_accept_combined',
            'test_shared_node_collector.py': 'SharedNodeCollectorTests.test_real_contract_registry_has_preload_and_no_worker_commands',
        }
        environment = dict(os.environ)
        environment['PYTHONPATH'] = os.pathsep.join(filter(None, [str(support), environment.get('PYTHONPATH')]))
        for name, selection in selections.items():
            with self.subTest(entrypoint=name):
                command = [sys.executable, str(support / name)]
                success = subprocess.run([*command, selection], env=environment, capture_output=True, text=True, timeout=30)
                self.assertEqual(success.returncode, 0, success.stderr)
                self.assertIn('Ran 1 test', success.stderr)
                self.assertIn('OK', success.stderr)
                failure = subprocess.run([*command, 'NoSuchDiagnosticContract'], env=environment, capture_output=True, text=True, timeout=30)
                self.assertEqual(failure.returncode, 1, failure.stderr)
                self.assertIn('NoSuchDiagnosticContract', failure.stderr)
                self.assertIn('FAILED (errors=1)', failure.stderr)
