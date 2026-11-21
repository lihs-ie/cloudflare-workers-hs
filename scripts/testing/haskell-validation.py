#!/usr/bin/env python3
"""Validate source-pinned type interfaces and real test-discovery contracts."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

from run import source_snapshot
from Support.coverage_evidence import host_projection_proof
from Support.haskell_contracts import fingerprint, reviewed_source, discovery_command

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = '''module Public where
import Cloudflare.Workers.HTTP (Response)
import Cloudflare.Workers.Binding.WorkersAI (WorkersAI, AIModel, AIOptions, workersAIRun)
import Cloudflare.Workers.Binding.WorkersAI.Gemma (GemmaInput, GemmaOutput)
import Servant.Cloudflare.Workers.Server.Extension (Router)
import qualified Servant.Cloudflare.Workers.Access
responseContract :: Response -> Response
responseContract = id
bindingContract :: WorkersAI -> AIModel -> GemmaInput -> AIOptions -> IO GemmaOutput
bindingContract = workersAIRun
routerContract :: Router a b -> Router a b
routerContract = id
'''


def collect_reviewed_interfaces(root, output, reviewed, parents, candidates, execute):
    validated_entries = []
    for index, entry in enumerate(reviewed):
        source = reviewed_source(root, entry)
        validated = {'path': entry['path'], 'kind': entry['kind']}
        if entry['kind'] == 'haskell-test-entry':
            validated['execution'] = discovery_command(parents['host'], entry['target'])
        else:
            module = re.search(r'^module\s+([A-Z][\w.]*)', source.read_text(), re.M).group(1)
            suffix = module.replace('.', '/') + '.hi'
            validated['interfaces'] = {}
            for runtime in entry['compiler_runtimes']:
                matches = [path for path in candidates[runtime] if str(path).endswith('/' + suffix)]
                if not matches:
                    raise ValueError('No compiled interface for ' + runtime + ': ' + entry['path'])
                selected = None
                # Every candidate must come from the authenticated build roots.
                # GHC's source fingerprint rejects a stale same-named interface.
                expected_hash = hashlib.md5(source.read_bytes()).hexdigest()
                for number, candidate in enumerate(matches):
                    destination = output / 'interfaces' / runtime / str(index) / (str(number) + '.hi')
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(candidate, destination)
                    log_name = str(destination.with_suffix('.interface').relative_to(output))
                    dump = execute([parents[runtime]['compiler']['path'], '--show-iface', str(destination)], runtime, log_name=log_name)
                    if 'src hash: ' + expected_hash in dump and re.search(r'^interface ' + re.escape(module) + r' ', dump, re.M):
                        selected = {'interface': {'path': str(destination.relative_to(output)), 'sha256': fingerprint(destination)},
                                    'dump': {'path': log_name, 'sha256': fingerprint(output / log_name)}}
                        break
                if selected is None:
                    raise ValueError('Compiled source fingerprint mismatch: ' + entry['path'])
                validated['interfaces'][runtime] = selected
        validated_entries.append(validated)
    return validated_entries


def validate_public_consumers(root, output, parents, roots, execute):
    for runtime in ['host', 'wasm']:
        project = 'cabal.project' if runtime == 'host' else 'cabal-wasm-coverage.project'
        directory = roots[runtime][0] if runtime == 'host' else root / 'dist-library-runtime-coverage'
        cabal = 'cabal' if runtime == 'host' else parents[runtime]['compiler']['cabal_path']
        base = [cabal, 'exec', '--project-file=' + project, '--builddir=' + str(directory), '--',
                parents[runtime]['compiler']['path'], '-fno-code', '-fforce-recomp', '-v0', '-hide-all-packages',
                '-package', 'base', '-package', 'cloudflare-workers', '-package', 'servant-cloudflare-workers',
                '-package', 'servant-cloudflare-workers-access']
        probes = [('public', PUBLIC, True, ''),
                  ('router-constructor', 'module Negative where\nimport Servant.Cloudflare.Workers.Server.Extension\nprobe = StaticRouter\n', False, 'StaticRouter')]
        for module in ['Cloudflare.Workers.Internal.Abort', 'Cloudflare.Workers.Internal.NativeResponse', 'Cloudflare.Workers.Internal.WorkersAI', 'Servant.Cloudflare.Workers.Access.Internal.JWKSCache']:
            probes.append((module, 'module Negative where\nimport ' + module + '\n', False, module))
        for label, body, expected, diagnostic in probes:
            source = output / 'consumers' / runtime / (label + '.hs')
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(body)
            execute([*base, str(source)], runtime, expected, diagnostic, label, source)


def collect(root, output, host_path, wasm_path):
    sources = source_snapshot()
    scope = json.loads((root / 'scripts/testing/runtime-scope.json').read_text())
    reviewed = [entry for entry in scope['validations'] if entry['kind'] in ['haskell-interface', 'haskell-test-entry']]
    proof = {'sources': sources, 'parents': {}, 'commands': [], 'validated': [], 'errors': [], 'exit_code': 1}
    parents = {}
    roots = {}
    for runtime, path in [('host', host_path.resolve()), ('wasm', wasm_path.resolve())]:
        host_projection_proof(root, path, runtime=runtime)
        parents[runtime] = json.loads(path.read_text())
        parents[runtime]['_directory'] = str(path.parent)
        proof['parents'][runtime] = {'path': str(path.relative_to(root)), 'sha256': fingerprint(path)}
        roots[runtime] = ([Path(p['buildDirectory']) for p in parents[runtime]['buildPlans']] if runtime == 'wasm' else
                          [root / arg.split('=', 1)[1] for c in parents[runtime]['commands'] for arg in c['command'] if arg.startswith('--builddir=')])
        roots[runtime] = sorted(set(roots[runtime]))
    candidates = {runtime: sorted({path for directory in directories for path in directory.rglob('*.hi')}) for runtime, directories in roots.items()}

    def execute(argv, runtime, expected=True, diagnostic='', probe=None, input_path=None, log_name=None):
        log = output / (log_name or f'command-{len(proof["commands"])}.log')
        completed = subprocess.run(argv, cwd=root, env={**os.environ, 'PATH': parents[runtime]['compiler'].get('search_path', os.environ['PATH'])}, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text(completed.stdout)
        record = {'command': argv, 'runtime': runtime, 'processExitCode': completed.returncode,
                  'exitCode': 0, 'expectedSuccess': expected, 'expectedDiagnostic': diagnostic,
                  'log': str(log.relative_to(output)), 'logSha256': fingerprint(log), 'probe': probe}
        if input_path:
            record['input'] = {'path': str(input_path.relative_to(output)), 'sha256': fingerprint(input_path)}
        proof['commands'].append(record)
        if (completed.returncode == 0) != expected or diagnostic.lower() not in completed.stdout.lower():
            record['exitCode'] = 1
            raise ValueError('Unexpected Haskell compiler/consumer result: ' + str(argv))
        return completed.stdout

    try:
        proof['validated'] = collect_reviewed_interfaces(root, output, reviewed, parents, candidates, execute)
        validate_public_consumers(root, output, parents, roots, execute)
        if source_snapshot() != sources:
            raise ValueError('Sources changed during Haskell contract validation')
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        proof['errors'].append(str(error))
    proof['exit_code'] = 1 if proof['errors'] else 0
    path = output / 'proof.json'
    path.write_text(json.dumps(proof, indent=2) + '\n')
    if not proof['errors']:
        pointer = root / 'artifacts/testing/haskell-validation-latest.json'
        pointer.write_text(json.dumps({'proof': str(path.relative_to(root)), 'sha256': fingerprint(path)}) + '\n')
    return proof['exit_code']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host-proof', required=True, type=Path)
    parser.add_argument('--wasm-proof', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    output = (args.output or ROOT / 'artifacts/testing' / ('haskell-validation-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT / 'artifacts/testing') or output.exists():
        parser.error('Choose a fresh Haskell evidence directory')
    output.mkdir(parents=True)
    code = collect(ROOT, output, args.host_proof, args.wasm_proof)
    print('Haskell compiler/discovery evidence: ' + str(output))
    return code


if __name__ == '__main__':
    raise SystemExit(main())
