import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from Support.v8_queries import canonical_reports


class V8QueryTests(unittest.TestCase):
    def test_only_source_matched_contract_urls_are_canonicalized_without_changing_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            source=root/'config.mts';source.write_text('export const value = 1;\n')
            raw=root/'raw';raw.mkdir()
            url=source.as_uri()+'?contract=success'
            counters={'functionName':'factory','ranges':[{'startOffset':0,'endOffset':10,'count':3}]}
            data={'result':[{'url':url,'functions':[counters]}, {'url':source.as_uri()+'?other=1','functions':[counters]}, {'url':'test-boundary:fake','functions':[]}]}
            file=raw/'coverage.json';file.write_text(json.dumps(data));original=file.read_bytes()
            sources={'config.mts':hashlib.sha256(source.read_bytes()).hexdigest()}

            proof=canonical_reports(root,raw,root/'canonical',sources,['config.mts'])

            result=json.loads((root/'canonical/coverage.json').read_text())
            self.assertEqual(result['result'][0]['url'],source.as_uri())
            self.assertEqual(result['result'][0]['functions'],[counters])
            self.assertEqual(result['result'][1:],data['result'][1:])
            self.assertEqual(file.read_bytes(),original)
            self.assertEqual(len(proof[0]['rewrites']),1)
            source.write_text('export const changed = 2;\n')
            with self.assertRaises(ValueError):
                canonical_reports(root,raw,root/'rejected',sources,['config.mts'])
