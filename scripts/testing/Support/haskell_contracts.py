"""Compiler interfaces and real discovery runs are distinct from runtime percentages."""
import hashlib
import json
from pathlib import Path
import re


def fingerprint(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_artifact(directory, entry):
    path = (directory / entry['path']).resolve()
    if not path.is_relative_to(directory.resolve()) or fingerprint(path) != entry['sha256']:
        raise ValueError('Haskell contract artifact changed or escaped its proof')
    return path


def reviewed_source(root, entry):
    path = root / entry['path']
    if fingerprint(path) != entry.get('source_sha256'):
        raise ValueError('Reviewed Haskell declaration/discovery source changed: ' + entry['path'])
    return path


def discovery_command(parent, target):
    listings = [record for record in parent['commands'] if record['command'][:3] == ['cabal', 'list-bin', target]]
    if len(listings) != 1:
        raise ValueError('Discovery contract has no unique component: ' + target)
    directory = Path(parent['_directory'])
    binary = (directory / listings[0]['log']).read_text().strip()
    runs = [record for record in parent['commands'] if record['command'][0] == binary]
    if len(runs) != 1:
        raise ValueError('Discovery contract has no unique execution: ' + target)
    log = (directory / runs[0]['log']).read_text()
    passed = re.findall(r'^\s*Passed:\s+(\d+)\s*$', log, re.M)
    failed = re.findall(r'^\s*Failed:\s+(\d+)\s*$', log, re.M)
    if len(passed) != 1 or int(passed[0]) <= 0 or failed != ['0']:
        raise ValueError('Discovery contract requires nonempty successful execution')
    return {'target': target, 'passed': int(passed[0]), 'log': runs[0]['log'],
            'logSha256': fingerprint(directory / runs[0]['log'])}


def haskell_contract_evidence(root, sources, proof_path):
    if proof_path is None:
        return {}
    from Support.coverage_evidence import host_projection_proof, repository_source_snapshot
    root = root.resolve()
    proof_path = proof_path.resolve()
    proof = json.loads(proof_path.read_text())
    if (proof.get('sources') != repository_source_snapshot(root) or type(proof.get('exit_code')) is not int
            or proof['exit_code'] != 0 or proof.get('errors') != []):
        raise ValueError('Haskell compiler/discovery proof failed or is stale')
    parents = {}
    for runtime in ['host', 'wasm']:
        parent_path = checked_artifact(root, proof['parents'][runtime])
        host_projection_proof(root, parent_path, runtime=runtime)
        parents[runtime] = json.loads(parent_path.read_text())
        parents[runtime]['_directory'] = str(parent_path.parent)
    commands = proof['commands']
    if not commands or any(type(record.get('exitCode')) is not int or record['exitCode'] != 0 for record in commands):
        raise ValueError('Haskell compiler/consumer command failed')
    for record in commands:
        checked_artifact(proof_path.parent, {'path': record['log'], 'sha256': record['logSha256']})
        if 'input' in record:
            checked_artifact(proof_path.parent, record['input'])
        runtime = record['runtime']
        cabal = 'cabal' if runtime == 'host' else parents[runtime]['compiler'].get('cabal_path', 'cabal')
        if record['command'][0] != parents[runtime]['compiler']['path'] and record['command'][:2] != [cabal, 'exec']:
            raise ValueError('Unbound Haskell contract compiler')
        actual = record['processExitCode']
        if type(actual) is not int or (actual == 0) != record['expectedSuccess']:
            raise ValueError('Haskell consumer result differs from its expectation')
        if not record['expectedSuccess']:
            diagnostic = (proof_path.parent / record['log']).read_text().lower()
            if record['expectedDiagnostic'].lower() not in diagnostic or not any(token in diagnostic for token in ['hidden module', 'not exposed', 'not in scope']):
                raise ValueError('Haskell negative probe failed for an unrelated reason')
    private_modules = ['Cloudflare.Workers.Internal.Abort', 'Cloudflare.Workers.Internal.NativeResponse',
                       'Cloudflare.Workers.Internal.WorkersAI', 'Servant.Cloudflare.Workers.Access.Internal.JWKSCache']
    for runtime in parents:
        if not any(c.get('probe') == 'public' and c['runtime'] == runtime and c['expectedSuccess'] for c in commands):
            raise ValueError('Missing public API positive compiler control')
        for probe in ['router-constructor', *private_modules]:
            if not any(c.get('probe') == probe and c['runtime'] == runtime and not c['expectedSuccess'] for c in commands):
                raise ValueError('Missing public API negative compiler control: ' + probe)
    known = {source['path']: source for source in sources}
    result = {}
    for entry in proof['validated']:
        name = entry['path']
        if name not in known or name in result:
            raise ValueError('Unknown or duplicate Haskell compiler contract')
        reviewed = known[name].get('validation_basis', {})
        if entry['kind'] != reviewed.get('kind') or reviewed.get('kind') not in ['haskell-interface', 'haskell-test-entry']:
            raise ValueError('Unapproved Haskell compiler contract kind')
        source = reviewed_source(root, reviewed)
        if entry['kind'] == 'haskell-test-entry':
            if source.read_text().strip() != '{-# OPTIONS_GHC -F -pgmF sydtest-discover-layer #-}':
                raise ValueError('Discovery entry gained authored executable code')
            if entry['execution'] != discovery_command(parents['host'], reviewed['target']):
                raise ValueError('Discovery proof does not match its component execution')
        else:
            if set(entry['interfaces']) != set(reviewed['compiler_runtimes']):
                raise ValueError('Haskell interface compiler lanes differ from review')
            module = re.search(r'^module\s+([A-Z][\w.]*)', source.read_text(), re.M).group(1)
            for runtime, records in entry['interfaces'].items():
                interface = checked_artifact(proof_path.parent, records['interface'])
                dump_path = checked_artifact(proof_path.parent, records['dump'])
                dump = dump_path.read_text()
                source_hash = hashlib.md5(source.read_bytes()).hexdigest()
                if not re.search(r'^interface ' + re.escape(module) + r' ', dump, re.M) or 'src hash: ' + source_hash not in dump:
                    raise ValueError('Compiler interface does not match the reviewed source bytes')
                if not any(c['command'] == [parents[runtime]['compiler']['path'], '--show-iface', str(interface)]
                           and c['log'] == records['dump']['path'] for c in commands):
                    raise ValueError('Missing recorded compiler interface dump')
        result[name] = {'status': 'validated', 'complete': True, 'kind': entry['kind'],
                        'source_sha256': fingerprint(source), 'proof_sha256': fingerprint(proof_path),
                        'execution': entry.get('execution'), 'note': 'Compiler/API or real discovery evidence; no runtime coverage percentage.'}
    return result
