import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('test_boundaries', Path(__file__).parents[1] / 'test-boundaries.py')
boundaries = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundaries)


class OwnershipTests(unittest.TestCase):
    def check_source(self, name, source):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / name
            file.parent.mkdir(parents=True)
            file.write_text(source)
            return boundaries.violations(root)

    def test_library_contract_cannot_import_an_example(self):
        errors = self.check_source('cloudflare-workers/test/integration/runtime/contract.ts',
                                   "import { worker } from '../../../../examples/minimal/worker/index.ts';")
        self.assertTrue(any('imports an example' in error for error in errors))

    def test_relative_import_cannot_escape_the_repository(self):
        errors = self.check_source(
            'tests/runtime/harness.ts',
            "import { fixture } from '../../../outside/fixture.ts';",
        )

        self.assertEqual(len(errors), 1)
        self.assertIn('import escapes repository', errors[0])

    def test_dependency_and_generated_sources_do_not_create_ownership_violations(self):
        for name in [
            'examples/minimal/node_modules/dependency/index.mjs',
            'examples/minimal/.dev-test-fixture/entry.mjs',
            'examples/minimal/worker/binding.d.ts',
        ]:
            with self.subTest(name=name):
                self.assertEqual(self.check_source(name, 'export {};'), [])

    def test_shared_support_cannot_import_an_example(self):
        errors = self.check_source('scripts/testing/Support/runner.mts',
                                   "import { fixture } from '../../../examples/minimal/test/Support/fixture.ts';")
        self.assertTrue(any('imports an example' in error for error in errors))

    def test_production_cannot_import_test_support(self):
        errors = self.check_source('examples/minimal/worker/index.ts',
                                   "import { fixture } from '../test/Support/fixture.ts';")
        self.assertTrue(any('production imports test support' in error for error in errors))

    def test_composition_can_import_library_fixtures(self):
        self.assertEqual(self.check_source('tests/runtime/harness.ts',
                         "import { fixture } from '../../cloudflare-workers/test/Support/Runtime/fixture.ts';"), [])

    def test_generated_jsffi_is_allowed_but_handwritten_mjs_is_rejected(self):
        self.assertEqual(self.check_source('examples/minimal/worker/minimal-jsffi.mjs', 'export {};'), [])
        self.assertTrue(self.check_source('examples/minimal/test/runner.mjs', 'export {};'))

    def test_library_composition_cannot_compile_example_source_roots(self):
        errors = self.check_source('tests/runtime/runtime-contracts.cabal',
                                   'hs-source-dirs: app, ../../examples/minimal/src')
        self.assertTrue(any('depends on example modules' in error for error in errors))

    def test_library_haskell_fixture_cannot_import_example_modules(self):
        errors = self.check_source('cloudflare-workers/test/Support/Probe.hs',
                                   'import ApiCatalog.API qualified as API')
        self.assertTrue(any('imports an example module' in error for error in errors))
