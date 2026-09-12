import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('coverage_evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class PythonEvidenceTests(unittest.TestCase):
    def test_missing_branch_remains_incomplete_and_invalid_evidence_rejects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'code.py').write_text('if ready:\n    run()\n')
            report = root / 'report.json'
            entry = {'executed_lines': [1, 2], 'missing_lines': [], 'excluded_lines': [],
                     'executed_branches': [[1, 2]], 'missing_branches': [[1, -1]],
                     'summary': {'num_statements': 2, 'num_branches': 2}}
            data = {'meta': {'branch_coverage': True}, 'files': {'code.py': entry}}
            report.write_text(json.dumps(data))
            result = evidence.python_evidence(root, report)['code.py']
            self.assertFalse(result['complete'])
            self.assertEqual(result['metrics']['branches']['percent'], 50)
            for key, value in [('excluded_lines', [2]), ('executed_lines', [1, 1]), ('missing_lines', [1]), ('executed_branches', [[0, 2]])]:
                changed = copy.deepcopy(data)
                changed['files']['code.py'][key] = value
                report.write_text(json.dumps(changed))
                with self.assertRaises(ValueError):
                    evidence.python_evidence(root, report)
            data['meta']['branch_coverage'] = False
            report.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                evidence.python_evidence(root, report)
