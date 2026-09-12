import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from coverage_evidence import apply_scope, compile_evidence, shell_evidence


class CompileEvidenceTests(unittest.TestCase):
    def test_compile_contract_requires_current_inputs_and_never_creates_runtime_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            declaration = root / 'types.d.ts'
            declaration.write_text('declare const value: string;\n')
            (root / 'tsconfig.json').write_text('{}')
            sources = [{'path': 'types.d.ts', 'language': 'javascript'}]
            manifest = {'validations': [{'path': 'types.d.ts', 'kind': 'declaration', 'reason': 'ambient API', 'evidence': 'types.d.ts'}]}
            apply_scope(root, sources, manifest)
            self.assertEqual(sources[0]['evidence'], {'compile': {'status': 'unmeasured'}})
            self.assertEqual(compile_evidence(root, sources, None), {})
            proof = root / 'proof.json'
            valid = {'sources': {'types.d.ts': hashlib.sha256(declaration.read_bytes()).hexdigest(), 'tsconfig.json': hashlib.sha256((root / 'tsconfig.json').read_bytes()).hexdigest()},
                     'commands': [{'argv': ['tsc', '--project', 'tsconfig.json', '--noEmit'], 'cwd': '.', 'exitCode': 0, 'inputs': ['types.d.ts']}],
                     'validated': [{'path': 'types.d.ts', 'kind': 'declaration', 'commandIndex': 0}]}
            proof.write_text(json.dumps(valid))
            result = compile_evidence(root, sources, proof)['types.d.ts']
            self.assertTrue(result['complete'])
            self.assertEqual(result['status'], 'validated')
            self.assertNotIn('metrics', result)
            variants = []
            for key, value in [('sources', {}), ('commands', []), ('validated', valid['validated'] * 2)]:
                variants.append(dict(valid, **{key: value}))
            for patch in [{'exitCode': 1}, {'exitCode': False}, {'inputs': []}, {'argv': []}]:
                variants.append(dict(valid, commands=[dict(valid['commands'][0], **patch)]))
            for patch in [{'path': 'missing'}, {'kind': 'type-contract'}, {'commandIndex': True}, {'commandIndex': 1}]:
                variants.append(dict(valid, validated=[dict(valid['validated'][0], **patch)]))
            for variant in variants:
                proof.write_text(json.dumps(variant))
                with self.subTest(variant=variant), self.assertRaises(ValueError):
                    compile_evidence(root, sources, proof)
            proof.write_text(json.dumps(valid))
            declaration.write_text('declare const changed: number;\n')
            with self.assertRaises(ValueError):
                compile_evidence(root, sources, proof)

    def test_plain_executable_cannot_be_misclassified_as_ambient_declaration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'code.ts').write_text('run();')
            with self.assertRaises(ValueError):
                apply_scope(root, [{'path': 'code.ts', 'language': 'javascript'}], {'validations': [{'path': 'code.ts', 'kind': 'declaration', 'reason': 'wrong', 'evidence': 'code.ts'}]})


class ShellEvidenceTests(unittest.TestCase):
    def test_full_lines_still_require_branch_evidence_and_reject_invalid_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'build.sh'
            source.write_text('#!/bin/sh\necho ready\n')
            report = root / 'coverage.json'
            entry = {'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'lines': {'2': 1}, 'branch_coverage': False}
            valid = {'schema': 1, 'collector': {'name': 'kcov', 'version': '43'}, 'files': {'build.sh': entry}, 'contracts': {'passed': True}}
            report.write_text(json.dumps(valid))
            result = shell_evidence(root, report)['build.sh']
            self.assertEqual(result['metrics']['lines']['percent'], 100)
            self.assertEqual(result['branches']['status'], 'unmeasured')
            self.assertFalse(result['complete'])
            for patch in [{'sha256': 'stale'}, {'branch_coverage': True}, {'lines': {}}, {'lines': {'0': 1}}, {'lines': {'3': 1}}, {'lines': {'02': 1}}, {'lines': {'2': True}}, {'lines': {'2': -1}}]:
                changed = copy.deepcopy(valid)
                changed['files']['build.sh'].update(patch)
                report.write_text(json.dumps(changed))
                with self.subTest(patch=patch), self.assertRaises(ValueError):
                    shell_evidence(root, report)

class CompileConfigurationTests(unittest.TestCase):
    def test_project_extends_and_scope_must_be_fingerprinted_and_current(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {'types.d.ts': 'declare const value: string;', 'tsconfig.json': '{"extends":"./base.json"}', 'base.json': '{"compilerOptions":{"strict":true}}', 'scripts/testing/runtime-scope.json': '{}'}
            for name, text in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text)
            sources = [{'path': 'types.d.ts', 'language': 'javascript'}]
            apply_scope(root, sources, {'validations': [{'path': 'types.d.ts', 'kind': 'declaration', 'reason': 'ambient', 'evidence': 'types.d.ts'}]})
            valid = {'sources': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}, 'commands': [{'argv': ['tsc', '-p', 'tsconfig.json', '--noEmit'], 'cwd': '.', 'exitCode': 0, 'inputs': ['types.d.ts']}], 'validated': [{'path': 'types.d.ts', 'kind': 'declaration', 'commandIndex': 0}]}
            proof = root / 'proof.json'
            proof.write_text(json.dumps(valid))
            self.assertTrue(compile_evidence(root, sources, proof)['types.d.ts']['complete'])
            for omitted in ['tsconfig.json', 'base.json', 'scripts/testing/runtime-scope.json']:
                variant = copy.deepcopy(valid)
                del variant['sources'][omitted]
                proof.write_text(json.dumps(variant))
                with self.subTest(omitted=omitted), self.assertRaises(ValueError):
                    compile_evidence(root, sources, proof)
            proof.write_text(json.dumps(valid))
            (root / 'base.json').write_text('{"files":[]}')
            with self.assertRaises(ValueError):
                compile_evidence(root, sources, proof)

    def test_unresolvable_project_forms_fail_closed(self):
        from coverage_evidence import compiler_config_dependencies
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'tsconfig.json').write_text('{}')
            self.assertEqual(compiler_config_dependencies(root, {'argv': ['tsc', '--project=tsconfig.json'], 'cwd': '.'}), {'tsconfig.json'})
            for command in [{'argv': ['tsc'], 'cwd': '.'}, {'argv': ['tsc', '-p'], 'cwd': '.'}, {'argv': ['tsc', '-p', 'tsconfig.json', '-p', 'tsconfig.json'], 'cwd': '.'}]:
                with self.assertRaises(ValueError):
                    compiler_config_dependencies(root, command)
            for extends in ['package-config', './tsconfig.json', '../outside.json', 123]:
                (root / 'tsconfig.json').write_text(json.dumps({'extends': extends}))
                with self.assertRaises(ValueError):
                    compiler_config_dependencies(root, {'argv': ['tsc', '-p', 'tsconfig.json'], 'cwd': '.'})
