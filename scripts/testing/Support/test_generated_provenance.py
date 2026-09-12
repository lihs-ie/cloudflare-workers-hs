import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from coverage_evidence import validate_generated_bundle


class GeneratedProvenanceTests(unittest.TestCase):
    def test_bundle_requires_unchanged_map_embedded_sources_and_success_log(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bundle.js').write_text('const value=1;\n//# sourceMappingURL=bundle.js.map\n')
            mapping = {'version': 3, 'mappings': 'AAAA', 'sources': ['source.ts'], 'sourcesContent': ['const value: number = 1;']}
            (root / 'bundle.js.map').write_text(json.dumps(mapping))
            (root / 'build.log').write_text('--dry-run: exiting now.')
            digest = lambda name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            proof = {'schema': 1, 'kind': 'generated', 'artifact': 'bundle.js', 'files': {'bundle.js': digest('bundle.js'), 'bundle.js.map': digest('bundle.js.map')}, 'sourceMap': {'path': 'bundle.js.map', 'sources': [{'name': 'source.ts', 'embeddedSourceSha256': hashlib.sha256(mapping['sourcesContent'][0].encode()).hexdigest()}]}, 'buildEvidence': {'path': 'build.log', 'sha256': digest('build.log'), 'successfulMarker': '--dry-run: exiting now.'}}
            evidence = root / 'proof.json'
            evidence.write_text(json.dumps(proof))
            validate_generated_bundle(root, 'bundle.js', evidence)
            for name in ['bundle.js', 'bundle.js.map', 'build.log']:
                original = (root / name).read_text()
                (root / name).write_text(original + 'changed')
                with self.subTest(name=name), self.assertRaises(ValueError):
                    validate_generated_bundle(root, 'bundle.js', evidence)
                (root / name).write_text(original)
            import copy
            for mode in ['schema', 'files', 'map-fingerprint', 'map-format', 'reference', 'build-marker']:
                changed = copy.deepcopy(proof)
                original_bundle = (root / 'bundle.js').read_text()
                original_map = (root / 'bundle.js.map').read_text()
                if mode == 'schema':
                    changed['schema'] = 2
                elif mode == 'files':
                    changed['files'] = {}
                elif mode == 'map-fingerprint':
                    del changed['files']['bundle.js.map']
                elif mode == 'map-format':
                    invalid = dict(mapping, mappings='!')
                    (root / 'bundle.js.map').write_text(json.dumps(invalid))
                    changed['files']['bundle.js.map'] = digest('bundle.js.map')
                elif mode == 'reference':
                    (root / 'bundle.js').write_text('no source map')
                    changed['files']['bundle.js'] = digest('bundle.js')
                else:
                    changed['buildEvidence']['successfulMarker'] = 'missing --dry-run marker'
                evidence.write_text(json.dumps(changed))
                with self.subTest(mode=mode), self.assertRaises(ValueError):
                    validate_generated_bundle(root, 'bundle.js', evidence)
                (root / 'bundle.js').write_text(original_bundle)
                (root / 'bundle.js.map').write_text(original_map)
            proof['sourceMap']['sources'][0]['embeddedSourceSha256'] = 'wrong'
            evidence.write_text(json.dumps(proof))
            with self.assertRaises(ValueError):
                validate_generated_bundle(root, 'bundle.js', evidence)
