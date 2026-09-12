"""Real subprocess contracts for measurement, failures, and proof publication."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stderr
import io

ROOT = Path(__file__).resolve().parents[3]
COLLECTOR = ROOT / 'scripts/testing/Support/python_coverage.py'
SUITE = COLLECTOR.with_name('python_suite.py')
BOOTSTRAP = '''import importlib.util, pathlib, sys
import coverage
spec = importlib.util.spec_from_file_location('python_collector', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ROOT = pathlib.Path(sys.argv[2]); sys.argv = [sys.argv[1], *sys.argv[3:]]
enclosing = coverage.Coverage.current()
try:
    raise SystemExit(m.main())
finally:
    if enclosing is not None:
        enclosing.save()
'''
SNAPSHOT = '''import hashlib
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
def source_snapshot():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in ROOT.rglob('*.py') if 'artifacts' not in p.relative_to(ROOT).parts}
'''


class PythonCollectorTests(unittest.TestCase):
    def fixture(self, root, body):
        tests = root / 'tests'
        tests.mkdir()
        runner = root / 'scripts/testing/run.py'
        runner.parent.mkdir(parents=True)
        runner.write_text(SNAPSHOT)
        (root / 'helper.py').write_text('def choose(value):\n    if value:\n        return 1\n    return 0\n')
        (tests / 'test_fixture.py').write_text('import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parents[1]))\n' + body)
        return tests

    def execute(self, root, test_directory, output=None, extra=()):
        arguments = [sys.executable, '-c', BOOTSTRAP, str(COLLECTOR), str(root),
                     '--test-directory', str(test_directory)]
        if output is not None:
            arguments.extend(['--output', str(output)])
        return subprocess.run([*arguments, *extra], cwd=root, capture_output=True, text=True, timeout=45)

    def test_real_measurement_combines_child_branches_and_publishes_matching_proof(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            tests = self.fixture(root, '''import subprocess
import sys
import unittest
from helper import choose
class Fixture(unittest.TestCase):
    def test_branches(self):
        self.assertEqual(choose(True), 1)
        subprocess.run([sys.executable, '-c', 'from helper import choose; assert choose(False) == 0'], check=True)
''')
            completed = self.execute(root, tests)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            pointer = json.loads((root / 'artifacts/testing/python-coverage-latest.json').read_text())
            report = root / pointer['report']
            proof = json.loads((root / pointer['proof']).read_text())
            self.assertEqual(proof['exit_code'], 0)
            self.assertEqual(proof['tests'], 1)
            self.assertEqual(proof['errors'], [])
            self.assertEqual(proof['sha256'], hashlib.sha256(report.read_bytes()).hexdigest())
            self.assertEqual(proof['sources']['helper.py'], hashlib.sha256((root / 'helper.py').read_bytes()).hexdigest())
            data = json.loads(report.read_text())
            helper = next(value for name, value in data['files'].items() if name.endswith('helper.py'))
            self.assertEqual(helper['missing_lines'], [])
            self.assertEqual(helper['missing_branches'], [])
            self.assertEqual(helper['excluded_lines'], [])

    def test_failed_empty_and_abrupt_suites_never_publish_success(self):
        fixtures = [
            ('failed', 'import unittest\nclass Fixture(unittest.TestCase):\n    def test_fail(self):\n        self.fail("intentional failure")\n'),
            ('empty', 'marker = "no tests declared"\n'),
            ('abrupt', 'import os\nos._exit(7)\n'),
        ]
        for name, source in fixtures:
            with self.subTest(case=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                tests = self.fixture(root, source)
                output = root / 'artifacts/testing/run'
                completed = self.execute(root, tests, output)
                self.assertEqual(completed.returncode, 1, completed.stderr)
                proof = json.loads((output / 'proof.json').read_text())
                self.assertEqual(proof['exit_code'], 1)
                self.assertTrue(proof['errors'])
                self.assertFalse((root / 'artifacts/testing/python-coverage-latest.json').exists())
                if name == 'abrupt':
                    self.assertIn('No Python coverage data was produced', proof['errors'])

    def test_source_changes_invalidate_evidence_even_when_tests_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            tests = self.fixture(root, '''import unittest
from pathlib import Path
class Fixture(unittest.TestCase):
    def test_change(self):
        path = Path('helper.py')
        path.write_text(path.read_text() + '\\n# changed during tests\\n')
''')
            output = root / 'artifacts/testing/run'
            completed = self.execute(root, tests, output)
            self.assertEqual(completed.returncode, 1, completed.stderr)
            proof = json.loads((output / 'proof.json').read_text())
            self.assertIn('Source inputs changed during collection', proof['errors'])
            self.assertFalse((root / 'artifacts/testing/python-coverage-latest.json').exists())

    def test_invalid_output_and_test_directory_are_rejected_before_collection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            tests = self.fixture(root, 'marker = 1\n')
            existing = root / 'existing'
            existing.mkdir()
            sentinel = existing / 'keep'
            sentinel.write_text('preserved')
            for test_directory, output in [(tests, existing), (tests, root.parent / 'outside'),
                                           (root.parent, root / 'fresh'), (root / 'missing', root / 'fresh')]:
                result = self.execute(root, test_directory, output)
                self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(sentinel.read_text(), 'preserved')
            self.assertFalse((root / 'fresh').exists())

    def test_cli_rejects_unknown_arguments_and_suite_requires_paths(self):
        for script in [COLLECTOR, SUITE]:
            result = subprocess.run([sys.executable, str(script), '--not-an-option'],
                                    cwd=ROOT, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn('error:', result.stderr)

    def test_standalone_cli_replays_a_selected_contract(self):
        result = subprocess.run([sys.executable, __file__, 'PythonCollectorTests.test_cli_rejects_unknown_arguments_and_suite_requires_paths'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ran 1 test', result.stderr)

    def test_suite_import_is_inert_and_empty_suite_fails_with_a_result(self):
        spec = importlib.util.spec_from_file_location('isolated_python_suite', SUITE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve()
            (path / 'test_empty.py').write_text('marker = 1\n')
            result = path / 'result.json'
            with patch.object(sys, 'argv', [str(SUITE), '--test-directory', str(path), '--result', str(result)]), redirect_stderr(io.StringIO()):
                status = module.main()
            self.assertEqual(status, 1)
            self.assertEqual(json.loads(result.read_text()), {'tests': 0, 'successful': False})


if __name__ == '__main__':
    unittest.main()
