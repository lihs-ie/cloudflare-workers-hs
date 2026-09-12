"""Collector orchestration contracts; HTTP is real, compiler/test commands are isolated."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen

from test_wasm_collector import collector


class WasmCollectorStages(unittest.TestCase):
    def scenario(self, *, example='quickstart', failure=None, silent=(), drift=False,
                 report_errors=False, all_examples=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            output = root / 'artifacts/testing/result'
            for name in collector.EXAMPLES:
                suite = root / 'examples' / name / 'test/integration'
                suite.mkdir(parents=True)
                (suite / 'fixture.spec.mjs').write_text('// test boundary')
            mix = root / 'cloudflare-workers/.hpc/wasm-fixture'
            mix.mkdir(parents=True)
            (mix / 'Fixture.mix').write_bytes(b'fixture-mix')
            calls = []

            def execute(command, **options):
                log = Path(options['stdout'].name).name
                calls.append(log)
                if log == 'report.log':
                    Path(command[command.index('--output') + 1]).write_text(json.dumps({
                        'wasm_hpc': [], 'errors': ['fixture report rejected'] if report_errors else []}))
                elif '-tests.log' in log and log not in silent:
                    with urlopen(Request(options['env']['WASM_COVERAGE_ENDPOINT'],
                                         data=b'Tix [TixModule "Fixture" 1 1 [1]]', method='POST'), timeout=3) as response:
                        self.assertEqual(response.status, 204)
                return subprocess.CompletedProcess(command, 42 if log == failure else 0)

            argv = ['collector', '--output', str(output)]
            argv += ['--all-examples'] if all_examples else ['--example', example]
            snapshots = [{'input': 'stable'}, {'input': 'changed' if drift else 'stable'}]
            with patch.object(collector, 'ROOT', root), patch.object(collector, 'source_snapshot', side_effect=snapshots), \
                 patch.object(collector.subprocess, 'run', side_effect=execute), patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
                code = collector.main()
            proof = json.loads((output / 'proof.json').read_text())
            pointer = root / 'artifacts/testing/wasm-coverage-latest.json'
            self.assertEqual(pointer.exists(), code == 0)
            self.assertEqual([entry['log'] for entry in proof['commands']], calls[:-1] if calls[-1] == 'report.log' else calls)
            return code, proof, calls

    def test_quickstart_collects_fixture_production_dev_and_mixes_in_order(self):
        code, proof, calls = self.scenario()
        self.assertEqual(code, 0)
        self.assertEqual(calls, ['quickstart-build.log', 'quickstart-tests.log',
                                'quickstart-production-build.log', 'quickstart-production-tests.log',
                                'quickstart-dev-tests.log', 'report.log'])
        self.assertEqual(len(proof['snapshots']), 3)
        self.assertEqual(len(proof['mixFiles']), 1)

    def test_all_examples_are_collected(self):
        code, proof, calls = self.scenario(all_examples=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(proof['snapshots']), 8)
        self.assertIn('workflows-tests.log', calls)

    def test_each_build_test_or_report_failure_prevents_success_pointer(self):
        for stage in ['quickstart-build.log', 'quickstart-tests.log',
                      'quickstart-production-build.log', 'quickstart-production-tests.log',
                      'quickstart-dev-tests.log', 'report.log']:
            with self.subTest(stage=stage):
                code, _, calls = self.scenario(failure=stage)
                self.assertEqual(code, 42)
                self.assertEqual(calls[-1], stage)

    def test_missing_snapshots_are_failure_even_when_test_process_succeeds(self):
        for options, message in [({'example': 'minimal', 'silent': ('minimal-tests.log',)}, 'No snapshots for minimal'),
                                 ({'silent': ('quickstart-tests.log',)}, 'No snapshots for quickstart runtime'),
                                 ({'silent': ('quickstart-production-tests.log',)}, 'No snapshots for quickstart production'),
                                 ({'silent': ('quickstart-dev-tests.log',)}, 'No snapshots for quickstart wrangler')]:
            with self.subTest(message=message):
                code, proof, calls = self.scenario(**options)
                self.assertEqual(code, 1)
                self.assertTrue(any(message in error for error in proof['errors']))
                self.assertNotIn('report.log', calls)

    def test_source_changes_and_report_errors_fail(self):
        code, proof, _ = self.scenario(drift=True)
        self.assertEqual(code, 1)
        self.assertIn('Sources changed during coverage execution', proof['errors'])
        code, _, calls = self.scenario(report_errors=True)
        self.assertEqual(code, 1)
        self.assertEqual(calls[-1], 'report.log')

    def test_invalid_cli_is_rejected_before_execution(self):
        for arguments in [['--all-examples', '--example', 'minimal'], ['--output', '/outside-repository/collection']]:
            with self.subTest(arguments=arguments), patch.object(sys, 'argv', ['collector', *arguments]), \
                 patch.object(collector.subprocess, 'run') as execute, self.assertRaises(SystemExit) as raised:
                collector.main()
            self.assertEqual(raised.exception.code, 2)
            execute.assert_not_called()

    def test_standalone_help_does_not_start_a_collector(self):
        scripts = Path(__file__).resolve().parents[1]
        for filename in [scripts / 'wasm-coverage.py', scripts / 'Support/test_wasm_collector.py']:
            result = subprocess.run([sys.executable, str(filename), '--help'], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('usage:', result.stdout)
