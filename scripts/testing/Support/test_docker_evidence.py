"""Docker runner failure evidence and container ownership contracts."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('docker_evidence_runner', Path(__file__).parents[1] / 'dev-docker.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class DockerEvidenceTests(unittest.TestCase):
    def run_fixture(self, test_code=0, copy_code=0, failure=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []

            def execute(command, **kwargs):
                calls.append(command)
                operation = command[1]
                if operation == 'build':
                    Path(command[command.index('--iidfile') + 1]).write_text('sha256:fixture\n')
                if operation == failure:
                    raise subprocess.CalledProcessError(7, command)
                return subprocess.CompletedProcess(command, test_code if operation == 'start' else copy_code if operation == 'cp' else 0)

            with patch.object(runner, 'ROOT', root), patch.object(runner.sys, 'argv', ['dev-docker.py', 'minimal']), patch.object(runner.subprocess, 'run', side_effect=execute), patch.object(runner.subprocess, 'check_output', return_value='owned-container\n') as create:
                if failure:
                    with self.assertRaises(subprocess.CalledProcessError):
                        runner.main()
                else:
                    self.assertEqual(runner.main(), test_code or copy_code)
                    reports = list((root / 'artifacts/testing/docker').glob('run-*.json'))
                    self.assertEqual(len(reports), 1)
                    report = json.loads(reports[0].read_text())
                    self.assertEqual(report['exitCode'], test_code or copy_code)
                    self.assertEqual(report['artifactCopyExitCode'], copy_code)
                    self.assertEqual(report['image'], 'sha256:fixture')
                    self.assertEqual(report['container'], 'owned-container')
                if failure == 'build':
                    create.assert_not_called()
                    self.assertFalse(any(command[1] == 'rm' for command in calls))
                else:
                    create.assert_called_once_with(['docker', 'create', 'sha256:fixture', 'minimal'], text=True)
                    self.assertEqual(calls[-1], ['docker', 'rm', '--force', 'owned-container'])

    def test_success_and_failures_export_evidence_preserving_test_exit(self):
        for test_code, copy_code in [(0, 0), (2, 0), (0, 3), (2, 3)]:
            with self.subTest(test_code=test_code, copy_code=copy_code):
                self.run_fixture(test_code, copy_code)

    def test_cleanup_removes_only_created_container_on_start_or_copy_exception(self):
        for operation in ['start', 'cp']:
            with self.subTest(operation=operation):
                self.run_fixture(failure=operation)

    def test_build_failure_does_not_create_or_remove_a_container(self):
        self.run_fixture(failure='build')
