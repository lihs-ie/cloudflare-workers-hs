import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from Support.haskell_contracts import discovery_command, fingerprint, haskell_contract_evidence


class HaskellContractTests(unittest.TestCase):
    def test_discovery_requires_the_exact_component_and_a_nonempty_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'binary.log').write_text('/bin/suite\n')
            (root / 'suite.log').write_text('Passed: 3\nFailed: 0\n')
            proof = {'_directory': str(root), 'commands': [
                {'command': ['cabal', 'list-bin', 'p:test:unit'], 'log': 'binary.log'},
                {'command': ['/bin/suite'], 'log': 'suite.log'}]}

            self.assertEqual(discovery_command(proof, 'p:test:unit')['passed'], 3)
            for text in ['Passed: 0\nFailed: 0\n', 'Passed: 3\nFailed: 1\n', 'no summary']:
                (root / 'suite.log').write_text(text)
                with self.assertRaises(ValueError):
                    discovery_command(proof, 'p:test:unit')
            with self.assertRaises(ValueError):
                discovery_command(proof, 'other:test:unit')

    def test_interface_requires_source_fingerprint_artifacts_and_both_consumer_controls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'proof'; output.mkdir()
            source = root / 'A.hs'; source.write_text('module A where\nnewtype A = A Int\n')
            review = {'kind': 'haskell-interface', 'path': 'A.hs', 'source_sha256': fingerprint(source), 'compiler_runtimes': ['host','wasm']}
            sources = [{'path': 'A.hs', 'validation_basis': review}]
            snapshot = {'A.hs': fingerprint(source)}
            compiler = root / 'ghc'; compiler.write_text('compiler')
            parents = {}
            commands = []
            interfaces = {}
            for runtime in ['host','wasm']:
                parent = root / (runtime + '.json'); parent.write_text(json.dumps({'compiler': {'path': str(compiler)}, 'commands': []}))
                parents[runtime] = {'path': parent.name, 'sha256': fingerprint(parent)}
                interface = output / (runtime + '.hi'); interface.write_text('compiled')
                dump = output / (runtime + '.interface')
                dump.write_text('interface A [self-recomp]\n  src hash: ' + hashlib.md5(source.read_bytes()).hexdigest() + '\n')
                interfaces[runtime] = {k:{'path':v.name,'sha256':fingerprint(v)} for k,v in [('interface',interface),('dump',dump)]}
                commands.append({'command':[str(compiler),'--show-iface',str(interface)], 'runtime':runtime,'exitCode':0,'processExitCode':0,'expectedSuccess':True,'log':dump.name,'logSha256':fingerprint(dump)})
                for label,success,message in [('public',True,'compiled'),('router-constructor',False,'StaticRouter not in scope'), *[(name,False,name+' hidden module') for name in ['Cloudflare.Workers.Internal.Abort','Cloudflare.Workers.Internal.NativeResponse','Cloudflare.Workers.Internal.WorkersAI','Servant.Cloudflare.Workers.Access.Internal.JWKSCache']]]:
                    log=output/(runtime+'-'+label+'.log');log.write_text(message)
                    commands.append({'command':['cabal','exec'], 'runtime':runtime,'probe':label,'exitCode':0,'processExitCode':0 if success else 1,'expectedSuccess':success,'expectedDiagnostic':('StaticRouter' if label=='router-constructor' else label) if not success else '', 'log':log.name,'logSha256':fingerprint(log)})
            proof={'sources':snapshot,'parents':parents,'commands':commands,'validated':[{'path':'A.hs','kind':'haskell-interface','interfaces':interfaces}],'exit_code':0,'errors':[]}
            path=output/'proof.json'
            with patch('Support.coverage_evidence.repository_source_snapshot', return_value=snapshot), patch('Support.coverage_evidence.host_projection_proof', return_value={}):
                path.write_text(json.dumps(proof))
                self.assertEqual(haskell_contract_evidence(root,sources,path)['A.hs']['status'],'validated')
                mutations=[lambda p:p.update(exit_code=True),lambda p:p['validated'][0].update(kind='declaration'),
                           lambda p:p['validated'][0]['interfaces'].pop('wasm'),lambda p:p['commands'].pop(),
                           lambda p:p['validated'][0]['interfaces']['host']['dump'].update(sha256='changed'),
                           lambda p:p['parents']['host'].update(path='../outside')]
                for mutate in mutations:
                    changed=copy.deepcopy(proof);mutate(changed);path.write_text(json.dumps(changed))
                    with self.assertRaises((ValueError,OSError)):
                        haskell_contract_evidence(root,sources,path)
                path.write_text(json.dumps(proof))
                source.write_text(source.read_text()+'value = 42\n')
                with self.assertRaisesRegex(ValueError,'source changed'):
                    haskell_contract_evidence(root,sources,path)
