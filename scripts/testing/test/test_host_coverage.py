import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from Support import host_coverage as host


class HostCoverageTests(unittest.TestCase):
    def test_counter_rejections(self):
        for text in ['Tix []', 'Tix [TixModule "A" 1 2 [1]]', 'junk', 'Tix [TixModule \"A\" 1 1 [1 2]]', 'Tix [TixModule \"A\" 1 1 [1,]]', 'Tix [TixModule \"A\" 1 1 [1] TixModule \"B\" 2 1 [1]]', 'Tix [TixModule "../A" 1 1 [1]]', 'Tix [TixModule "A" 1 1 [1],TixModule "A" 1 1 [1]]']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                host.counters(text)
        self.assertEqual(host.counters('Tix [TixModule "p/A" 1 1 [1]]'), [('p/A', '1', 1)])

    def test_summary_requires_single_nonempty_success(self):
        self.assertTrue(host.summary('Passed: 3\nFailed: 0\n'))
        for text in ['', 'Passed: 0\nFailed: 0', 'Passed: 2\nFailed: 1', 'Passed: 2\nPassed: 1\nFailed: 0']:
            self.assertFalse(host.summary(text))

    def test_collect_contract_and_failures(self):
        for mode in ['success', 'exit', 'empty', 'missing', 'malformed', 'stale', 'unlisted', 'source', 'ambiguous', 'mix-count', 'build', 'timeout', 'spawn']:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve(); build = root / 'build'; output = root / 'evidence'
                package = root / 'pkg'; package.mkdir(); (package / 'pkg.cabal').write_text('name: pkg\n')
                binary = build / 'bin'; binary.parent.mkdir(); binary.write_text('binary')
                cache = build / 'cache'; cache.mkdir()
                (cache / 'plan.json').write_text(json.dumps({'compiler-id': 'ghc-9.14.1', 'install-plan': [{'pkg-name': 'pkg', 'component-name': 'test:unit', 'pkg-src': {'type': 'local', 'path': str(package)}, 'bin-file': str(binary)}]}))
                mix = build / 'A.mix'; mix.write_text('Mix "A.hs" 2026-01-01 00:00:00 UTC 1 8 [(1:1-1:2,ExpBox False)]')
                if mode == 'ambiguous':
                    second = build / 'other'; second.mkdir(); (second / 'A.mix').write_text(mix.read_text().replace('A.hs', 'B.hs'))
                if mode == 'mix-count':
                    mix.write_text('Mix "A.hs" 2026-01-01 00:00:00 UTC 1 8 []')
                seen = []
                def execute(argv, **kwargs):
                    seen.append((argv, kwargs))
                    if mode == 'timeout':
                        raise subprocess.TimeoutExpired(argv, 1200, output=b'partial output')
                    if mode == 'spawn':
                        raise OSError('missing cabal')
                    if '--numeric-version' in argv:
                        return subprocess.CompletedProcess(argv, 0, '9.14.1')
                    if argv[:2] == ['cabal', 'list-bin']:
                        if mode == 'stale':
                            (output / 'suite-0.tix').write_text('stale')
                        return subprocess.CompletedProcess(argv, 0, str(binary))
                    if argv[0] == str(binary):
                        self.assertEqual(kwargs['cwd'], package)
                        self.assertEqual(kwargs['env']['SYDTEST_SEED'], '42')
                        self.assertEqual(kwargs['env']['pkg_datadir'], str(package))
                        self.assertEqual(argv[1:], ['--match', 'some test'])
                        if mode != 'missing':
                            Path(kwargs['env']['HPCTIXFILE']).write_text('bad' if mode == 'malformed' else 'Tix [TixModule "pkg/A" 1 1 [2]]')
                        if mode == 'unlisted':
                            (output / 'mix').mkdir(); (output / 'mix/extra.mix').write_text('injected')
                        return subprocess.CompletedProcess(argv, 1 if mode == 'exit' else 0, 'Passed: 0\nFailed: 0' if mode == 'empty' else 'Passed: 1\nFailed: 0')
                    return subprocess.CompletedProcess(argv, 1 if mode == 'build' else 0, '')
                snapshots = iter([{'source': 'a'}, {'source': 'b' if mode == 'source' else 'a'}])
                with patch.object(host.subprocess, 'run', side_effect=execute):
                    proof = host.collect(root, output, ['pkg:test:unit'], lambda: next(snapshots), match='some test', build_directory=build, environment={'SYDTEST_SEED': '42'})
                self.assertEqual(proof['exit_code'], 0 if mode == 'success' else 1, proof['errors'])
                self.assertEqual(bool(proof['errors']), mode != 'success')
                if mode == 'success':
                    self.assertEqual(set(proof['snapshots']), {'suite-0.tix'})
                    self.assertEqual(set(proof['mixFiles']), {'mix/1/pkg/A.mix'})
                with self.assertRaises(FileExistsError):
                    host.collect(root, output, [], lambda: {})

    def test_plan_environment_and_provenance_contracts(self):
        modes = ['success', 'missing-compiler', 'plan-compiler', 'external-package',
                 'no-cabal', 'many-cabal', 'many-data', 'external-data', 'kind',
                 'duplicate-component', 'missing-component', 'remote-suite',
                 'binary-plan', 'binary-missing', 'binary-external', 'compiler-change',
                 'timeout-text', 'timeout-empty', 'empty-targets', 'duplicate-targets',
                 'tix-symlink', 'ffi-existing', 'ffi-empty', 'no-match']
        for mode in modes:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                build = root / 'build'
                build.mkdir()
                output = root / 'proof'
                package = root / 'pkg'
                package.mkdir()
                cabal = package / 'pkg.cabal'
                cabal.write_text('name: pkg\ndata-dir: data\n')
                compiler = root / 'ghc'
                compiler.write_text('compiler')
                binary = build / 'unit'
                binary.write_text('binary')
                entry = {'pkg-name': 'pkg', 'component-name': 'test:unit',
                         'pkg-src': {'type': 'local', 'path': str(package)},
                         'bin-file': str(binary)}
                plan = {'compiler-id': 'ghc-9.14.1', 'install-plan': [entry, {'pkg-name': 'base', 'pkg-src': {'type': 'repo-tar'}}]}
                if mode == 'plan-compiler':
                    plan['compiler-id'] = 'ghc-0.0'
                if mode == 'external-package':
                    entry['pkg-src']['path'] = str(root.parent)
                if mode == 'no-cabal':
                    cabal.unlink()
                if mode == 'many-cabal':
                    (package / 'second.cabal').write_text('name: second')
                if mode == 'many-data':
                    cabal.write_text('data-dir: a\ndata-dir: b\n')
                if mode == 'external-data':
                    cabal.write_text('data-dir: ..\n')
                if mode == 'duplicate-component':
                    plan['install-plan'].append(dict(entry))
                if mode == 'missing-component':
                    entry['component-name'] = 'test:other'
                if mode == 'remote-suite':
                    entry['pkg-src']['type'] = 'repo-tar'
                if mode == 'binary-plan':
                    entry['bin-file'] = str(build / 'other')
                if mode == 'binary-missing':
                    binary.unlink()
                if mode == 'binary-external':
                    binary = root / 'external'
                    binary.write_text('binary')
                    entry['bin-file'] = str(binary)
                cache = build / 'cache'
                cache.mkdir()
                (cache / 'plan.json').write_text(json.dumps(plan))
                (build / 'A.mix').write_text('Mix "A.hs" 2026-01-01 00:00:00 UTC 1 8 [(1:1-1:2,ExpBox False)]')
                environment = {'HPCTIXFILE': 'inherited', 'GHCRTS': '-bad', 'C_INCLUDE_PATH': 'existing'}
                if mode == 'ffi-empty':
                    environment.pop('C_INCLUDE_PATH')
                seen = []

                def execute(argv, **kwargs):
                    seen.append(argv)
                    self.assertNotIn('GHCRTS', kwargs['env'])
                    if '--numeric-version' in argv:
                        if mode.startswith('timeout-'):
                            raise subprocess.TimeoutExpired(argv, 1200, output='partial text' if mode == 'timeout-text' else None)
                        return subprocess.CompletedProcess(argv, 0, '9.14.1')
                    if argv[:2] == ['cabal', 'list-bin']:
                        return subprocess.CompletedProcess(argv, 0, str(binary))
                    if argv[0] == str(binary):
                        self.assertEqual(kwargs['env']['pkg_datadir'], str(package / 'data'))
                        self.assertEqual(argv[1:], [] if mode == 'no-match' else ['--match', 'probe'])
                        expected_include = 'existing'
                        if mode in ('ffi-existing', 'ffi-empty'):
                            expected_include = '/opt/homebrew/opt/libffi/include' + (host.os.pathsep + 'existing' if mode == 'ffi-existing' else '')
                        self.assertEqual(kwargs['env']['C_INCLUDE_PATH'], expected_include)
                        tix = Path(kwargs['env']['HPCTIXFILE'])
                        if mode == 'tix-symlink':
                            original = root / 'original.tix'
                            original.write_text('Tix [TixModule "pkg/A" 1 1 [1]]')
                            tix.symlink_to(original)
                        else:
                            tix.write_text('Tix [TixModule "pkg/A" 1 1 [1]]')
                        if mode == 'compiler-change':
                            compiler.write_text('changed')
                        return subprocess.CompletedProcess(argv, 0, 'Passed: 1\nFailed: 0\n')
                    self.assertNotIn('HPCTIXFILE', kwargs['env'])
                    return subprocess.CompletedProcess(argv, 0, '')

                targets = ['pkg:exe:unit' if mode == 'kind' else 'pkg:test:unit']
                if mode == 'empty-targets':
                    targets = []
                if mode == 'duplicate-targets':
                    targets *= 2
                original_is_dir = Path.is_dir
                def is_dir(path):
                    if str(path) == '/opt/homebrew/opt/libffi/include':
                        return mode in ('ffi-existing', 'ffi-empty')
                    return original_is_dir(path)
                with patch.object(host.shutil, 'which', return_value=None if mode == 'missing-compiler' else str(compiler)), patch.object(host.subprocess, 'run', side_effect=execute), patch.object(Path, 'is_dir', is_dir):
                    # Only the optional libffi location is simulated; ordinary
                    # fixture paths must retain their real filesystem meaning.
                    self.assertTrue(package.is_dir())
                    self.assertFalse((package / 'missing-child').is_dir())
                    proof = host.collect(root, output, targets, lambda: {'source': 'same'}, match=None if mode == 'no-match' else 'probe', build_directory=build, environment=environment)
                success = mode in ('success', 'ffi-existing', 'ffi-empty', 'no-match')
                self.assertEqual(proof['exit_code'], 0 if success else 1, proof)
                self.assertEqual(bool(proof['errors']), not success)
                self.assertEqual(json.loads((output / 'proof.json').read_text()), proof)
                if mode.startswith('timeout-'):
                    self.assertEqual(proof['commands'][0]['exitCode'], 124)
                    self.assertIn('timed out', (output / 'compiler.log').read_text())
                self.assertEqual(environment['GHCRTS'], '-bad')

    def test_copy_mix_rejects_conflicting_destination_and_accepts_identical(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidate = root / 'A.mix'
            candidate.write_text('Mix "A.hs" 2026-01-01 00:00:00 UTC 1 8 [(1:1-1:2,ExpBox False)]')
            output = root / 'out'
            records = [('pkg/A', '1', 1)]
            first = host.copy_mix(records, [candidate], output)
            self.assertEqual(host.copy_mix(records, [candidate], output), first)
            destination = output / next(iter(first))
            destination.write_text('conflicting prior suite')
            with self.assertRaisesRegex(ValueError, 'Conflicting copied mix'):
                host.copy_mix(records, [candidate], output)

    def test_mix_selection_ignores_other_modules_and_fingerprints(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            candidates = []
            for directory, name, content in [
                ('other', 'B.mix', 'not parsed'),
                ('malformed', 'A.mix', 'invalid mix'),
                ('old', 'A.mix', 'Mix "A.hs" 2026-01-01 00:00:00 UTC 2 8 []'),
                ('current', 'A.mix', 'Mix "A.hs" 2026-01-01 00:00:00 UTC 1 8 [(1:1-1:2,ExpBox False)]'),
            ]:
                path = root / directory / name
                path.parent.mkdir()
                path.write_text(content)
                candidates.append(path)
            self.assertEqual(set(host.copy_mix([('pkg/A', '1', 1)], candidates, root / 'out')), {'mix/1/pkg/A.mix'})
            with self.assertRaisesRegex(ValueError, 'Missing or ambiguous mix'):
                host.copy_mix([('pkg/A', '1', 1)], candidates[:-1], root / 'missing')
