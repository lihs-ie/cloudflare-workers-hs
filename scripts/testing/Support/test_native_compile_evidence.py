import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from coverage_evidence import apply_scope, native_compile_evidence


class NativeCompileTests(unittest.TestCase):
    def test_fresh_reexport_has_compiler_gate_not_runtime_percentage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            name = 'cloudflare-workers/shim/compat/GHC/Wasm/Prim.hs'
            source = root / name
            source.parent.mkdir(parents=True)
            source.write_text('module GHC.Wasm.Prim (JSVal) where\nimport GHC.Wasm.Prim.Host.Internal (JSVal)\n')
            for path in ['cabal.project', 'cloudflare-workers/cloudflare-workers.cabal']:
                (root / path).write_text('configuration')
            compiler = root / 'ghc'
            compiler.write_text('test compiler identity')
            output = root / 'evidence'
            output.mkdir()
            artifacts = {'Prim.hi': b'compiler binary interface', 'Prim.interface': b'interface GHC.Wasm.Prim [self-recomp] 9141\nexports:\n GHC.Wasm.Prim.Host.Internal.JSVal\n  $trModule :: Metadata\n', 'probe.log': b'plugin probe passed\n'}
            for path, contents in artifacts.items():
                (output / path).write_bytes(contents)
            record = lambda path: {'path': path, 'sha256': hashlib.sha256((output / path).read_bytes()).hexdigest()}
            sources = [{'path': name, 'language': 'haskell'}]
            apply_scope(root, sources, {'validations': [{'path': name, 'kind': 'haskell-reexport', 'evidence': 'cloudflare-workers/cloudflare-workers.cabal', 'reason': 'reexport'}]})
            proof = {'sources': {path: hashlib.sha256((root / path).read_bytes()).hexdigest() for path in [name, 'cabal.project', 'cloudflare-workers/cloudflare-workers.cabal']}, 'errors': [], 'commands': [{'command': ['ghc', '--show-iface', str(output / 'Prim.hi')], 'exitCode': 0}], 'compileValidations': [{'path': name, 'kind': 'haskell-reexport', 'interface': record('Prim.hi'), 'dump': record('Prim.interface'), 'probe': record('probe.log'), 'compiler': {'path': str(compiler), 'version': '9.14.1', 'sha256': hashlib.sha256(compiler.read_bytes()).hexdigest()}}]}
            proof_path = output / 'proof.json'
            proof_path.write_text(json.dumps(proof))
            result = native_compile_evidence(root, sources, proof_path)[name]
            self.assertTrue(result['complete'])
            self.assertNotIn('metrics', result)
            for path in ['Prim.hi', 'Prim.interface', 'probe.log']:
                original = (output / path).read_bytes()
                (output / path).write_bytes(original + b'changed')
                with self.assertRaises(ValueError):
                    native_compile_evidence(root, sources, proof_path)
                (output / path).write_bytes(original)
            import copy
            for mode in ['missing-config', 'stale-source', 'unapproved', 'source-body', 'compiler', 'missing-command']:
                changed = copy.deepcopy(proof)
                original = source.read_text()
                if mode == 'missing-config':
                    del changed['sources']['cabal.project']
                elif mode == 'stale-source':
                    changed['sources'][name] = 'wrong'
                elif mode == 'unapproved':
                    changed['compileValidations'][0]['kind'] = 'declaration'
                elif mode == 'source-body':
                    source.write_text(original + 'value = 1\n')
                    changed['sources'][name] = hashlib.sha256(source.read_bytes()).hexdigest()
                elif mode == 'compiler':
                    changed['compileValidations'][0]['compiler']['sha256'] = 'wrong'
                else:
                    changed['commands'][0]['command'] = ['ghc', '--version']
                proof_path.write_text(json.dumps(changed))
                with self.subTest(mode=mode), self.assertRaises(ValueError):
                    native_compile_evidence(root, sources, proof_path)
                source.write_text(original)
            for code in [1, -1, False, '0', None]:
                changed = {**proof, 'exit_code': code}
                proof_path.write_text(json.dumps(changed))
                with self.subTest(exit_code=code), self.assertRaisesRegex(ValueError, 'Native compiler proof failed'):
                    native_compile_evidence(root, sources, proof_path)
            proof_path.write_text(json.dumps({**proof, 'exit_code': 0}))
            self.assertTrue(native_compile_evidence(root, sources, proof_path)[name]['complete'])
            proof['errors'] = ['compiler failed']
            proof_path.write_text(json.dumps(proof))
            with self.assertRaises(ValueError):
                native_compile_evidence(root, sources, proof_path)
            proof['errors'] = []
            (output / 'Prim.interface').write_text('interface GHC.Wasm.Prim [self-recomp] 9141\nGHC.Wasm.Prim.Host.Internal.JSVal\n  execute :: IO ()\n')
            proof['compileValidations'][0]['dump'] = record('Prim.interface')
            proof_path.write_text(json.dumps(proof))
            with self.assertRaises(ValueError):
                native_compile_evidence(root, sources, proof_path)
