"""Side-effect-free fixtures for the coverage parser and actual HPC union semantics."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('coverage_report', Path(__file__).parents[1] / 'coverage.py')
coverage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(coverage)


class CoverageChecks(unittest.TestCase):
    def test_boolean_requires_both_outcomes(self):
        xml = '<coverage><module name="A"><exprs boxes="2" count="2"/><booleans boxes="3" count="3" true="1" false="1"/><alts boxes="0" count="0"/></module></coverage>'
        result = coverage.metrics(xml)['A']
        self.assertEqual(result['booleans']['covered'], 1)
        self.assertEqual(result['booleans']['total'], 3)
        self.assertIsNone(result['alts']['percent'])

    def test_tix_rejects_truncated_data(self):
        with self.assertRaises(ValueError):
            coverage.parse_tix('Tix [TixModule "A" 123 2 [1]]')
        with self.assertRaises(ValueError):
            coverage.parse_tix('Tix []')
        with self.assertRaises(ValueError):
            coverage.parse_tix('Tix [TixModule "A" 123 1 [1]] garbage')

    def test_union_preserves_modules_and_sums_ticks(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            left, right, result = [directory / name for name in ('left.tix', 'right.tix', 'sum.tix')]
            left.write_text('Tix [TixModule "A" 123 2 [1,0]]')
            right.write_text('Tix [TixModule "A" 123 2 [0,2],TixModule "B" 456 1 [1]]')
            coverage.run(['hpc', 'sum', '--union', f'--output={result}', str(left), str(right)])
            records = coverage.parse_tix(result.read_text())
            self.assertEqual([record[0] for record in records], ['A', 'B'])
            self.assertIn('[1,2]', records[0][3])

    def test_hpc_main_union_requires_same_qualified_component_and_runtime(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            coverage.run(['git', 'init', '--quiet', str(directory)])
            (directory / 'fixture.cabal').write_text('name: fixture\n')
            decoy = directory / 'other'
            decoy.mkdir()
            (decoy / 'other.cabal').write_text('name: other\n')
            (decoy / 'Main.hs').write_text('main = pure ()\n')
            source = directory / 'Main.hs'
            source.write_text('main = print (if True then 1 else 2)\n')
            mix = directory / 'mix'
            mix.mkdir()
            (mix / 'Main.mix').write_text('Mix ' + json.dumps(str(source)) + ' 2026-09-07 07:50:58.313699322 UTC 2320970064 8 [(1:18-1:21,BinBox CondBinBox True),(1:18-1:21,BinBox CondBinBox False),(1:18-1:21,ExpBox False),(1:28-1:28,ExpBox True),(1:35-1:35,ExpBox True),(1:14-1:36,ExpBox False),(1:8-1:36,ExpBox False),(1:1-1:36,TopLevelBox ["main"])]')
            left, right = directory / 'left.tix', directory / 'right.tix'
            left.write_text('Tix [TixModule "fixture-1.0-inplace-unit/Main" 2320970064 8 [1,0,1,1,0,1,1,1]]')
            right.write_text('Tix [TixModule "fixture-1.0-inplace-unit/Main" 2320970064 8 [0,1,1,0,1,1,1,1]]')
            output = directory / 'coverage.json'
            command = ['python3', str(Path(coverage.__file__).resolve()), '--root', str(directory), '--tix', str(left), '--tix', str(right), '--mix-dir', str(mix), '--output', str(output), '--report-only']
            subprocess.run(command, check=True, capture_output=True)
            report = json.loads(output.read_text())
            self.assertEqual(report['errors'], [])
            self.assertEqual(len(report['host_hpc']), 1)
            self.assertEqual(report['host_hpc'][0]['metrics']['booleans']['covered'], 1)
            self.assertEqual(report['host_hpc'][0]['sources'], ['Main.hs'])
            self.assertEqual(report['host_hpc'][0]['bindings'], [{'name': 'main', 'hits': 2}])
            single_host = command.copy()
            index = single_host.index(str(right))
            del single_host[index - 1:index + 1]
            subprocess.run(single_host + ['--wasm-tix', str(right), '--wasm-mix-dir', str(mix)], check=True, capture_output=True)
            separated = json.loads(output.read_text())
            self.assertEqual(separated['errors'], [])
            self.assertEqual(separated['host_hpc'][0]['metrics']['booleans']['covered'], 0)
            self.assertEqual(separated['wasm_hpc'][0]['metrics']['booleans']['covered'], 0)
            subprocess.run(command + ['--wasm-tix', str(left), '--wasm-tix', str(right), '--wasm-mix-dir', str(mix)], check=True, capture_output=True)
            combined = json.loads(output.read_text())
            self.assertEqual(combined['errors'], [])
            self.assertEqual(len(combined['wasm_hpc']), 1)
            self.assertEqual(combined['wasm_hpc'][0]['metrics']['booleans']['covered'], 1)
            self.assertEqual(len(combined['host_hpc']), 1)
            right.write_text(right.read_text().replace('inplace-unit/Main', 'inplace-other/Main'))
            subprocess.run(command, check=True, capture_output=True)
            different = json.loads(output.read_text())
            self.assertEqual(len(different['host_hpc']), 2)
            self.assertTrue(all(module['metrics']['booleans']['covered'] == 0 for module in different['host_hpc']))
            left.write_text(left.read_text().replace('fixture-1.0-inplace-unit/Main', 'Main'))
            right.write_text(right.read_text().replace('fixture-1.0-inplace-other/Main', 'Main'))
            subprocess.run(command, check=True, capture_output=True)
            unnamed = json.loads(output.read_text())
            self.assertEqual(len(unnamed['host_hpc']), 2)
            self.assertTrue(all(module['metrics']['booleans']['covered'] == 0 for module in unnamed['host_hpc']))
            conflicting = directory / 'conflicting'
            conflicting.mkdir()
            (conflicting / 'Main.mix').write_text((mix / 'Main.mix').read_text().replace(str(source), str(decoy / 'Main.hs')))
            subprocess.run(command + ['--mix-dir', str(conflicting)], check=True, capture_output=True)
            rejected = json.loads(output.read_text())
            self.assertTrue(any('Conflicting mix' in error for error in rejected['errors']))




    def test_istanbul_complementary_reports_pass_and_missing_branch_fails(self):
        import copy
        import json
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            coverage.run(['git', 'init', '--quiet', str(directory)])
            source = directory / 'worker.js'
            source.write_text('export const f = x => x ? 1 : 2;\n')
            location = {'start': {'line': 1, 'column': 0}, 'end': {'line': 1, 'column': 30}}
            entry = {'path': str(source), 'statementMap': {'0': location}, 's': {'0': 1}, 'fnMap': {}, 'f': {}, 'branchMap': {'0': {'locations': [location, location]}}, 'b': {'0': [1, 0]}}
            left, right = directory / 'left.json', directory / 'right.json'
            left.write_text(json.dumps({str(source): entry}))
            other = copy.deepcopy(entry)
            other['b']['0'] = [0, 1]
            right.write_text(json.dumps({str(source): other}))
            output = directory / 'coverage.json'
            command = ['python3', str(Path(coverage.__file__).resolve()), '--root', str(directory), '--istanbul', str(left), '--output', str(output)]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
            self.assertEqual(subprocess.run(command + ['--istanbul', str(right)], capture_output=True).returncode, 0)
            report = json.loads(output.read_text())
            self.assertTrue(report['complete'])
            self.assertEqual(report['unmeasured_sources'], [])
            other['statementMap']['0']['start']['line'] = 2
            right.write_text(json.dumps({str(source): other}))
            self.assertEqual(subprocess.run(command + ['--istanbul', str(right)], capture_output=True).returncode, 1)

    def test_support_is_host_only_and_exclusions_require_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            sources = [{'path': 'pkg/test/Support/Example.hs', 'language': 'haskell'}, {'path': 'pkg/src/Example.hs', 'language': 'haskell'}]
            coverage.apply_scope(directory, sources)
            self.assertEqual(sources[0]['required_runtimes'], ['host'])
            self.assertEqual(sources[1]['required_runtimes'], ['host', 'wasm'])
            with self.assertRaises(ValueError):
                coverage.apply_scope(directory, sources, {'exclusions': [{'path': sources[0]['path'], 'kind': 'generated', 'reason': 'generated'}]})
            (directory / 'provenance.md').write_text('Generated by fixture generator for this parser test.')
            coverage.apply_scope(directory, sources, {'exclusions': [{'path': sources[0]['path'], 'kind': 'generated', 'reason': 'fixture generation', 'evidence': 'provenance.md'}]})
            self.assertEqual(sources[0]['required_runtimes'], [])

    def test_inventory_includes_module_typescript_and_classifies_declarations(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            coverage.run(['git', 'init', '--quiet', str(directory)])
            names = ['vitest.config.mts', 'build-manifest.mts', 'runtime.cts', 'worker.d.ts', 'ffi.d.mts', 'ambient.d.cts']
            for name in names:
                (directory / name).write_text('export {};\n')
            sources = {source['path']: source for source in coverage.inventory(directory)}
            self.assertEqual(set(sources), set(names))
            for name in names:
                self.assertEqual(sources[name]['language'], 'javascript')
            for name in ['worker.d.ts', 'ffi.d.mts', 'ambient.d.cts']:
                self.assertEqual(sources[name]['source_kind'], 'type-declaration')
                self.assertEqual(sources[name]['provenance_status'], 'requires-manifest')
                self.assertNotIn('exclusion', sources[name])
            self.assertEqual(sources['build-manifest.mts']['source_kind'], 'executable-or-configuration')

    def test_missing_evidence_is_failure_and_report_only_is_explicit(self):
        import json
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            coverage.run(['git', 'init', '--quiet', str(directory)])
            (directory / 'Example.hs').write_text('module Example where\nx = 1\n')
            output = directory / 'coverage.json'
            command = ['python3', str(Path(coverage.__file__).resolve()), '--root', str(directory), '--output', str(output)]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
            report = json.loads(output.read_text())
            self.assertFalse(report['complete'])
            self.assertEqual(report['unmeasured_sources'], ['Example.hs'])
            self.assertEqual(subprocess.run(command + ['--report-only'], capture_output=True).returncode, 0)
            self.assertFalse(json.loads(output.read_text())['complete'])


if __name__ == '__main__':
    unittest.main()
