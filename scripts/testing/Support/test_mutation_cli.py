"""Mutation-runner orchestration against a disposable fake compiler boundary."""
import importlib.util
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'scripts/testing/mutations.py'

# The compiler boundary emits an executable test runner. It does not claim to
# compile Haskell; the real mutation suite separately tests mutation efficacy.
COMPILER = r'''
import os
from pathlib import Path
import sys
import time
mode = os.environ['MUTATION_TEST_MODE']
root = Path.cwd()
source = root / 'cloudflare-workers/src/Cloudflare/Workers'
mutant = 'POST' in (source / 'HTTP.hs').read_text() or '(flip (++))' not in (source / 'Headers.hs').read_text() or '>= 31' in (source / 'Binding/KV.hs').read_text()
command = sys.argv[1]
if command == 'build':
    if mode == 'timeout':
        time.sleep(5)
    sys.exit(1 if mode == 'build-error' or (mode == 'mutant-build-error' and mutant) else 0)
if mode == 'binary-error':
    sys.exit(1)
if mode == 'relative-binary':
    print('test-runner')
    sys.exit(0)
if mode == 'missing-binary':
    print(root / 'missing')
    sys.exit(0)
if mode == 'outside-binary':
    print(sys.executable)
    sys.exit(0)
if mode == 'symlink-binary':
    target = root / 'linked-runner'
    if not target.exists():
        target.symlink_to(sys.executable)
    print(target)
    sys.exit(0)
failed = mode == 'baseline-failed' or (mutant and mode != 'survived')
runner = root / 'test-runner'
runner.write_text('#!' + sys.executable + '\nimport sys\nprint(' + repr('Passed: 7, Failed: ' + str(int(failed)) + ' (0.01 s)') + ')\nsys.exit(' + str(int(failed)) + ')\n')
runner.chmod(0o755)
print(runner)
'''
BOOTSTRAP = '''import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("mutation_cli", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ROOT = pathlib.Path(sys.argv[2]); sys.argv = [sys.argv[1], *sys.argv[3:]]
raise SystemExit(m.main())
'''


