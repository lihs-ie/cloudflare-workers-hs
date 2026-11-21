import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('api_execution', Path(__file__).parents[1] / 'api-execution-evidence.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class APIExecutionChecks(unittest.TestCase):
    def test_requires_matching_source_and_positive_entry(self):
        inventory = {'source_sha256': {'A.hs': 'current'}, 'rows': [{'source': 'A.hs', 'name': 'run'}]}
        report = {'sources': [{'path': 'A.hs', 'sha256': 'current'}], 'wasm_hpc': [{'sources': ['A.hs'], 'module': 'A', 'hash': '42', 'bindings': [{'name': 'run', 'hits': 1}]}]}
        rows = module.correlate(inventory, [('report.json', report)])
        self.assertEqual(rows[0]['execution_status'], 'binding_entry_observed')
        self.assertEqual(rows[0]['executed_evidence'][0]['runtime'], 'wasm')
        report['wasm_hpc'][0]['bindings'][0]['hits'] = 0
        self.assertEqual(module.correlate(inventory, [('report.json', report)])[0]['execution_status'], 'unverified')
        report['wasm_hpc'][0]['bindings'][0]['hits'] = 1
        report['sources'][0]['sha256'] = 'old'
        self.assertEqual(module.correlate(inventory, [('report.json', report)])[0]['execution_status'], 'unverified')

    def test_rejects_failed_collection(self):
        with self.assertRaises(ValueError):
            module.correlate({'rows': [{'source': 'A.hs'}]}, [('bad.json', {'errors': ['missing mix']})])
