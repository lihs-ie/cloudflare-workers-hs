"""Fault-injection fixtures for registration validation (standard library only)."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('registration', Path(__file__).parents[1] / 'registration.py')
registration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(registration)


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.layer = self.root / 'pkg/test/unit'
        self.layer.mkdir(parents=True)
        self.entry = self.layer / 'HTTPSpec.hs'
        self.entry.write_text('module HTTPSpec where\nimport HTTP.RequestCases qualified as Request\nspec = Request.spec\n')
        child = self.layer / 'HTTP/RequestCases.hs'
        child.parent.mkdir()
        child.write_text('module HTTP.RequestCases where\nspec = pure ()\n')

    def result(self):
        return registration.check(self.root, ['pkg/test/unit'])

    def test_valid_records_identity_not_only_count(self):
        result = self.result()
        self.assertEqual(result['errors'], [])
        self.assertEqual(result['inventory'][0]['children'], ['pkg/test/unit/HTTP/RequestCases.hs'])

    def test_deleted_call(self):
        self.entry.write_text('module HTTPSpec where\nimport HTTP.RequestCases qualified as Request\nspec = pure ()\n')
        self.assertTrue(any('registered 0 times' in error for error in self.result()['errors']))

    def test_duplicate_call(self):
        self.entry.write_text(self.entry.read_text() + '  Request.spec\n')
        self.assertTrue(any('registered 2 times' in error for error in self.result()['errors']))

    def test_orphan(self):
        self.entry.write_text('module HTTPSpec where\nspec = pure ()\n')
        self.assertTrue(any('0 owners' in error for error in self.result()['errors']))

    def test_two_owners(self):
        (self.layer / 'OtherSpec.hs').write_text(self.entry.read_text())
        self.assertTrue(any('2 owners' in error for error in self.result()['errors']))

    def test_javascript_module_extensions_and_hidden_support(self):
        for extension in registration.JS_EXTENSIONS:
            entry = self.layer / ('runtime.spec' + extension)
            child = self.layer / ('runtime.cases' + extension)
            entry.write_text(f'import {{ registerRuntime }} from "./{child.name}";\nregisterRuntime();')
            child.write_text('export function registerRuntime() {}')
            self.assertEqual(self.result()['errors'], [], extension)
            self.assertTrue(any(item['entry'].endswith(entry.name) for item in self.result()['inventory']))
            support = self.layer.parent / 'Support'
            support.mkdir(exist_ok=True)
            hidden = support / entry.name
            hidden.write_text('')
            self.assertTrue(any('forbidden in Support' in error for error in self.result()['errors']))
            hidden.unlink()
            entry.unlink()
            child.unlink()

    def test_missing_layer(self):
        self.assertTrue(registration.check(self.root, ['missing'])['errors'])

    def test_support_cannot_hide_entry(self):
        support = self.layer.parent / 'Support'
        support.mkdir()
        (support / 'HiddenSpec.hs').write_text('spec = pure ()')
        self.assertTrue(any('forbidden in Support' in error for error in self.result()['errors']))

    def test_missing_cabal_module(self):
        (self.root / 'pkg/pkg.cabal').write_text('other-modules: HTTPSpec\n')
        self.assertTrue(any('module absent' in error for error in self.result()['errors']))

    def test_typescript_explicit_registration(self):
        child = self.layer / 'body.cases.ts'
        child.write_text('export function registerBodyCases() {}')
        entry = self.layer / 'body.spec.ts'
        entry.write_text("import { registerBodyCases } from './body.cases';\nregisterBodyCases();\n")
        self.assertEqual(self.result()['errors'], [])
        entry.write_text("import { registerBodyCases } from './body.cases';\n")
        self.assertTrue(any('registered 0 times' in error for error in self.result()['errors']))
        entry.write_text("import { registerBodyCases } from './body.cases';\nregisterBodyCases();\nregisterBodyCases();\n")
        self.assertTrue(any('registered 2 times' in error for error in self.result()['errors']))

    def test_typescript_esm_js_import_resolves_ts_source(self):
        child = self.layer / 'body.cases.ts'
        child.write_text('export function registerBodyCases() {}')
        entry = self.layer / 'body.spec.ts'
        entry.write_text("import { registerBodyCases } from './body.cases.js';\nregisterBodyCases();\n")
        result = self.result()
        self.assertEqual(result['errors'], [])
        ts_entry = next(item for item in result['inventory'] if item['entry'].endswith('.spec.ts'))
        self.assertEqual(ts_entry['children'], ['pkg/test/unit/body.cases.ts'])
        child.unlink()
        self.assertTrue(any('unresolved child' in error for error in self.result()['errors']))

    def test_comments_do_not_count_as_registration(self):
        self.entry.write_text('module HTTPSpec where\nimport HTTP.RequestCases qualified as Request\n-- Request.spec\nspec = pure ()\n')
        self.assertTrue(any('registered 0 times' in error for error in self.result()['errors']))


if __name__ == '__main__':
    unittest.main()
