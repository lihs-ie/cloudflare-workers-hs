import copy
import unittest
from Support.coverage_evidence import equivalent_hpc_projection


class ProjectionTests(unittest.TestCase):
    def test_only_identical_authenticated_maps_combine(self):
        first = {'source': 'Domain.hs', 'source_sha256': 'source', 'runtime': 'host',
                 'compiler_sha256': 'compiler', 'compiler_version': '9.14.1',
                 'layout': '8 [(1:1-1:2,ExpBox False)]', 'ticks': [0, 2], 'authenticated': True, 'cpp': False}
        second = {**first, 'ticks': [3, 0]}
        self.assertEqual(equivalent_hpc_projection([first, second]), [3, 2])
        self.assertIsNone(equivalent_hpc_projection([first]))
        for key in ['source', 'source_sha256', 'runtime', 'compiler_sha256', 'compiler_version', 'layout', 'authenticated', 'cpp']:
            changed = copy.deepcopy(second)
            changed[key] = not changed[key] if isinstance(changed[key], bool) else 'different'
            with self.subTest(key=key):
                self.assertIsNone(equivalent_hpc_projection([first, changed]))
        with self.assertRaises(ValueError):
            equivalent_hpc_projection([first, {**second, 'ticks': [3]}])

    def test_proof_authenticates_sources_compiler_counters_and_logs(self):
        import hashlib
        import json
        from pathlib import Path
        import tempfile
        from Support.coverage_evidence import host_projection_proof
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            output = root / 'proof'; output.mkdir()
            compiler = root / 'ghc'; compiler.write_text('compiler')
            source = root / 'Domain.hs'; source.write_text('module Domain where')
            (output / 'mix').mkdir()
            (output / 'mix/A.mix').write_text('mix')
            (output / 'test.tix').write_text('tix')
            (output / 'version.log').write_text('9.14.1\n')
            (output / 'build.log').write_text('built')
            sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
            proof = {'exit_code': 0, 'errors': [], 'sources': {'Domain.hs': sha(source)},
                     'compiler': {'path': str(compiler), 'sha256': sha(compiler), 'version': '9.14.1'},
                     'commands': [{'command': [str(compiler), '--numeric-version'], 'exitCode': 0, 'log': 'version.log', 'logSha256': sha(output / 'version.log')},
                                  {'command': ['cabal', 'build', '--with-compiler=' + str(compiler)], 'exitCode': 0, 'log': 'build.log', 'logSha256': sha(output / 'build.log')}],
                     'snapshots': {'test.tix': sha(output / 'test.tix')}, 'mixFiles': {'mix/A.mix': sha(output / 'mix/A.mix')}}
            path = output / 'proof.json'; path.write_text(json.dumps(proof))
            patcher = patch('Support.coverage_evidence.repository_source_snapshot', return_value=proof['sources'])
            patcher.start()
            self.addCleanup(patcher.stop)
            self.assertEqual(host_projection_proof(root, path)['compiler']['version'], '9.14.1')
            with patch('Support.coverage_evidence.repository_source_snapshot', return_value={**proof['sources'], 'extra.hs': 'extra'}):
                with self.assertRaises(ValueError):
                    host_projection_proof(root, path)
            for target in [source, compiler, output / 'test.tix', output / 'mix/A.mix', output / 'version.log']:
                original = target.read_text(); target.write_text('changed')
                with self.subTest(target=target), self.assertRaises(ValueError):
                    host_projection_proof(root, path)
                target.write_text(original)
            mutations = [
                ('failed command', lambda p: p['commands'][0].update(exitCode=1), 'Failed host projection command'),
                ('missing commands', lambda p: p.update(commands=[]), 'Failed host projection command'),
                ('unbound compiler', lambda p: p['commands'][1].update(command=['cabal', 'build']), 'not bound'),
                ('missing version', lambda p: p['commands'][0].update(command=[str(compiler), '--version']), 'Missing host compiler version'),
                ('wrong version', lambda p: p['compiler'].update(version='0'), 'version differs'),
                ('no snapshots', lambda p: p.update(snapshots={}), 'Empty host projection'),
                ('no mixes', lambda p: p.update(mixFiles={}), 'Empty host projection'),
                ('escaped artifact', lambda p: p.update(snapshots={'../Domain.hs': sha(source)}), 'Stale host projection artifact'),
                ('escaped log', lambda p: p['commands'][1].update(log='../Domain.hs', logSha256=sha(source)), 'Stale host command log'),
            ]
            for label, mutate, message in mutations:
                changed = copy.deepcopy(proof)
                mutate(changed)
                path.write_text(json.dumps(changed))
                with self.subTest(label=label), self.assertRaisesRegex(ValueError, message):
                    host_projection_proof(root, path)
            invalid = {**proof, 'exit_code': False}
            path.write_text(json.dumps(invalid))
            with self.assertRaises(ValueError):
                host_projection_proof(root, path)
            path.write_text(json.dumps(proof))
            (output / 'mix/injected.mix').write_text('extra')
            with self.assertRaises(ValueError):
                host_projection_proof(root, path)
