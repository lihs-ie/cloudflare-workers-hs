"""Public artifact rejection contracts for coverage scope and provenance."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from Support.coverage_evidence import apply_scope, validate_generated_bundle, javascript_evidence


class EvidenceRejectionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / 'basis').write_text('reviewed basis')

    def test_scope_rejects_unjustified_or_mismatched_classification(self):
        source = {'path': 'src/example.ts', 'language': 'javascript'}
        valid = {'path': source['path'], 'reason': 'generated output', 'evidence': 'basis', 'kind': 'generated'}
        cases = [
            ({**valid, 'reason': ''}, 'requires reason'),
            ({**valid, 'evidence': 'missing'}, 'existing repository file'),
            ({**valid, 'evidence_sha256': 'changed'}, 'fingerprint changed'),
            ({**valid, 'kind': 'untestable'}, 'Only generated/external'),
            ({**valid, 'provenance_format': 'unknown'}, 'Unknown generated'),
        ]
        for entry, message in cases:
            with self.subTest(entry=entry), self.assertRaisesRegex(ValueError, message):
                apply_scope(self.root, [source.copy()], {'exclusions': [entry]})
        for kind, language, message in [('haskell-reexport', 'javascript', 'Invalid compile'), ('declaration', 'javascript', 'ambient declaration')]:
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, message):
                apply_scope(self.root, [{**source, 'language': language}], {'validations': [{**valid, 'kind': kind}]})
        entry = {**valid, 'evidence_sha256': hashlib.sha256((self.root / 'basis').read_bytes()).hexdigest()}
        applied = source.copy()
        apply_scope(self.root, [applied], {'exclusions': [entry]})
        self.assertEqual(applied['required_runtimes'], [])

    def test_generated_bundle_rejects_each_broken_link_in_build_provenance(self):
        bundle = self.root / 'bundle.js'
        mapping = self.root / 'bundle.js.map'
        log = self.root / 'build.log'
        bundle.write_text('export {};\n//# sourceMappingURL=bundle.js.map\n')
        map_data = {'version': 3, 'mappings': 'AAAA', 'sources': ['input.ts'], 'sourcesContent': ['export {};']}
        mapping.write_text(json.dumps(map_data))
        log.write_text('wrangler deploy --dry-run succeeded')
        sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        proof = {'schema': 1, 'kind': 'generated', 'artifact': bundle.name,
                 'files': {bundle.name: sha(bundle), mapping.name: sha(mapping)},
                 'sourceMap': {'path': mapping.name, 'sources': [{'name': 'input.ts', 'embeddedSourceSha256': hashlib.sha256(b'export {};').hexdigest()}]},
                 'buildEvidence': {'path': log.name, 'sha256': sha(log), 'successfulMarker': 'wrangler deploy --dry-run succeeded'}}
        path = self.root / 'proof.json'
        path.write_text(json.dumps(proof))
        validate_generated_bundle(self.root, bundle.name, path)
        mutations = [
            ('artifact mismatch', lambda p: p.update(artifact='other.js'), 'does not match'),
            ('no fingerprints', lambda p: p.update(files={}), 'requires file fingerprints'),
            ('changed fingerprint', lambda p: p['files'].update({'bundle.js': 'bad'}), 'Changed generated'),
            ('missing map', lambda p: p['files'].pop(mapping.name), 'Source map fingerprint missing'),
            ('embedded mismatch', lambda p: p['sourceMap'].update(sources=[]), 'embedded sources changed'),
            ('missing success', lambda p: p['buildEvidence'].update(successfulMarker=''), 'successful build evidence missing'),
            ('not dry run', lambda p: p['buildEvidence'].update(successfulMarker='succeeded'), 'successful build evidence missing'),
        ]
        for label, mutate, message in mutations:
            changed = copy.deepcopy(proof)
            mutate(changed)
            path.write_text(json.dumps(changed))
            with self.subTest(label=label), self.assertRaisesRegex(ValueError, message):
                validate_generated_bundle(self.root, bundle.name, path)
        for replacement, message in [({**map_data, 'mappings': '!'}, 'Invalid generated source map'), ({**map_data, 'sourcesContent': []}, 'embedded sources changed')]:
            mapping.write_text(json.dumps(replacement))
            changed = copy.deepcopy(proof)
            changed['files'][mapping.name] = sha(mapping)
            path.write_text(json.dumps(changed))
            with self.subTest(map=replacement), self.assertRaisesRegex(ValueError, message):
                validate_generated_bundle(self.root, bundle.name, path)
        mapping.write_text(json.dumps(map_data))
        bundle.write_text('export {};')
        proof['files'][bundle.name] = sha(bundle)
        path.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, 'source map reference missing'):
            validate_generated_bundle(self.root, bundle.name, path)

    def test_javascript_rejects_invalid_counts_and_branch_shape(self):
        location = {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 1}}
        entry = {'path': 'a.js', 'statementMap': {'0': location}, 's': {'0': 1},
                 'branchMap': {'0': {'locations': [location, location]}}, 'b': {'0': [1, 0]}, 'fnMap': {}, 'f': {}}
        path = self.root / 'coverage.json'
        for replacement, message in [({'s': {'0': True}}, 'Invalid Istanbul count'), ({'b': {'0': 1}}, 'branch arity'), ({'b': {'0': [1]}}, 'branch arity'), ({'s': {}}, 'map/count pairs')]:
            path.write_text(json.dumps({'a.js': {**entry, **replacement}}))
            with self.subTest(replacement=replacement), self.assertRaisesRegex(ValueError, message):
                javascript_evidence(self.root, [path])
        path.write_text(json.dumps({'a.js': entry}))
        merged = javascript_evidence(self.root, [path, path])
        self.assertEqual(merged['a.js']['metrics']['branches']['covered'], 1)

    def test_compile_proof_requires_complete_inventory_and_validated_list(self):
        from Support.coverage_evidence import compile_evidence, compiler_config_dependencies
        (self.root / 'types.d.ts').write_text('declare const x: number;')
        (self.root / 'tsconfig.json').write_text('{}')
        source = {'path': 'types.d.ts', 'language': 'javascript'}
        apply_scope(self.root, [source], {'validations': [{'path': 'types.d.ts', 'kind': 'declaration', 'reason': 'ambient', 'evidence': 'basis'}]})
        proof = {'sources': {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in ['types.d.ts', 'tsconfig.json', 'basis']},
                 'commands': [{'argv': ['tsc', '-p', 'tsconfig.json'], 'cwd': '.', 'exitCode': 0, 'inputs': ['types.d.ts']}],
                 'validated': [{'path': 'types.d.ts', 'kind': 'declaration', 'commandIndex': 0}]}
        path = self.root / 'proof.json'
        for label, mutate, message in [
            ('failed overall', lambda p: p.update(exit_code=1), 'failed validation'),
            ('invalid overall type', lambda p: p.update(exit_code=False), 'failed validation'),
            ('missing inventory', lambda p: p['sources'].pop('types.d.ts'), 'every inventory source'),
            ('invalid validated', lambda p: p.update(validated={}), 'requires validated paths'),
        ]:
            changed = copy.deepcopy(proof)
            mutate(changed)
            path.write_text(json.dumps(changed))
            with self.subTest(label=label), self.assertRaisesRegex(ValueError, message):
                compile_evidence(self.root, [source], path)
        (self.root / 'tsconfig.json').write_text('{"extends": ["./base", "./base.json"]}')
        (self.root / 'base.json').write_text('{}')
        self.assertEqual(compiler_config_dependencies(self.root, proof['commands'][0]), {'tsconfig.json', 'base.json'})
        with self.assertRaisesRegex(ValueError, 'argument is missing'):
            compiler_config_dependencies(self.root, {'argv': ['tsc', '--project'], 'cwd': '.'})

    def test_native_empty_and_scope_configuration_paths(self):
        from Support.coverage_evidence import native_compile_evidence, shell_evidence, python_evidence
        self.assertEqual(native_compile_evidence(self.root, [], None), {})
        self.assertEqual(shell_evidence(self.root, None), {})
        self.assertEqual(python_evidence(self.root, None), {})
        for name in ['cabal.project', 'cloudflare-workers/cloudflare-workers.cabal', 'scripts/testing/runtime-scope.json']:
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('configuration')
        proof = {'errors': [], 'commands': [{'exitCode': 0}], 'sources': {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in ['cabal.project', 'cloudflare-workers/cloudflare-workers.cabal']}}
        path = self.root / 'native.json'
        path.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, 'omits sources or configurations'):
            native_compile_evidence(self.root, [], path)
        proof['sources']['scripts/testing/runtime-scope.json'] = hashlib.sha256((self.root / 'scripts/testing/runtime-scope.json').read_bytes()).hexdigest()
        path.write_text(json.dumps(proof))
        self.assertEqual(native_compile_evidence(self.root, [], path), {})
        path.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Invalid kcov'):
            shell_evidence(self.root, path)

    def test_default_and_generated_scope_registration(self):
        entries = [{'path': 'tools/check.py', 'language': 'python'}, {'path': 'tools/build.sh', 'language': 'shell'}]
        apply_scope(self.root, entries)
        self.assertEqual([entry['required_runtimes'] for entry in entries], [['python'], ['shell']])
        source = {'path': 'out.js', 'language': 'javascript'}
        (self.root / 'generated.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'provenance does not match'):
            apply_scope(self.root, [source], {'exclusions': [{'path': 'out.js', 'reason': 'generated', 'evidence': 'generated.json', 'kind': 'generated', 'provenance_format': 'wrangler-bundle-v1'}]})

    def test_source_inventory_tracks_git_files_and_ignores_documentation(self):
        import subprocess
        from Support.coverage_evidence import repository_source_snapshot
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / '.gitignore').write_text('ignored\n')
        (self.root / 'ignored').write_text('ignored evidence')
        (self.root / 'README.md').write_text('documentation')
        (self.root / 'docs').mkdir()
        (self.root / 'docs/note.md').write_text('documentation')
        (self.root / 'program.py').write_text('print(1)')
        subprocess.run(['git', '-C', str(self.root), 'add', 'program.py'], check=True)
        snapshot = repository_source_snapshot(self.root)
        self.assertEqual(set(snapshot), {'program.py', '.gitignore', 'basis'})
        self.assertEqual(snapshot['program.py'], hashlib.sha256(b'print(1)').hexdigest())

    def test_hpc_lines_use_lowest_spanning_expression_hit_and_bindings_are_top_level(self):
        from Support.coverage_evidence import hpc_lines, hpc_bindings, host_projection_proof
        mix = '[(1:1-2:4,ExpBox False),(2:1-2:5,ExpBox True),(2:1-2:5,BinBox CondBinBox True),(1:1-2:5,TopLevelBox ["main"]),(1:1-2:5,TopLevelBox ["outer","inner"])]'
        record = 'TixModule "Main" 1 5 [3,0,2,4,9]'
        metrics, lines = hpc_lines(mix, record)
        self.assertEqual(lines, {'1': 3, '2': 0})
        self.assertEqual(metrics['covered'], 1)
        self.assertEqual(metrics['total'], 2)
        self.assertEqual(hpc_bindings(mix, record), [{'name': 'main', 'hits': 4}])
        self.assertEqual(host_projection_proof(self.root, None), {})

    def test_different_javascript_maps_and_unknown_hpc_package_cannot_be_merged(self):
        from Support.coverage_evidence import hpc_source_candidates
        location = {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 1}}
        entry = {'path': 'a.js', 'statementMap': {'0': location}, 's': {'0': 1}, 'branchMap': {}, 'b': {}, 'fnMap': {}, 'f': {}}
        first, second = self.root / 'one.json', self.root / 'two.json'
        first.write_text(json.dumps({'a.js': entry}))
        changed = copy.deepcopy(entry)
        changed['statementMap']['0']['end']['column'] = 2
        second.write_text(json.dumps({'a.js': changed}))
        with self.assertRaisesRegex(ValueError, 'different Istanbul instrumentation'):
            javascript_evidence(self.root, [first, second])
        sources = [{'path': 'src/A.hs', 'language': 'haskell', 'module': 'A', 'package': 'known', 'package_root': '.'},
                   {'path': 'test/B.hs', 'language': 'haskell', 'module': 'B'}]
        self.assertEqual(hpc_source_candidates(self.root, sources, 'unknown-1/A', ['src/A.hs']), [sources[0]])
