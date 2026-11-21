import hashlib
from pathlib import Path
import tempfile
import unittest
from Support.hpc_classification import constant_guard_metrics


class ConstantGuardTests(unittest.TestCase):
    def test_reviewed_otherwise_retains_the_raw_condition_and_removes_only_impossible_false(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'A.hs'
            path.write_text('    | otherwise = value\n')
            manifest = {'constant_guards': [{'path': 'A.hs', 'source_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                        'guards': [{'span': [1, 7, 1, 15], 'token': 'otherwise'}]}]}
            mix = '[(1:7-1:15,BinBox GuardBinBox True),(1:7-1:15,BinBox GuardBinBox False)]'
            raw = {'booleans': {'covered': 1, 'total': 2, 'percent': 50}, 'exprs': {'covered': 3, 'total': 4}}

            result, guards = constant_guard_metrics(root, 'A.hs', mix, [2, 0], raw, manifest)

            self.assertEqual(result['booleans'], {'covered': 1, 'total': 1, 'percent': 100})
            self.assertEqual(raw['booleans']['total'], 2)
            self.assertEqual(result['exprs'], raw['exprs'])
            self.assertEqual(guards[0]['unreachable'], False)
            for ticks in [[2, 1], [2]]:
                with self.assertRaises(ValueError):
                    constant_guard_metrics(root, 'A.hs', mix, ticks, raw, manifest)
            path.write_text('    | otherwise = changed\n')
            with self.assertRaisesRegex(ValueError, 'source changed'):
                constant_guard_metrics(root, 'A.hs', mix, [2, 0], raw, manifest)

    def test_unreviewed_guards_are_never_inferred_from_their_name(self):
        metrics = {'booleans': {'covered': 0, 'total': 1}}
        self.assertEqual(constant_guard_metrics(Path('/missing'), 'A.hs', '', [], metrics, {}), (metrics, []))
