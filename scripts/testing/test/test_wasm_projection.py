import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from Support.coverage_evidence import host_projection_proof


class WasmProjectionTests(unittest.TestCase):
    def test_projection_requires_matching_compiler_platform_plans_sources_and_counters(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            output = root / 'proof'; output.mkdir()
            compiler = root / 'bin/wasm32-wasi-ghc'
            compiler.parent.mkdir(); compiler.write_text('cross compiler'); compiler.chmod(0o755)
            (root / 'Source.hs').write_text('module Source where\n')
            sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
            artifacts = {'mix/A.mix':'mix', 'A.tix':'ticks', 'build.log':'built', 'version.log':'9.14.1', 'platform.log':'wasm32-unknown-wasi',
                         'plan.json':json.dumps({'compiler-id':'ghc-9.14.1','arch':'wasm32','os':'wasi'})}
            for relative,content in artifacts.items():
                path=output/relative;path.parent.mkdir(exist_ok=True);path.write_text(content)
            def command(argv,log):
                return {'command':argv,'exitCode':0,'log':log,'logSha256':sha(output/log)}
            source={'Source.hs':sha(root/'Source.hs')}
            proof={'sources':source,'errors':[],'exit_code':0,
                   'compiler':{'path':str(compiler),'sha256':sha(compiler),'version':'9.14.1','platform':'wasm32-unknown-wasi','cabal_path':str(compiler),'cabal_sha256':sha(compiler),'search_path':str(compiler.parent)},
                   'commands':[command(['bash','build.sh'],'build.log')],
                   'compilerCommands':[command([str(compiler),'--numeric-version'],'version.log'),command([str(compiler),'--print-target-platform'],'platform.log')],
                   'buildPlans':[{'path':'plan.json','sha256':sha(output/'plan.json'),'buildDirectory':str(root/'build')}],
                   'snapshots':{'A.tix':sha(output/'A.tix')},'mixFiles':{'mix/A.mix':sha(output/'mix/A.mix')}}
            path=output/'proof.json'
            with patch('Support.coverage_evidence.repository_source_snapshot',return_value=source):
                path.write_text(json.dumps(proof))
                self.assertEqual(host_projection_proof(root,path,runtime='wasm')['compiler']['platform'],'wasm32-unknown-wasi')
                for mutate in [lambda p:p['compiler'].update(platform='aarch64-darwin'),lambda p:p.update(buildPlans=[]),
                               lambda p:p['buildPlans'][0].update(sha256='stale'),lambda p:p['compilerCommands'][0].update(exitCode=1),
                               lambda p:p['compilerCommands'].pop(),lambda p:p['compiler'].update(search_path='/missing')]:
                    changed=copy.deepcopy(proof);mutate(changed);path.write_text(json.dumps(changed))
                    with self.assertRaises(ValueError):
                        host_projection_proof(root,path,runtime='wasm')

    def test_real_compiler_resolution_and_plan_capture_reject_a_native_target(self):
        import os
        from Support.wasm_compiler import compiler_evidence, save_build_plan
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            binary=root/'bin/wasm32-wasi-ghc'
            binary.parent.mkdir()
            binary.write_text('#!/bin/sh\ncase "$1" in --numeric-version) echo 9.14.1 ;; --print-target-platform) echo wasm32-unknown-wasi ;; esac\n')
            binary.chmod(0o755)
            cabal = binary.with_name('wasm32-wasi-cabal')
            cabal.write_text('#!/bin/sh\nexit 0\n');cabal.chmod(0o755)
            environment={**os.environ,'PATH':str(binary.parent)+os.pathsep+os.environ['PATH']}
            output=root/'output';output.mkdir()

            proof=compiler_evidence(root,output,environment)

            self.assertEqual(proof['compiler']['sha256'],hashlib.sha256(binary.read_bytes()).hexdigest())
            self.assertEqual(len(proof['compilerCommands']),3)
            plan=root/'build/cache/plan.json';plan.parent.mkdir(parents=True)
            plan.write_text(json.dumps({'compiler-id':'ghc-9.14.1','arch':'wasm32','os':'wasi'}))
            record=save_build_plan(root,output,'build','fixture',proof['compiler'])
            self.assertTrue((output/record['path']).is_file())
            plan.write_text(json.dumps({'compiler-id':'ghc-9.14.1','arch':'aarch64','os':'osx'}))
            with self.assertRaises(ValueError):
                save_build_plan(root,output,'build','fixture',proof['compiler'])
            binary.write_text(binary.read_text().replace('wasm32-unknown-wasi','aarch64-darwin'))
            with self.assertRaises(ValueError):
                compiler_evidence(root,output,environment)
