import importlib.util
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('native_tools', Path(__file__).parents[1] / 'native-tools-coverage.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class NativeProbeTests(unittest.TestCase):
    def test_each_invocation_uses_fresh_absolute_counter_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def execute(argv, **kwargs):
                Path(kwargs['env']['HPCTIXFILE']).write_text('Tix [TixModule "Main" 1 1 [1]]')
                return subprocess.CompletedProcess(argv, 1, 'expected failure')
            with patch.object(collector.subprocess, 'run', side_effect=execute):
                result = collector.run_probe(root / 'tool', [], root, root, 'invalid', False, 'expected failure', {})
                self.assertEqual(result['processExitCode'], 1)
                self.assertEqual(result['exitCode'], 0)
                self.assertTrue(result['assertionsPassed'])
                self.assertRaises(ValueError, collector.run_probe, root / 'tool', [], root, root, 'invalid', False, 'expected failure', {})

    def test_unexpected_status_or_missing_counters_cannot_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(collector.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'wrong')):
                with self.assertRaises(ValueError):
                    collector.run_probe(root / 'tool', [], root, root, 'failure', True, '', {})
            with patch.object(collector.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '')):
                self.assertRaises(ValueError, collector.run_probe, root / 'tool', [], root, root, 'missing', True, '', {})

    def test_complete_pipeline_and_failure_proofs_preserve_prior_pointer(self):
        import json
        for mode in ['success', 'build', 'binary', 'discovery', 'oracle', 'plugin', 'interface', 'changed', 'linux', 'darwin-no-ffi', 'darwin-ffi', 'darwin-ffi-existing', 'plugin-records', 'plugin-log-sha', 'plugin-log-escape', 'plugin-exit']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve(); output = root / 'artifacts/testing/run'; output.mkdir(parents=True)
                pointer = output.parent / 'native-tools-coverage-latest.json'; pointer.write_text('prior')
                compiler = root / 'ghc'; compiler.write_text('compiler')
                expected = root / 'conformance-oracle/test/Support/Golden/reference.json'; expected.parent.mkdir(parents=True); expected.write_text('{"expected":true}')
                def execute(argv, **kwargs):
                    if argv[:2] == ['cabal', 'build']:
                        include = kwargs['env'].get('C_INCLUDE_PATH')
                        if mode == 'darwin-ffi':
                            self.assertEqual(include, '/opt/homebrew/opt/libffi/include')
                        elif mode == 'darwin-ffi-existing':
                            self.assertEqual(include, '/opt/homebrew/opt/libffi/include' + os.pathsep + '/existing')
                        else:
                            self.assertEqual(include, '/existing')
                        build = output / 'build'; build.mkdir(); (build / 'Main.mix').write_text('mix')
                        return subprocess.CompletedProcess(argv, 1 if mode == 'build' else 0)
                    if argv[:2] == ['cabal', 'list-bin']:
                        binary = (root if mode == 'binary' else output / 'build') / ('discovery' if 'sydtest' in argv[2] else 'oracle')
                        binary.write_text('binary'); return subprocess.CompletedProcess(argv, 0, str(binary))
                    if '--show-iface' in argv:
                        return subprocess.CompletedProcess(argv, 0, 'interface')
                    tix = Path(kwargs['env']['HPCTIXFILE']); tix.write_text('Tix [TixModule "Main" 1 1 [1]]')
                    if Path(argv[0]).name == 'discovery':
                        if len(argv) > 1:
                            Path(argv[-1]).write_text('HiddenSpec' if mode == 'discovery' else 'HTTPSpec')
                            return subprocess.CompletedProcess(argv, 0, '')
                        return subprocess.CompletedProcess(argv, 1, 'expected GHC source, input and output paths')
                    if len(argv) > 1:
                        Path(argv[-1]).write_text('{}' if mode == 'oracle' else expected.read_text())
                        return subprocess.CompletedProcess(argv, 0, '')
                    return subprocess.CompletedProcess(argv, 1, 'Usage: regenerate-conformance-golden')
                def plugin(root, destination, wasm_plugin=False):
                    destination.mkdir(); (destination / 'probe.log').write_text('plugin probe passed')
                    if mode != 'interface':
                        interface = destination / 'build/Prim.hi'; interface.parent.mkdir(); interface.write_text('interface')
                    tix = destination / 'plugin.tix'; tix.write_text('plugin')
                    mix = destination / 'GHC.Wasm.FFI.Plugin.mix'; mix.write_text('mix')
                    records = [{'command': ['ghc'], 'exitCode': False if mode == 'plugin-exit' else 0, 'log': '../build.log' if mode == 'plugin-log-escape' else 'probe.log',
                                'logSha256': 'wrong' if mode == 'plugin-log-sha' else hashlib.sha256((destination / 'probe.log').read_bytes()).hexdigest()}]
                    return {'commandRecords': [] if mode == 'plugin-records' else records, 'status': 'failed' if mode == 'plugin' else 'passed', 'commands': [['ghc']], 'tix': str(tix.relative_to(root)), 'mix': str(mix.relative_to(root)), 'prim': None}
                snapshots = iter([{'source': 'same'}, {'source': 'changed' if mode == 'changed' else 'same'}])
                original_is_dir = Path.is_dir
                def is_directory(path):
                    if str(path) == '/opt/homebrew/opt/libffi/include':
                        return mode in ['darwin-ffi', 'darwin-ffi-existing']
                    return original_is_dir(path)
                environment = {} if mode == 'darwin-ffi' else {'C_INCLUDE_PATH': '/existing'}
                with patch.object(collector.subprocess, 'run', side_effect=execute), patch.object(collector.subprocess, 'check_output', return_value='9.14.1'), patch.object(collector, 'collect_plugin', side_effect=plugin), patch.object(collector.shutil, 'which', return_value=str(compiler)), patch.object(collector.sys, 'platform', 'darwin' if mode.startswith('darwin') else 'linux'), patch.object(Path, 'is_dir', is_directory), patch.dict(collector.os.environ, environment, clear=True):
                    code = collector.collect(root, output, lambda: next(snapshots))
                successful = mode in ['success', 'linux', 'darwin-no-ffi', 'darwin-ffi', 'darwin-ffi-existing']
                self.assertEqual(code, 0 if successful else 1)
                proof = json.loads((output / 'proof.json').read_text())
                self.assertIs(type(proof['exit_code']), int)
                self.assertEqual(proof['exit_code'], code)
                for record in proof['commands']:
                    path = (output / record['log']).resolve()
                    self.assertTrue(path.is_relative_to(output))
                    self.assertEqual(record['logSha256'], hashlib.sha256(path.read_bytes()).hexdigest())
                if successful:
                    self.assertEqual(len(proof['snapshots']), 6)
                    self.assertEqual(proof['errors'], [])
                    self.assertEqual(proof['compileValidations'][0]['kind'], 'haskell-reexport')
                else:
                    self.assertEqual(pointer.read_text(), 'prior')
                    self.assertTrue(proof['errors'])
                    if mode == 'changed':
                        self.assertEqual(proof['errors'], ['Source/config changed during native tool verification'])

    def test_cli_requires_new_scoped_destination(self):
        import runpy
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            with patch.object(collector, 'ROOT', root), patch.object(collector, 'collect', return_value=0) as collect:
                with patch.object(sys, 'argv', ['native-tools-coverage']):
                    self.assertEqual(collector.main(), 0)
                    self.assertTrue(collect.call_args.args[1].is_dir())
                for destination in [root / 'outside', collect.call_args.args[1]]:
                    with patch.object(sys, 'argv', ['native-tools-coverage', '--output', str(destination)]), self.assertRaises(SystemExit):
                        collector.main()
            with patch.object(sys, 'argv', ['native-tools-coverage', '--output', '/outside']), self.assertRaises(SystemExit):
                runpy.run_path(str(Path(__file__).parents[1] / 'native-tools-coverage.py'), run_name='__main__')