class MutationCliTests(unittest.TestCase):
    def run_case(self, mode, selection=None, fragment_count=1):
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            root = temporary / 'repository'
            root.mkdir()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            source = root / 'cloudflare-workers/src/Cloudflare/Workers'
            (source / 'Binding').mkdir(parents=True)
            (source / 'HTTP.hs').write_text(('methodToText GET = "GET"\n') * fragment_count)
            (source / 'Headers.hs').write_text('(flip (++))\n')
            (source / 'Binding/KV.hs').write_text('seconds >= 30\n')
            (root / 'cabal.project').write_text('packages: cloudflare-workers\n  testing-support\n\nconstraints: sydtest ==0.28.0.0\n')
            originals = {path: path.read_bytes() for path in source.rglob('*.hs')}
            tool_dir = temporary / 'bin'
            tool_dir.mkdir()
            cabal = tool_dir / 'cabal'
            cabal.write_text('#!' + ('/missing/mutation-interpreter' if mode == 'exec-error' else sys.executable) + '\n' + COMPILER)
            cabal.chmod(0o755)
            (tool_dir / 'git').symlink_to(shutil.which('git'))
            environment = dict(os.environ, PATH=str(tool_dir), MUTATION_TEST_MODE=mode)
            output = temporary / 'evidence'
            # Coverage subprocess startup can exceed one second; only the explicit
            # timeout scenario uses the short deadline.
            args = ['--output', str(output), '--timeout', '1' if mode == 'timeout' else '10']
            for name in selection or []:
                args.extend(['--mutation', name])
            result = subprocess.run([sys.executable, '-c', BOOTSTRAP, str(SCRIPT), str(root), *args],
                                    env=environment, capture_output=True, text=True, timeout=30)
            report = json.loads((output / 'results.json').read_text())
            logs = {record['label']: (output / record['log']).read_text() for record in report['commands']}
            self.assertEqual({path: path.read_bytes() for path in originals}, originals)
            for label, content in logs.items():
                if label.endswith('-binary') and Path(content.strip()).parent.name.startswith('workers-mutations-'):
                    self.assertFalse(Path(content.strip()).exists(), 'Snapshot must be deleted')
            return result, report, logs

    def test_all_mutations_are_killed_and_original_worktree_remains_untouched(self):
        result, report, _ = self.run_case('killed')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report['status'], 'passed')
        self.assertEqual(report['baseline']['status'], 'passed')
        self.assertEqual([row['name'] for row in report['mutations']], ['http-method', 'header-order', 'kv-ttl'])
        self.assertTrue(all(row['status'] == 'killed' for row in report['mutations']))
        self.assertEqual(len(report['commands']), 12)
        for record in report['commands']:
            self.assertFalse(record['timed_out'])
            if record['label'].endswith('-test'):
                self.assertIn('--no-golden-reset', record['command'])
                self.assertIn('--no-skip-passed', record['command'])

    def test_selection_is_deduplicated_and_survivor_fails_the_run(self):
        result, report, _ = self.run_case('survived', ['http-method', 'http-method'])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(len(report['mutations']), 1)
        self.assertEqual(report['mutations'][0]['status'], 'survived')

    def test_failed_baseline_never_runs_mutations(self):
        for mode, status in [('build-error', 'build-error'), ('binary-error', 'binary-error'),
                             ('relative-binary', 'binary-error'), ('missing-binary', 'binary-error'),
                             ('outside-binary', 'binary-error'), ('symlink-binary', 'binary-error'),
                             ('exec-error', 'build-error'), ('baseline-failed', 'baseline-failed'),
                             ('timeout', 'build-error')]:
            with self.subTest(mode=mode):
                result, report, _ = self.run_case(mode)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(report['status'], 'error')
                self.assertEqual(report['baseline']['status'], status)
                self.assertEqual(report['mutations'], [])
                if status == 'binary-error':
                    self.assertNotIn('baseline-test', [command['label'] for command in report['commands']])
                if mode == 'exec-error':
                    self.assertEqual(report['commands'][0]['exit_code'], 127)
                if mode == 'timeout':
                    self.assertTrue(report['commands'][0]['timed_out'])

    def test_mutant_build_failure_is_not_a_kill(self):
        result, report, _ = self.run_case('mutant-build-error', ['http-method'])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['mutations'][0]['status'], 'build-error')

    def test_ambiguous_or_missing_mutation_fragment_stops_safely(self):
        for count in [0, 2]:
            result, report, _ = self.run_case('killed', ['http-method'], count)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(report['status'], 'error')
            self.assertIn('expected exactly one original fragment', report['error'])
            self.assertEqual(report['mutations'], [])

    def test_invalid_timeout_and_mutation_arguments_are_rejected(self):
        for args in [['--timeout', '0'], ['--timeout', '-1'], ['--mutation', 'unknown']]:
            result = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn('error:', result.stderr)

    def test_existing_classification_regressions_run_as_a_cli(self):
        result = subprocess.run([sys.executable, str(SCRIPT.parent / 'Support/mutation_checks.py')],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ran 3 tests', result.stderr)

    def test_snapshot_rejects_ambiguous_project_package_stanzas(self):
        spec = importlib.util.spec_from_file_location('mutation_snapshot', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'source'
            root.mkdir()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            destination = Path(directory) / 'destination'
            destination.mkdir()
            for content in ['constraints: foo ==1\n', 'packages: one\n\npackages: two\n']:
                (root / 'cabal.project').write_text(content)
                with self.assertRaisesRegex(ValueError, 'exactly one packages stanza'):
                    module.snapshot(root, destination)

    def test_unittest_cli_selects_a_single_contract(self):
        result = subprocess.run([sys.executable, __file__,
                                 'MutationCliTests.test_invalid_timeout_and_mutation_arguments_are_rejected'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ran 1 test', result.stderr)


def load_tests(loader, tests, pattern):
    # Connect the legacy checks to normal unittest discovery as well as its CLI.
    spec = importlib.util.spec_from_file_location('legacy_mutation_checks', SCRIPT.parent / 'Support/mutation_checks.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tests.addTests(loader.loadTestsFromModule(module))
    return tests


if __name__ == '__main__':
    unittest.main()
