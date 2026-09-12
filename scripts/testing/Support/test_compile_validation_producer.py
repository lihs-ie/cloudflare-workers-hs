import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('compile_producer', Path(__file__).parents[1] / 'compile-validation.py')
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class CompileProducerTests(unittest.TestCase):
    def prepare(self, root):
        relative = 'examples/minimal/worker/wasm.d.ts'
        path = root / relative
        path.parent.mkdir(parents=True)
        path.write_text('declare const value: string;')
        config = root / 'examples/minimal/tsconfig.json'
        config.write_text('{}')
        manifest = root / 'scripts/testing/runtime-scope.json'
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({'validations': [{'path': relative, 'kind': 'declaration'}]}))
        output = root / 'artifacts/testing/run'
        output.mkdir(parents=True)
        sources = {str(config.relative_to(root)): hashlib.sha256(config.read_bytes()).hexdigest(), relative: hashlib.sha256(path.read_bytes()).hexdigest(), str(manifest.relative_to(root)): hashlib.sha256(manifest.read_bytes()).hexdigest()}
        return relative, output, sources

    def test_success_records_actual_inputs_and_atomic_pointer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            relative, output, sources = self.prepare(root)
            def execute(argv, **kwargs):
                return subprocess.CompletedProcess(argv, 0, str(root / relative) + '\n' if '--listFiles' in argv else 'PASS\n')
            with patch.object(producer.subprocess, 'run', side_effect=execute):
                self.assertEqual(producer.collect(root, output, lambda: sources), 0)
            proof = json.loads((output / 'proof.json').read_text())
            self.assertEqual(proof['commands'][1]['inputs'], [relative])
            self.assertEqual(proof['validated'][0]['commandIndex'], 1)
            self.assertEqual(proof['commands'][0]['argv'], ['node', 'scripts/testing/typecheck.mjs', '--check', 'minimal'])
            pointer = json.loads((root / 'artifacts/testing/compile-validation-latest.json').read_text())
            self.assertEqual(pointer['sha256'], hashlib.sha256((output / 'proof.json').read_bytes()).hexdigest())

    def test_failures_leave_existing_pointer_untouched(self):
        for mode in ['exit', 'missing-input', 'changed-source', 'timeout', 'spawn']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                relative, output, sources = self.prepare(root)
                pointer = root / 'artifacts/testing/compile-validation-latest.json'
                pointer.write_text('prior successful proof')
                snapshots = iter([sources, {} if mode == 'changed-source' else sources])
                def execute(argv, **kwargs):
                    if mode == 'timeout':
                        raise subprocess.TimeoutExpired(argv, 180)
                    if mode == 'spawn':
                        raise OSError('missing compiler')
                    return subprocess.CompletedProcess(argv, 1 if mode == 'exit' else 0, 'no inputs\n' if mode == 'missing-input' else str(root / relative) + '\n')
                with patch.object(producer.subprocess, 'run', side_effect=execute):
                    self.assertEqual(producer.collect(root, output, lambda: next(snapshots)), 1)
                self.assertEqual(pointer.read_text(), 'prior successful proof')
                self.assertTrue(json.loads((output / 'proof.json').read_text())['errors'])

    def test_projects_reject_contracts_outside_example_projects(self):
        for path in ('packages/worker-runtime/test/Support/consumer.ts', 'other/contracts.ts'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                producer.compiler_projects([{'path': path}])

    def test_shared_declaration_uses_explicit_project(self):
        entry = {'path': 'scripts/testing/Support/readiness.d.mts', 'compiler_project': 'examples/quickstart'}
        self.assertEqual(producer.compiler_projects([entry]), {'examples/quickstart': 'tsconfig.json'})
        with self.assertRaises(ValueError):
            producer.compiler_projects([{**entry, 'compiler_project': 'unapproved/project'}])
