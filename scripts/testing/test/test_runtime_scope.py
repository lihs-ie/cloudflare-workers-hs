"""Repository fixture runtime assignments must follow the WASI-only Cabal target."""
import json
from pathlib import Path
import unittest

from Support.coverage_evidence import apply_scope


class RuntimeScopeTests(unittest.TestCase):
    def test_runtime_harness_helpers_require_wasm_and_never_pass_without_evidence(self):
        root = Path(__file__).resolve().parents[3]
        manifest = json.loads((root / 'scripts/testing/runtime-scope.json').read_text())
        paths = [
            'cloudflare-workers/test/Support/Runtime/Envelope.hs',
            'cloudflare-workers/test/Support/Runtime/SocketStream.hs',
            'cloudflare-workers/test/Support/Runtime/StorageBoundaries.hs',
            'servant-cloudflare-workers/test/Support/Runtime/Routing.hs',
            'servant-cloudflare-workers-access/test/Support/Runtime/AccessEntrypoints.hs',
            'servant-cloudflare-workers-client/test/Support/Runtime/Client.hs',
        ]
        selected = [entry for entry in manifest['runtimes'] if entry['path'] in paths]
        self.assertEqual({entry['path'] for entry in selected}, set(paths))
        sources = [{'path': path, 'language': 'haskell'} for path in paths]
        apply_scope(root, sources, {'runtimes': selected})
        for source in sources:
            self.assertTrue((root / source['path']).is_file())
            self.assertEqual(source['required_runtimes'], ['wasm'])
            self.assertEqual(source['evidence'], {'wasm': {'status': 'unmeasured'}})
            self.assertEqual(source['runtime_basis']['evidence'], 'tests/runtime/runtime-contracts.cabal')

    def test_cross_example_execution_fixtures_are_not_mistaken_for_host_unit_tests(self):
        root = Path(__file__).resolve().parents[3]
        manifest = json.loads((root / 'scripts/testing/runtime-scope.json').read_text())
        entries = {entry['path']: entry for entry in manifest['runtimes']}
        fixtures = ['examples/api-catalog/test/Support/' + name + '.hs' for name in ['ClientStream', 'Database', 'ApiCatalog/R2Failures', 'SocketFailures', 'Storage']]
        fixtures += ['examples/queued-jobs/test/Support/QueueContracts.hs', 'examples/url-shortener/test/Support/Coverage.hs', 'cloudflare-workers/test/Support/Runtime/DurableObject/SQLChecks.hs', 'cloudflare-workers/test/Support/Runtime/D1QueryFixture.hs', 'examples/workflows/test/Support/WorkflowFixture.hs']
        for path in fixtures:
            self.assertEqual(entries[path]['required'], ['wasm'])
            self.assertTrue(entries[path]['evidence'].endswith('.cabal'))
            self.assertTrue((root / entries[path]['evidence']).is_file())
        for path in ['cloudflare-workers/src/Cloudflare/Workers/Binding/Secret.hs', 'cloudflare-workers/src/Cloudflare/Workers/Binding/Var.hs', 'examples/workflows/src/WorkflowExample/Domain.hs']:
            self.assertEqual(entries[path]['required'], ['host'])

    def test_cache_scenarios_and_executable_host_shim_use_host_evidence(self):
        root = Path(__file__).resolve().parents[3]
        manifest = json.loads((root / 'scripts/testing/runtime-scope.json').read_text())
        entries = {entry['path']: entry for entry in manifest['runtimes']}
        for path in ['servant-cloudflare-workers-access/test/Support/Runtime/JWKSCache.hs',
                     'cloudflare-workers/shim/compat/GHC/Wasm/Prim.hs']:
            self.assertIn('host', entries[path]['required'])
            self.assertNotIn(path, {entry['path'] for entry in manifest['validations']})

    def test_every_authored_reactor_declaration_has_a_compiler_contract(self):
        root = Path(__file__).resolve().parents[3]
        manifest = json.loads((root / 'scripts/testing/runtime-scope.json').read_text())
        declarations = {entry['path'] for entry in manifest['validations'] if entry['kind'] == 'declaration'}
        for directory in ['examples/queued-jobs/worker', 'tests/runtime/worker']:
            for path in (root / directory).glob('*.d.mts'):
                self.assertIn(str(path.relative_to(root)), declarations)
        self.assertIn('tests/runtime/env.d.ts', declarations)
        self.assertIn('tests/runtime/worker/wasm-module.d.ts', declarations)
