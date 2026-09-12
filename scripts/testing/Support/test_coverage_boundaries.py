"""Reject evidence that could incorrectly turn an unmeasured source green."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from coverage_evidence import apply_scope, hpc_lines, hpc_bindings, javascript_evidence, python_evidence


class CoverageBoundaryTests(unittest.TestCase):
    def test_runtime_override_requires_repository_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'fixture.cabal').write_text('if arch(wasm32)\n buildable: True\n')
            source = {'path': 'examples/a/test/Support/Coverage.hs', 'language': 'haskell'}
            entry = {'path': source['path'], 'reason': 'WASI-only component', 'evidence': 'fixture.cabal', 'required': ['wasm']}
            sources = [copy.deepcopy(source)]
            apply_scope(root, sources, {'runtimes': [entry]})
            self.assertEqual(sources[0]['required_runtimes'], ['wasm'])
            self.assertEqual(sources[0]['evidence'], {'wasm': {'status': 'unmeasured'}})
            for patch in [{'required': []}, {'required': ['wasm', 'wasm']}, {'required': ['invented']}, {'reason': ''}, {'evidence': 'missing'}, {'path': 'absent.hs'}]:
                with self.subTest(patch=patch), self.assertRaises(ValueError):
                    apply_scope(root, [copy.deepcopy(source)], {'runtimes': [dict(entry, **patch)]})
            with self.assertRaises(ValueError):
                apply_scope(root, [copy.deepcopy(source)], {'exclusions': [dict(entry, kind='authored')]})

    def test_hpc_corrupt_coordinates_and_tick_counts_reject(self):
        for mix, tix in [('(2:1-1:2,ExpBox False)', '[1]'), ('(1:1-100002:2,ExpBox False)', '[1]'), ('(1:1-1:2,ExpBox False)', '[1,2]')]:
            with self.subTest(mix=mix), self.assertRaises(ValueError):
                hpc_lines(mix, tix)
        with self.assertRaises(ValueError):
            hpc_bindings('(1:1-1:2,TopLevelBox ["run"])', '[1,2]')

    def test_istanbul_rejects_outside_sources_missing_maps_and_invalid_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'coverage.json'
            base = {'path': 'a.js', 'statementMap': {}, 's': {}, 'fnMap': {}, 'f': {}, 'branchMap': {}, 'b': {}}
            variants = [dict(base, path='../outside.js'), dict(base, statementMap={'0': {}}), dict(base, fnMap={'0': {}}, f={'0': -1}), dict(base, branchMap={'0': {'locations': [{}, {}]}}, b={'0': [1]})]
            for entry in variants:
                report.write_text(json.dumps({'a.js': entry}))
                with self.subTest(entry=entry), self.assertRaises(ValueError):
                    javascript_evidence(root, [report])

    def test_python_evidence_rejects_missing_source_and_boolean_line_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'a.py').write_text('pass\n')
            report = root / 'coverage.json'
            entry = {'executed_lines': [True], 'missing_lines': [], 'excluded_lines': [], 'executed_branches': [], 'missing_branches': [], 'summary': {'num_statements': 1, 'num_branches': 0}}
            for name in ['a.py', 'missing.py', '../outside.py']:
                report.write_text(json.dumps({'meta': {'branch_coverage': True}, 'files': {name: entry}}))
                with self.subTest(name=name), self.assertRaises(ValueError):
                    python_evidence(root, report)

    def test_exclusion_cannot_point_outside_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            root.mkdir()
            (root.parent / 'outside').write_text('not repository evidence')
            source = {'path': 'generated.js', 'language': 'javascript'}
            entry = {'path': source['path'], 'reason': 'generated', 'evidence': '../outside', 'kind': 'generated'}
            with self.assertRaises(ValueError):
                apply_scope(root, [source], {'exclusions': [entry]})

    def test_istanbul_empty_report_and_noninteger_counts_reject(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            report = root / 'coverage.json'
            for data in [{}, [], {'a.js': {'path': 'a.js', 'statementMap': {'0': {}}, 's': {'0': True}, 'fnMap': {}, 'f': {}, 'branchMap': {}, 'b': {}}}]:
                report.write_text(json.dumps(data))
                with self.subTest(data=data), self.assertRaises(ValueError):
                    javascript_evidence(root, [report])

    def test_manifest_rejects_duplicate_conflicting_and_wrong_language_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'evidence').write_text('reviewed')
            source = {'path': 'code.hs', 'language': 'haskell'}
            entry = {'path': 'code.hs', 'reason': 'native', 'evidence': 'evidence', 'required': ['host']}
            for manifest in [
                {'runtimes': [entry, entry]},
                {'runtimes': [entry], 'exclusions': [dict(entry, kind='generated')]},
                {'runtimes': [dict(entry, required=['javascript'])]},
                {'runtimes': [dict(entry, required='host')]},
                {'runtimes': [dict(entry, required=[[]])]},
                {'runtimes': {}},
                {'runtimes': [None]},
            ]:
                with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                    apply_scope(root, [copy.deepcopy(source)], manifest)

    def test_zero_ticks_and_missing_runtime_never_complete(self):
        from coverage_evidence import full
        self.assertFalse(full({'lines': {'covered': 0, 'total': 0}}))
        self.assertFalse(full({'lines': {'covered': 0, 'total': 1}}))
        with tempfile.TemporaryDirectory() as directory:
            source = {'path': 'a.ts', 'language': 'javascript'}
            apply_scope(Path(directory), [source])
            self.assertEqual(source['evidence'], {'javascript': {'status': 'unmeasured'}})
