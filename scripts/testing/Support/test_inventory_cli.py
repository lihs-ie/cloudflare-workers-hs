"""Exercise inventory CLIs on authored fixtures and the real repository."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / 'scripts/testing'
PACKAGES = ['cloudflare-workers', 'servant-cloudflare-workers',
            'servant-cloudflare-workers-client', 'servant-cloudflare-workers-access']


def load_inventory(filename):
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(root, relative, content):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    return path


class InventoryCliTests(unittest.TestCase):
    def run_fixture(self, filename, root, output):
        # Load the real script so subprocess coverage records the repository file.
        bootstrap = '''import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location("inventory_cli", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.ROOT = pathlib.Path(sys.argv[2]); sys.argv = [sys.argv[1], "--output", sys.argv[3]]
m.main()
'''
        return subprocess.run([sys.executable, '-c', bootstrap, str(SCRIPTS / filename),
                               str(root), str(output)], text=True, capture_output=True, timeout=30)

    def fixture(self, root):
        for package in PACKAGES:
            exposed = 'P.Public P.Implicit P.Missing P.Internal.Hidden GHC.Hidden' if package == PACKAGES[0] else ''
            write(root, f'{package}/{package}.cabal', f'name: {package}\nlibrary\n  exposed-modules: {exposed}\n  default-language: GHC2021\n')
        write(root, 'cloudflare-workers/src/Public.hs', '''module P.Public
  ( Choice(..), Explicit(A), run, onlyTest, absent, module P.Other, Imported(..), (<>), @ ) where
data Choice = A { field :: Int } | B
data Explicit = A
class Capability a where
  capability :: a -> Bool
run :: Int
run = 1
''')
        write(root, 'cloudflare-workers/src/Implicit.hs', 'module P.Implicit where\nvalue = 1\n')
        write(root, 'cloudflare-workers/src/Hidden.hs', 'module P.Internal.Hidden (secret) where\nsecret = 1\n')
        write(root, 'cloudflare-workers/src/NoModule.hs', 'value = 2\n')
        write(root, 'cloudflare-workers/dist-old/Skip.hs', 'module P.Skip (skip) where\n')
        write(root, 'examples/app/Main.hs', 'module Main where\nimport P.Public (run, Choice(..))\nmain = run + field A\n')
        write(root, 'examples/app/test/Check.hs', 'module Check where\nimport P.Public\ncheck = onlyTest\n')
        write(root, 'cloudflare-workers/test/Check.hs', 'module Check where\nimport P.Public\ncheck = onlyTest\n')
        write(root, 'examples/app/worker/generated.ts', 'run();\n')
        for relative in ['examples/app/.hidden/hidden.hs', 'examples/app/node_modules/dep.hs',
                         'examples/app/test-artifacts/old.hs', 'examples/app/dist-old/old.hs',
                         'examples/app/runtime-jsffi.mjs', 'examples/app/worker.d.ts']:
            write(root, relative, 'ignored\n')
        write(root, 'examples/app/README.md', 'not source\n')
        write(root, 'packages/worker-runtime/src/index.ts', '''export function bridge() {}
export interface Options {
  readonly enabled?: boolean;
  nested: { key: string };
}
export type Result = string;
''')
        write(root, 'examples/app/entry.ts', 'import { bridge } from "@cloudflare-workers-hs/runtime";\nbridge();\n')
        write(root, 'packages/worker-runtime/test/contract.mjs', 'import { Options } from "@cloudflare-workers-hs/runtime";\nOptions;\n')
        write(root, 'examples/app/unrelated.ts', 'const Result = "shadow";\n')

    def test_fixture_candidates_keep_runtime_evidence_empty_and_distinguish_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            lexical = root / 'lexical.json'
            expanded = root / 'expanded.json'
            for filename, output in [('api-example-inventory.py', lexical),
                                     ('public-api-operation-inventory.py', expanded)]:
                result = self.run_fixture(filename, root, output)
                self.assertEqual(result.returncode, 0, result.stderr)
            old = json.loads(lexical.read_text())
            statuses = {row['name']: row['status'] for row in old['rows'] if row['module'] == 'P.Public'}
            self.assertEqual(statuses['run'], 'example_source_candidate')
            self.assertEqual(statuses['onlyTest'], 'test_only_candidate')
            self.assertEqual(statuses['absent'], 'no_direct_reference_found')
            self.assertTrue(any(row['module'] == 'P.Implicit' for row in old['unresolved_modules']))
            current = json.loads(expanded.read_text())
            self.assertEqual(current['summary']['verified_rows'], 0)
            self.assertTrue(all(row['execution_status'] == 'unverified' and not row['executed_evidence'] for row in current['rows']))
            rows = {(row['kind'], row['name']) for row in current['rows']}
            self.assertIn(('constructor_candidate', 'B'), rows)
            self.assertIn(('field_or_method_candidate', 'field'), rows)
            self.assertIn(('explicit_member', 'A'), rows)
            self.assertIn(('typescript_field_candidate', 'enabled'), rows)
            self.assertIn(('module_reexport', 'P.Other'), rows)
            self.assertTrue(any('Unparsed export: @' in module['expansion_gaps'] for module in current['modules']))
            self.assertTrue(any(module['module'] == 'P.Internal.Hidden' for module in current['excluded_modules']))
            for relative, digest in current['source_sha256'].items():
                self.assertEqual(digest, hashlib.sha256((root / relative).read_bytes()).hexdigest())
            prior = expanded.read_bytes()
            duplicate = self.run_fixture('public-api-operation-inventory.py', root, expanded)
            self.assertNotEqual(duplicate.returncode, 0)
            self.assertIn('Refusing to overwrite', duplicate.stderr)
            self.assertEqual(expanded.read_bytes(), prior)

    def test_real_repository_cli_produces_a_nonempty_conservative_audit(self):
        with tempfile.TemporaryDirectory() as directory:
            for filename in ['api-example-inventory.py', 'public-api-operation-inventory.py']:
                output = Path(directory) / (filename + '.json')
                result = subprocess.run([sys.executable, str(SCRIPTS / filename), '--output', str(output)],
                                        capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(output.read_text())
                self.assertGreater(len(report['rows']), 100)
                self.assertTrue(any(row['name'] == 'createReactor' for row in report['rows']))
                if 'summary' in report:
                    self.assertEqual(report['summary']['verified_rows'], 0)

    def test_invalid_cli_arguments_fail_before_writing(self):
        for filename in ['api-example-inventory.py', 'public-api-operation-inventory.py']:
            result = subprocess.run([sys.executable, str(SCRIPTS / filename), '--not-a-real-option'],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2)
            self.assertIn('unrecognized arguments', result.stderr)

    def test_lexical_boundaries_preserve_lines_and_constructor_groups(self):
        inventory = load_inventory('api-example-inventory.py')
        self.assertEqual(inventory.module_exports('value = 1'), None)
        self.assertEqual(inventory.module_exports('module P.Open where'), ('P.Open', None))
        with self.assertRaisesRegex(ValueError, 'Unclosed export list'):
            inventory.module_exports('module P.Broken (A(..), run')
        self.assertEqual(inventory.split_exports('A(..), (<>), run, '), ['A(..)', '(<>)', 'run'])
        original = 'module P.X (run) where\n{- hidden\nblock -}\nrun = "escaped\\\"value" -- hidden\n'
        cleaned = inventory.clean(original)
        self.assertEqual(cleaned.count('\n'), original.count('\n'))
        self.assertNotIn('hidden', cleaned)
        imported, body = inventory.imports_and_body('import qualified P.X as X (\n  A(..), run)\nvalue = X.run\n')
        self.assertEqual(imported, {'P.X'})
        self.assertEqual(body.splitlines()[2], 'value = X.run')
        operation = load_inventory('public-api-operation-inventory.py')
        declarations = operation.declarations('''data Box a where
  Box :: a -> Box a
class Capability a where
  capability :: a -> Bool
newtype Wrapper = Wrapper { unwrap :: Int }
''')
        self.assertIn('Box', declarations['Box'][0])
        self.assertIn('capability', declarations['Capability'][1])
        self.assertIn('unwrap', declarations['Wrapper'][1])

    def test_unittest_cli_selects_a_single_contract(self):
        result = subprocess.run([sys.executable, __file__,
                                 'InventoryCliTests.test_invalid_cli_arguments_fail_before_writing'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Ran 1 test', result.stderr)


if __name__ == '__main__':
    unittest.main()
