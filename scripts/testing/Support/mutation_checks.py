"""Regression checks for conservative mutation outcome classification."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mutations', Path(__file__).resolve().parents[1] / 'mutations.py')
mutations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mutations)


class MutationChecks(unittest.TestCase):
    def test_only_completed_failed_test_is_killed(self):
        record = {'output': '  Passed: 42, Failed: 1 (0.1 s)\n', 'exit_code': 1, 'timed_out': False}
        self.assertEqual(mutations.verdict(record), 'killed')
        self.assertEqual(mutations.verdict(record, baseline=True), 'baseline-failed')
        for change in [{'timed_out': True}, {'exit_code': -9}, {'exit_code': 0},
                       {'output': 'compilation failed'}, {'output': ''},
                       {'output': 'Passed: 0, Failed: 0 (0 s)'},
                       {'output': record['output'] * 2}]:
            self.assertEqual(mutations.verdict(dict(record, **change)), 'error')

    def test_success_is_survival_and_baseline_pass(self):
        record = {'output': 'Passed: 43, Failed: 0 (0.1 s)', 'exit_code': 0, 'timed_out': False}
        self.assertEqual(mutations.verdict(record), 'survived')
        pretty = dict(record, output='  Passed: 43\n  Failed: 0\n')
        self.assertEqual(mutations.verdict(pretty), 'survived')
        self.assertEqual(mutations.verdict(record, baseline=True), 'passed')

    def test_snapshot_uses_worktree_bytes_and_preserves_deletions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root'
            copy = Path(directory) / 'copy'
            root.mkdir()
            copy.mkdir()
            (root / 'cloudflare-workers').mkdir()
            source = root / 'cloudflare-workers/dirty.hs'
            source.write_text('uncommitted content')
            (root / 'cabal.project').write_text('packages:\n  cloudflare-workers/cloudflare-workers.cabal\n  other/other.cabal\n\nconstraints: sydtest ==0.28.0.0\n')
            listed = b'cloudflare-workers/dirty.hs\0cloudflare-workers/deleted.hs\0other/ignored.hs\0'
            with patch.object(mutations.subprocess, 'check_output', return_value=listed):
                digests = mutations.snapshot(root, copy)
            self.assertEqual((copy / 'cloudflare-workers/dirty.hs').read_bytes(), source.read_bytes())
            self.assertFalse((copy / 'cloudflare-workers/deleted.hs').exists())
            self.assertIn('constraints: sydtest ==0.28.0.0', (copy / 'cabal.project').read_text())
            self.assertNotIn('other/other.cabal', (copy / 'cabal.project').read_text())
            self.assertIn('cloudflare-workers/dirty.hs', digests)


if __name__ == '__main__':
    unittest.main()
