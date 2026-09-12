import tempfile
import unittest
from pathlib import Path
from host_plugin_probe import collect, DRIVER, PROBE


class HostPluginProbeTest(unittest.TestCase):
    def test_existing_destination_is_never_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileExistsError):
                collect(directory, directory)

    def test_destination_must_be_inside_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            root.mkdir()
            with self.assertRaises(ValueError):
                collect(root, Path(directory) / 'outside')

    def test_generated_driver_preserves_haskell_lambda_and_real_api(self):
        self.assertIn(r'\file -> guessTarget', DRIVER)
        self.assertIn('runGhc (Just libdir)', DRIVER)
        self.assertIn('foreign export javascript', PROBE)
        self.assertNotIn('\f', DRIVER)
        self.assertLess(DRIVER.index('loaded <- load LoadAllTargets'), DRIVER.index('parsed <- mapM parseModule'))
        self.assertIn('pm_parsed_source parsed', DRIVER)
        self.assertIn('canonicalSignature NoExtField (AnnSig NoEpUniTok Nothing Nothing)', DRIVER)
        self.assertIn('names == ["main"] && null foreignDeclarations', DRIVER)

    def test_command_pipeline_preserves_probe_contracts_and_rejects_missing_evidence(self):
        from unittest.mock import patch
        import subprocess
        import host_plugin_probe as probe
        for mode in ['compat', 'wasm', 'database', 'configuration', 'ticks', 'behavior', 'ast', 'wasm-ast', 'mix', 'changed', 'stale']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve(); output = root / 'output'
                for relative in ['compat/GHC/Wasm/FFI/Plugin.hs', 'compat/GHC/Wasm/Prim.hs', 'wasm/GHC/Wasm/FFI/Plugin.hs']:
                    path = root / 'cloudflare-workers/shim' / relative
                    path.parent.mkdir(parents=True, exist_ok=True); path.write_text('source')
                def execute(argv, **kwargs):
                    label = Path(kwargs['stdout'].name).stem
                    if label == 'shim-build':
                        database = output / 'build/packagedb/ghc-9'
                        if mode != 'database':
                            database.mkdir(parents=True)
                            if mode != 'configuration':
                                (database / 'shim.conf').write_text('package')
                        if mode != 'mix':
                            mix = output / 'build/extra/hpc/dyn/mix/shim/GHC.Wasm.FFI.Plugin.mix'
                            mix.parent.mkdir(parents=True); mix.write_text('Mix plugin')
                    if label == 'driver-build' and mode == 'stale':
                        (output / 'compiler.tix').write_text('old')
                    if label == 'compiler':
                        kwargs['stdout'].write('wrong AST\n' if mode in ['ast', 'wasm-ast'] else 'parsed AST noop passed\n' if mode == 'wasm' else 'parsed AST compatibility passed\n')
                        if mode != 'ticks':
                            Path(kwargs['env']['HPCTIXFILE']).write_text('Tix [GHC.Wasm.FFI.Plugin]')
                    if label == 'probe':
                        kwargs['stdout'].write('wrong' if mode == 'behavior' else 'plugin probe passed\n')
                        if mode == 'changed':
                            (root / 'cloudflare-workers/shim/compat/GHC/Wasm/Prim.hs').write_text('changed')
                    if label == 'select-plugin':
                        (output / 'plugin-only.tix').write_text('plugin only')
                    return subprocess.CompletedProcess(argv, 0)
                with patch.object(probe.subprocess, 'run', side_effect=execute), patch.object(probe.subprocess, 'check_output', return_value='/ghc/lib\n'):
                    if mode in ['compat', 'wasm']:
                        proof = probe.collect(root, output, wasm_plugin=mode == 'wasm')
                        self.assertEqual(proof['status'], 'passed')
                        self.assertEqual([record['command'] for record in proof['commandRecords']], proof['commands'])
                        for record in proof['commandRecords']:
                            self.assertEqual(record['exitCode'], 0)
                            self.assertEqual(record['logSha256'], __import__('hashlib').sha256((output / record['log']).read_bytes()).hexdigest())
                        compiler_command = next(command for command in proof['commands'] if command[0] == str(output / 'driver'))
                        self.assertEqual(compiler_command[2], mode)
                        self.assertEqual('-ddump-rn-ast' in compiler_command, mode == 'compat')
                        self.assertEqual(proof['parsedAst']['mode'], mode)
                        self.assertIn(proof['parsedAst']['successfulMarker'], (output / 'compiler.log').read_text().splitlines())
                        self.assertEqual((output / 'Driver.hs').read_text(), DRIVER)
                        self.assertIn('--exclude=Main', proof['commands'][-1])
                        self.assertEqual(proof['prim'] is None, mode == 'wasm')
                    elif mode in ['ast', 'wasm-ast']:
                        self.assertRaisesRegex(ValueError, 'compiler parsed AST contract did not succeed', probe.collect, root, output, wasm_plugin=mode == 'wasm-ast')
                    else:
                        self.assertRaises(ValueError, probe.collect, root, output)
