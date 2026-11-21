"""Exercise interface selection, consumer controls and CLI failure reporting."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'haskell-validation.py'
SPEC = importlib.util.spec_from_file_location('haskell_validation_producer', SCRIPT)
producer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(producer)


def fixture(root):
    source = root / 'A.hs'
    source.write_text('module A where\nnewtype A = A Int\n')
    discovery = root / 'Spec.hs'
    discovery.write_text('{-# OPTIONS_GHC -F -pgmF sydtest-discover-layer #-}\n')
    scope = root / 'scripts/testing/runtime-scope.json'
    scope.parent.mkdir(parents=True)
    scope.write_text(json.dumps({'validations': [
        {'path': 'A.hs', 'kind': 'haskell-interface',
         'source_sha256': producer.fingerprint(source), 'compiler_runtimes': ['host', 'wasm']},
        {'path': 'Spec.hs', 'kind': 'haskell-test-entry',
         'source_sha256': producer.fingerprint(discovery), 'target': 'p:test:unit'},
    ]}))
    parents = {}
    for runtime in ['host', 'wasm']:
        build = root / (runtime + '-build')
        build.mkdir()
        (build / 'A.hi').write_bytes(b'interface candidate')
        directory = root / (runtime + '-parent')
        directory.mkdir()
        (directory / 'binary.log').write_text('/fixture/suite\n')
        (directory / 'suite.log').write_text('Passed: 3\nFailed: 0\n')
        proof = {
            'compiler': {'path': '/fixture/' + runtime + '-ghc', 'cabal_path': '/fixture/wasm-cabal'},
            'commands': [
                {'command': ['cabal', 'build', '--builddir=' + str(build)]},
                {'command': ['cabal', 'list-bin', 'p:test:unit'], 'log': 'binary.log'},
                {'command': ['/fixture/suite'], 'log': 'suite.log'},
            ],
            'buildPlans': [{'buildDirectory': str(build)}],
        }
        parents[runtime] = directory / 'proof.json'
        parents[runtime].write_text(json.dumps(proof))
    return source, parents


class HaskellValidationProducerTests(unittest.TestCase):
    def collect(self, root, source, parents, mode):
        output = root / 'artifacts/testing/run'
        output.mkdir(parents=True)

        def compile_command(argv, **_kwargs):
            if argv[1] == '--show-iface':
                source_hash = hashlib.md5(source.read_bytes()).hexdigest()
                if mode == 'stale-interface':
                    source_hash = 'old-source'
                return subprocess.CompletedProcess(argv, 0, 'interface A [self-recomp]\n  src hash: ' + source_hash)

            consumer = Path(argv[-1])
            if consumer.name == 'public.hs':
                code = 1 if mode == 'public-failure' else 0
                return subprocess.CompletedProcess(argv, code, 'public control')

            diagnostic = 'StaticRouter not in scope' if consumer.stem == 'router-constructor' else consumer.stem + ' hidden module'
            code = 0 if mode == 'private-import-compiles' else 1
            return subprocess.CompletedProcess(argv, code, diagnostic)

        snapshots = [{'A.hs': 'current'}, {'A.hs': 'changed' if mode == 'source-changed' else 'current'}]
        with patch.object(producer, 'source_snapshot', side_effect=snapshots), \
                patch.object(producer, 'host_projection_proof', return_value={}), \
                patch.object(producer.subprocess, 'run', side_effect=compile_command):
            code = producer.collect(root, output, parents['host'], parents['wasm'])
        return code, json.loads((output / 'proof.json').read_text())

    def test_success_records_both_interfaces_discovery_and_positive_negative_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, parents = fixture(root)

            code, proof = self.collect(root, source, parents, 'success')

            self.assertEqual(code, 0)
            self.assertEqual(proof['errors'], [])
            self.assertEqual(set(proof['validated'][0]['interfaces']), {'host', 'wasm'})
            self.assertEqual(proof['validated'][1]['execution']['passed'], 3)
            self.assertEqual(len(proof['commands']), 14)
            self.assertEqual(sum(not command['expectedSuccess'] for command in proof['commands']), 10)
            self.assertTrue((root / 'artifacts/testing/haskell-validation-latest.json').is_file())

    def test_stale_interface_missing_interface_control_failure_and_changed_source_do_not_publish(self):
        for mode in ['stale-interface', 'missing-interface', 'public-failure', 'private-import-compiles', 'source-changed']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                source, parents = fixture(root)
                if mode == 'missing-interface':
                    (root / 'wasm-build/A.hi').unlink()

                code, proof = self.collect(root, source, parents, mode)

                self.assertEqual(code, 1)
                self.assertTrue(proof['errors'])
                self.assertFalse((root / 'artifacts/testing/haskell-validation-latest.json').exists())

    def test_cli_requires_fresh_repository_output_and_returns_collector_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            destination = root / 'artifacts/testing/fresh'
            arguments = ['haskell-validation.py', '--host-proof', 'host.json', '--wasm-proof', 'wasm.json']
            with patch.object(producer, 'ROOT', root), patch.object(producer, 'collect', return_value=1) as collect:
                with patch('sys.argv', [*arguments, '--output', str(destination)]), contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(producer.main(), 1)
                self.assertEqual(collect.call_args.args[1], destination)

                for candidate in [destination, root.parent / 'outside']:
                    with self.subTest(candidate=candidate), patch('sys.argv', [*arguments, '--output', str(candidate)]), \
                            contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as error:
                        producer.main()
                    self.assertEqual(error.exception.code, 2)
