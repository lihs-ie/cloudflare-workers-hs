"""Cross-package test fixtures resolve from the compiling package's directory."""
from pathlib import Path
import tempfile
import unittest

from coverage_evidence import hpc_source_candidates


class HpcSourceMappingTests(unittest.TestCase):
    def test_cross_package_relative_path_uses_compiling_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = [
                {'path': 'examples/quickstart/app/Main.hs', 'module': 'Main', 'language': 'haskell', 'package': 'quickstart', 'package_root': 'examples/quickstart'},
                {'path': 'servant/test/Support/Runtime/Routing.hs', 'module': 'Support.Runtime.Routing', 'language': 'haskell', 'package': 'servant', 'package_root': 'servant'},
                {'path': 'other/test/Support/Runtime/Routing.hs', 'module': 'Support.Runtime.Routing', 'language': 'haskell', 'package': 'other', 'package_root': 'other'},
            ]
            self.assertEqual(hpc_source_candidates(root, sources, 'quickstart-0.1-inplace-runtime-tests/Support.Runtime.Routing', ['../../servant/test/Support/Runtime/Routing.hs']), [sources[1]])
            self.assertEqual(hpc_source_candidates(root, sources, 'quickstart-0.1-inplace-runtime-tests/Support.Runtime.Routing', ['test/Support/Runtime/Routing.hs']), [])
            self.assertEqual(hpc_source_candidates(root, sources, 'quickstart-0.1-inplace-runtime-tests/Support.Runtime.Routing', ['../../../outside.hs']), [])
            self.assertEqual(hpc_source_candidates(root, sources, 'quickstart-0.1-inplace-runtime-tests/Support.Runtime.Routing', [str(root / sources[1]['path'])]), [sources[1]])

    def test_unqualified_main_keeps_ambiguity_and_duplicate_package_roots_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = [{'path': f'{package}/Main.hs', 'module': 'Main', 'language': 'haskell', 'package': package, 'package_root': package} for package in ['a', 'b']]
            self.assertEqual(hpc_source_candidates(root, sources, 'Main', ['Main.hs']), sources)
            sources[1]['package'] = 'a'
            with self.assertRaises(ValueError):
                hpc_source_candidates(root, sources, 'a-1/Main', ['Main.hs'])
