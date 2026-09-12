"""Validated coverage evidence and inventory scope rules (no inferred exclusions)."""
import hashlib
import json
from pathlib import Path
import re
import subprocess


def measurement(hits):
    total = len(hits)
    covered = sum(value > 0 for value in hits)
    return {'covered': covered, 'total': total, 'percent': covered * 100 / total if total else None}


def full(metrics):
    return bool(metrics) and any(m['total'] for m in metrics.values()) and all(m['covered'] == m['total'] for m in metrics.values())


def apply_scope(root, sources, manifest=None):
    root = root.resolve()
    def entries(key):
        values = (manifest or {}).get(key, [])
        if not isinstance(values, list) or any(not isinstance(entry, dict) or not isinstance(entry.get('path'), str) for entry in values):
            raise ValueError('Invalid scope manifest entries: ' + key)
        result = {entry['path']: entry for entry in values}
        if len(result) != len(values):
            raise ValueError('Duplicate scope manifest path: ' + key)
        return result

    exclusions = entries('exclusions')
    overrides = entries('runtimes')
    validations = entries('validations')
    if exclusions.keys() & overrides.keys() or validations.keys() & (exclusions.keys() | overrides.keys()):
        raise ValueError('Scope path cannot be both excluded and assigned runtimes')
    known = {source['path'] for source in sources}
    if (set(exclusions) | set(overrides) | set(validations)) - known:
        raise ValueError('Scope manifest references a missing source')
    for source in sources:
        path = source['path']
        if source['language'] == 'haskell':
            # Tests and native oracle run only on host by default. Production modules
            # and example programs require both host and WASM evidence.
            wasm = ('/src/' in '/' + path or path.startswith('examples/')) and not path.startswith('conformance-oracle/') and '/host-testkit/' not in '/' + path and '/test/' not in '/' + path
            required = ['host', 'wasm'] if wasm else ['host']
        elif source['language'] == 'javascript':
            required = ['javascript']
        else:
            required = ['python' if path.endswith('.py') else 'shell']
        for entry in (exclusions.get(path), overrides.get(path), validations.get(path)):
            if entry:
                if not entry.get('reason') or not entry.get('evidence'):
                    raise ValueError(f'Manifest requires reason and evidence: {path}')
                evidence = (root / entry['evidence']).resolve()
                if entry.get('evidence_sha256') and (not evidence.is_file() or hashlib.sha256(evidence.read_bytes()).hexdigest() != entry['evidence_sha256']):
                    raise ValueError('Manifest evidence fingerprint changed: ' + path)
                if not evidence.is_relative_to(root) or not evidence.is_file():
                    raise ValueError(f'Manifest evidence must be an existing repository file: {path}')
        if path in exclusions:
            if exclusions[path].get('kind') not in ('generated', 'external'):
                raise ValueError(f'Only generated/external provenance exclusions supported: {path}')
            if exclusions[path].get('provenance_format'):
                if exclusions[path]['provenance_format'] != 'wrangler-bundle-v1':
                    raise ValueError('Unknown generated provenance format: ' + path)
                validate_generated_bundle(root, path, root / exclusions[path]['evidence'])
            source['exclusion'] = exclusions[path]
            required = []
        elif path in overrides:
            required = overrides[path]['required']
            allowed = {'haskell': {'host', 'wasm'}, 'javascript': {'javascript'}}.get(source['language'], {'python'} if path.endswith('.py') else {'shell'})
            if not isinstance(required, list) or not required or any(not isinstance(item, str) for item in required) or len(set(required)) != len(required) or set(required) - allowed:
                raise ValueError(f'Invalid required runtimes: {path}')
            source['runtime_basis'] = overrides[path]
        if path in validations:
            validation = validations[path]
            expected_language = 'haskell' if validation.get('kind') == 'haskell-reexport' else 'javascript'
            if source['language'] != expected_language or validation.get('kind') not in ('declaration', 'type-contract', 'haskell-reexport'):
                raise ValueError('Invalid compile validation kind: ' + path)
            if validation['kind'] == 'declaration' and not path.endswith(('.d.ts', '.d.mts', '.d.cts')):
                raise ValueError('Declaration validation requires an ambient declaration file: ' + path)
            source['validation_basis'] = validation
            required = ['compile']
        source['required_runtimes'] = required
        source['evidence'] = {runtime: {'status': 'unmeasured'} for runtime in required}
        source['wasm'] = 'unmeasured' if 'wasm' in required else 'not-applicable'


def hpc_lines(mix, tix_record):
    # A conservative projection: every expression spanning a line must execute.
    # Boolean branch boxes remain a distinct metric rather than expression lines.
    boxes = re.findall(r'\((\d+):(\d+)-(\d+):(\d+),(ExpBox|BinBox|TopLevelBox|LocalBox)\b', mix)
    ticks = [int(x) for x in re.search(r'\[([\d,\s]*)\]', tix_record).group(1).split(',') if x.strip()]
    if len(boxes) != len(ticks):
        raise ValueError('Unsupported mix coordinate format; line coverage unmeasured')
    lines = {}
    for (start, _, end, _, kind), tick in zip(boxes, ticks):
        if kind == 'ExpBox':
            if int(end) < int(start) or int(end) - int(start) > 100000:
                raise ValueError('Invalid mix source span')
            for line in range(int(start), int(end) + 1):
                lines[line] = min(lines.get(line, tick), tick)
    return measurement(list(lines.values())), {str(line): hits for line, hits in sorted(lines.items())}



def hpc_bindings(mix, tix_record):
    boxes = re.findall(r'\(\d+:\d+-\d+:\d+,(ExpBox|BinBox|TopLevelBox|LocalBox)\b([^)]*)\)', mix)
    ticks = [int(x) for x in re.search(r'\[([\d,\s]*)\]', tix_record).group(1).split(',') if x.strip()]
    if len(boxes) != len(ticks):
        raise ValueError('Unsupported mix binding format')
    bindings = []
    for (kind, detail), hits in zip(boxes, ticks):
        if kind == 'TopLevelBox':
            names = json.loads(detail.strip())
            if len(names) == 1:
                bindings.append({'name': names[0], 'hits': hits})
    return bindings


def validated_shared_javascript(root, proof_path, sources=None):
    """Accept merged Node/workerd counters only after reconstructing their evidence."""
    root = root.resolve()
    proof_path = proof_path.resolve()
    if not proof_path.is_relative_to(root):
        raise ValueError('Shared JavaScript proof escapes repository')
    proof = json.loads(proof_path.read_text())
    expected_sources = repository_source_snapshot(root) if sources is None else sources
    if not isinstance(proof, dict) or proof.get('sources') != expected_sources or type(proof.get('exit_code')) is not int or proof['exit_code'] != 0 or proof.get('errors') != []:
        raise ValueError('Shared JavaScript proof failed or source snapshot differs')
    command = ['node', str(root / 'scripts/testing/Support/shared_js_report.mjs'), '--verify', str(proof_path)]
    result = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise ValueError('Shared JavaScript raw evidence verification failed: ' + result.stderr[-1000:])
    verified = json.loads(result.stdout)
    if not isinstance(verified, dict) or any(verified.get(key) != proof.get(key) for key in ('sources', 'sha256', 'workerdOnlySha256', 'inputs')):
        raise ValueError('Shared JavaScript verifier response differs')
    reports = [proof_path.parent / 'coverage-final.json', proof_path.parent / 'workerd-only.json']
    for report, key in zip(reports, ('sha256', 'workerdOnlySha256')):
        if not report.resolve().is_relative_to(proof_path.parent) or hashlib.sha256(report.read_bytes()).hexdigest() != proof.get(key):
            raise ValueError('Shared JavaScript report changed during validation')
    return {'combined': reports[0], 'workerdOnly': reports[1], 'proof': proof_path}


def javascript_evidence(root, paths):
    merged = {}
    for path in paths:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or not data:
            raise ValueError(f'Empty or invalid Istanbul report: {path}')
        for name, entry in data.items():
            source = Path(entry.get('path', name))
            source = source.resolve() if source.is_absolute() else (root / source).resolve()
            if not source.is_relative_to(root):
                raise ValueError(f'Istanbul source outside repository: {source}')
            name = str(source.relative_to(root))
            for map_name, hit_name in (('statementMap', 's'), ('branchMap', 'b'), ('fnMap', 'f')):
                if not isinstance(entry.get(map_name), dict) or not isinstance(entry.get(hit_name), dict) or set(entry[map_name]) != set(entry[hit_name]):
                    raise ValueError(f'Incomplete Istanbul map/count pairs: {name} {map_name}')
                for key, value in entry[hit_name].items():
                    counts = value if isinstance(value, list) else [value]
                    if any(not isinstance(count, int) or isinstance(count, bool) or count < 0 for count in counts):
                        raise ValueError(f'Invalid Istanbul count: {name}')
                    if hit_name == 'b' and (not isinstance(value, list) or len(value) != len(entry[map_name][key]['locations'])):
                        raise ValueError(f'Invalid Istanbul branch arity: {name}')
            if name in merged:
                old = merged[name]
                if any(old[key] != entry[key] for key in ('statementMap', 'branchMap', 'fnMap')):
                    raise ValueError(f'Cannot merge different Istanbul instrumentation: {name}')
                for key in ('s', 'f'):
                    for identifier, count in entry[key].items():
                        old[key][identifier] += count
                for identifier, counts in entry['b'].items():
                    old['b'][identifier] = [left + right for left, right in zip(old['b'][identifier], counts)]
            else:
                merged[name] = entry
    result = {}
    for name, entry in merged.items():
        # Istanbul line semantics: maximum statement count starting on each line.
        lines = {}
        for identifier, position in entry['statementMap'].items():
            line = position['start']['line']
            lines[line] = max(lines.get(line, 0), entry['s'][identifier])
        values = {'statements': measurement(list(entry['s'].values())),
                  'branches': measurement([count for counts in entry['b'].values() for count in counts]),
                  'functions': measurement(list(entry['f'].values())),
                  'lines': measurement(list(lines.values()))}
        result[name] = {'status': 'measured', 'metrics': values, 'complete': full(values)}
    return result


def python_evidence(root, path):
    if path is None:
        return {}
    data = json.loads(path.read_text())
    if data.get('meta', {}).get('branch_coverage') is not True or not data.get('files'):
        raise ValueError('Python evidence requires nonempty branch coverage')
    result = {}
    for name, entry in data['files'].items():
        source = (root / name).resolve()
        if not source.is_relative_to(root.resolve()) or source.suffix != '.py' or not source.is_file():
            raise ValueError('Invalid Python coverage source: ' + name)
        if entry.get('excluded_lines'):
            raise ValueError('Python coverage must not silently exclude source lines')
        metrics = {}
        for metric, covered_key, missing_key, summary_key in [
            ('lines', 'executed_lines', 'missing_lines', 'num_statements'),
            ('branches', 'executed_branches', 'missing_branches', 'num_branches'),
        ]:
            def locations(key):
                values = entry[key]
                if metric == 'lines':
                    if any(type(value) is not int or value <= 0 for value in values):
                        raise ValueError('Invalid Python line evidence')
                    converted = values
                else:
                    if any(not isinstance(value, list) or len(value) != 2 or any(type(n) is not int for n in value) or value[0] <= 0 for value in values):
                        raise ValueError('Invalid Python branch evidence')
                    converted = [tuple(value) for value in values]
                if len(set(converted)) != len(converted):
                    raise ValueError('Duplicate Python coverage location')
                return set(converted)
            covered, missing = locations(covered_key), locations(missing_key)
            if covered & missing or len(covered | missing) != entry['summary'][summary_key]:
                raise ValueError('Inconsistent Python coverage locations and totals')
            metrics[metric] = measurement([1] * len(covered) + [0] * len(missing))
        result[str(source.relative_to(root.resolve()))] = {'status': 'measured', 'metrics': metrics, 'complete': full(metrics)}
    return result


def hpc_source_candidates(root, sources, module_name, mix_sources):
    """Resolve mix paths against the compiling Cabal package, not source ownership."""
    root = root.resolve()
    package_roots = {}
    for source in sources:
        if source.get('package') and source.get('package_root') is not None:
            package_roots.setdefault(source['package'], set()).add(source['package_root'])
    bases = {root}
    if '/' in module_name:
        namespace = module_name.split('/', 1)[0]
        owners = [package for package in package_roots if namespace.startswith(package + '-')]
        if owners:
            owner = max(owners, key=len)
            if len(package_roots[owner]) != 1:
                raise ValueError('Ambiguous Cabal package root: ' + owner)
            bases = {(root / next(iter(package_roots[owner]))).resolve()}
    else:
        # Unqualified Main has no namespace. Exact package-relative resolutions
        # can remain ambiguous; the caller must reject more than one candidate.
        bases.update((root / directory).resolve() for directories in package_roots.values() for directory in directories)
    resolved = set()
    for name in mix_sources:
        path = Path(name)
        for base in bases:
            target = path.resolve() if path.is_absolute() else (base / path).resolve()
            if target.is_relative_to(root):
                resolved.add(target)
    return [source for source in sources if source['language'] == 'haskell'
            and source['module'] == module_name.rsplit('/', 1)[-1]
            and (root / source['path']).resolve() in resolved]


def compile_evidence(root, sources, proof_path, scope_path=None):
    """Compile contracts are separate from runtime coverage and need current proof."""
    if proof_path is None:
        return {}
    root = root.resolve()
    proof = json.loads(proof_path.read_text())
    if proof.get('errors') or type(proof.get('exit_code', 0)) is not int or proof.get('exit_code', 0) != 0:
        raise ValueError('Compile proof records a failed validation')
    fingerprints = proof.get('sources')
    if not isinstance(fingerprints, dict) or not fingerprints:
        raise ValueError('Compile proof requires source fingerprints')
    for name, fingerprint in fingerprints.items():
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != fingerprint:
            raise ValueError('Stale or invalid compile proof source: ' + name)
    if any(source['path'] not in fingerprints for source in sources):
        raise ValueError('Compile proof does not include every inventory source')
    scope = scope_path or root / 'scripts/testing/runtime-scope.json'
    if scope.is_file() and str(scope.resolve().relative_to(root)) not in fingerprints:
        raise ValueError('Compile proof omits scope configuration')
    commands = proof.get('commands')
    if not isinstance(commands, list) or not commands:
        raise ValueError('Compile proof requires successful commands')
    for command in commands:
        if not isinstance(command, dict) or type(command.get('exitCode')) is not int or command['exitCode'] != 0 or not isinstance(command.get('argv'), list) or not command['argv'] or any(not isinstance(arg, str) or not arg for arg in command['argv']):
            raise ValueError('Invalid compile proof command')
    validated = proof.get('validated')
    if not isinstance(validated, list):
        raise ValueError('Compile proof requires validated paths')
    known = {source['path']: source for source in sources}
    result = {}
    for entry in validated:
        if not isinstance(entry, dict) or entry.get('path') not in known:
            raise ValueError('Unknown compile validation source')
        name = entry['path']
        source = known[name]
        if name in result or source.get('validation_basis', {}).get('kind') != entry.get('kind') or 'compile' not in source['required_runtimes']:
            raise ValueError('Unapproved or duplicate compile validation: ' + name)
        index = entry.get('commandIndex')
        if type(index) is not int or not 0 <= index < len(commands):
            raise ValueError('Invalid compile command reference: ' + name)
        for dependency in compiler_config_dependencies(root, commands[index]) | {source['validation_basis']['evidence']}:
            if dependency not in fingerprints:
                raise ValueError('Compile proof omits configuration: ' + dependency)
        inputs = commands[index].get('inputs')
        if not isinstance(inputs, list) or name not in inputs or any(not isinstance(path, str) or path not in fingerprints for path in inputs):
            raise ValueError('Compile validation is not a recorded compiler input: ' + name)
        result[name] = {'status': 'validated', 'complete': True, 'kind': entry['kind'],
                        'command': commands[index], 'source_sha256': fingerprints[name],
                        'proof_sha256': hashlib.sha256(proof_path.read_bytes()).hexdigest(),
                        'note': 'Compile validation only; no runtime coverage percentage.'}
    return result


def shell_evidence(root, path):
    """kcov line evidence cannot prove branch completeness."""
    if path is None:
        return {}
    root = root.resolve()
    report = json.loads(path.read_text())
    collector = report.get('collector', {})
    if report.get('schema') != 1 or collector.get('name') != 'kcov' or not collector.get('version') or not isinstance(report.get('files'), dict) or not report['files']:
        raise ValueError('Invalid kcov shell evidence')
    result = {}
    for name, entry in report['files'].items():
        source = (root / name).resolve()
        if not source.is_relative_to(root) or source.suffix != '.sh' or not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != entry.get('sha256'):
            raise ValueError('Stale or invalid shell source: ' + name)
        hits = entry.get('lines')
        if not isinstance(hits, dict) or not hits or entry.get('branch_coverage') is not False:
            raise ValueError('Shell evidence must declare unavailable branch measurement')
        length = len(source.read_text().splitlines())
        for line, count in hits.items():
            if not isinstance(line, str) or not line.isascii() or not line.isdigit() or str(int(line)) != line or not 1 <= int(line) <= length or type(count) is not int or count < 0:
                raise ValueError('Invalid shell line/count')
        result[str(source.relative_to(root))] = {'status': 'measured', 'metrics': {'lines': measurement(list(hits.values()))},
            'branches': {'status': 'unmeasured', 'reason': 'kcov supplies line hits, not branch outcomes'},
            'complete': False, 'collector': collector, 'contracts': report.get('contracts', {})}
    return result


def compiler_config_dependencies(root, command):
    """Resolve the actual project and local extends chain, failing on ambiguity."""
    root = root.resolve()
    argv = command['argv']
    projects = []
    for index, argument in enumerate(argv):
        if argument in ('--project', '-p'):
            if index + 1 == len(argv):
                raise ValueError('Compiler project argument is missing')
            projects.append(argv[index + 1])
        elif argument.startswith('--project='):
            projects.append(argument.split('=', 1)[1])
    if len(projects) != 1 or not isinstance(command.get('cwd'), str):
        raise ValueError('Compile proof requires one explicit project and working directory')
    base = (root / command['cwd']).resolve()
    project = (base / projects[0]).resolve()
    dependencies = set()
    pending = set()

    def visit(path):
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError('Compiler configuration must be a repository file')
        name = str(path.relative_to(root))
        if name in pending:
            raise ValueError('Compiler extends cycle')
        if name in dependencies:
            return
        pending.add(name)
        config = json.loads(path.read_text())
        parents = config.get('extends', [])
        parents = [parents] if isinstance(parents, str) else parents
        if not isinstance(parents, list) or any(not isinstance(parent, str) or not parent.startswith('.') for parent in parents):
            raise ValueError('Unresolved compiler extends dependency')
        for parent in parents:
            extended = (path.parent / parent).resolve()
            if not extended.suffix:
                extended = extended.with_suffix('.json')
            visit(extended)
        pending.remove(name)
        dependencies.add(name)

    visit(project)
    return dependencies


def validate_generated_bundle(root, source_name, proof_path):
    """A historical bundle exclusion is tied to retained outputs and build evidence."""
    root = root.resolve()
    proof = json.loads(proof_path.read_text())
    if proof.get('schema') != 1 or proof.get('kind') != 'generated' or proof.get('artifact') != source_name:
        raise ValueError('Generated bundle provenance does not match source')
    files = proof.get('files')
    if not isinstance(files, dict) or source_name not in files:
        raise ValueError('Generated bundle provenance requires file fingerprints')

    def verified(name, fingerprint):
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != fingerprint:
            raise ValueError('Changed generated bundle evidence: ' + name)
        return path

    for name, fingerprint in files.items():
        verified(name, fingerprint)
    metadata = proof['sourceMap']
    if metadata['path'] not in files:
        raise ValueError('Source map fingerprint missing')
    map_path = verified(metadata['path'], files[metadata['path']])
    mapping = json.loads(map_path.read_text())
    if mapping.get('version') != 3 or not isinstance(mapping.get('mappings'), str) or not re.fullmatch(r'[A-Za-z0-9+/;,]+', mapping['mappings']):
        raise ValueError('Invalid generated source map')
    embedded = [{'name': name, 'embeddedSourceSha256': hashlib.sha256(content.encode()).hexdigest()} for name, content in zip(mapping['sources'], mapping['sourcesContent'])]
    if len(mapping['sources']) != len(mapping['sourcesContent']) or not embedded or embedded != metadata['sources']:
        raise ValueError('Generated source map embedded sources changed')
    bundle = (root / source_name).read_text()
    if not re.search(r'(?m)^//[#@] sourceMappingURL=' + re.escape(map_path.name) + r'\s*$', bundle):
        raise ValueError('Generated bundle source map reference missing')
    build = proof['buildEvidence']
    log = verified(build['path'], build['sha256']).read_text()
    if not build.get('successfulMarker') or build['successfulMarker'] not in log or '--dry-run' not in build['successfulMarker']:
        raise ValueError('Generated bundle successful build evidence missing')


def native_compile_evidence(root, sources, proof_path, scope_path=None):
    """Validate the reviewed GHC re-export without pretending it has runtime ticks."""
    if proof_path is None:
        return {}
    root = root.resolve()
    proof = json.loads(proof_path.read_text())
    if type(proof.get('exit_code', 0)) is not int or proof.get('exit_code', 0) != 0 or proof.get('errors') != [] or not proof.get('commands') or any(type(command.get('exitCode')) is not int or command['exitCode'] != 0 for command in proof['commands']):
        raise ValueError('Native compiler proof failed')
    fingerprints = proof.get('sources', {})
    for name, fingerprint in fingerprints.items():
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != fingerprint:
            raise ValueError('Stale native compiler source/configuration')
    required = {source['path'] for source in sources} | {'cabal.project', 'cloudflare-workers/cloudflare-workers.cabal'}
    scope = scope_path or root / 'scripts/testing/runtime-scope.json'
    if scope.is_file():
        required.add(str(scope.resolve().relative_to(root)))
    if not required.issubset(fingerprints):
        raise ValueError('Native compiler proof omits sources or configurations')
    known = {source['path']: source for source in sources}
    result = {}
    for entry in proof.get('compileValidations', []):
        name = entry['path']
        if name in result or name not in known or known[name].get('validation_basis', {}).get('kind') != 'haskell-reexport' or entry.get('kind') != 'haskell-reexport':
            raise ValueError('Unapproved native compile contract')
        if name != 'cloudflare-workers/shim/compat/GHC/Wasm/Prim.hs' or ' '.join((root / name).read_text().split()) != 'module GHC.Wasm.Prim (JSVal) where import GHC.Wasm.Prim.Host.Internal (JSVal)':
            raise ValueError('Reviewed re-export gained source declarations')
        def artifact(record):
            path = (proof_path.parent / record['path']).resolve()
            if not path.is_relative_to(proof_path.parent.resolve()) or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != record['sha256']:
                raise ValueError('Native compiler artifact fingerprint mismatch')
            return path
        interface = artifact(entry['interface'])
        dump = artifact(entry['dump']).read_text()
        probe = artifact(entry['probe']).read_text().strip()
        compiler = entry['compiler']
        executable = Path(compiler['path'])
        if not executable.is_absolute() or not executable.is_file() or hashlib.sha256(executable.read_bytes()).hexdigest() != compiler['sha256'] or not compiler['version']:
            raise ValueError('Native compiler executable changed')
        declarations = re.findall(r'^  ([\w$]+) ::', dump, re.M)
        if not re.search(r'^interface GHC\.Wasm\.Prim ', dump, re.M) or 'GHC.Wasm.Prim.Host.Internal.JSVal' not in dump or not declarations or any(not re.fullmatch(r'\$trModule\d*', declaration) for declaration in declarations):
            raise ValueError('Interface does not prove metadata-only local declarations')
        if probe != 'plugin probe passed' or not any(command.get('command') == ['ghc', '--show-iface', str(interface)] for command in proof['commands']):
            raise ValueError('Native interface/compiler behavior command is missing')
        result[name] = {'status': 'validated', 'complete': True, 'kind': 'haskell-reexport', 'local_executable_declarations': 0,
                        'compiler_metadata_declarations': declarations, 'source_sha256': fingerprints[name],
                        'proof_sha256': hashlib.sha256(proof_path.read_bytes()).hexdigest(),
                        'note': 'Fresh compiler/type-interface validation; no runtime coverage percentage.'}
    return result


def repository_source_snapshot(root):
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root).decode().split('\0')
    return {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
            for name in sorted(set(names)) if name and (root / name).is_file()
            and Path(name).parts[0] != 'docs' and name != 'README.md'}


def host_projection_proof(root, proof_path):
    """Authenticate the compiler and exact counters eligible for host projection."""
    if proof_path is None:
        return {}
    proof_path = proof_path.resolve()
    proof = json.loads(proof_path.read_text())
    if type(proof.get('exit_code')) is not int or proof['exit_code'] != 0 or proof.get('errors') != []:
        raise ValueError('Host projection requires successful evidence')
    for relative, expected in proof['sources'].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Stale host projection source')
    if proof['sources'] != repository_source_snapshot(root):
        raise ValueError('Host projection source inventory differs')
    compiler = proof['compiler']
    if hashlib.sha256(Path(compiler['path']).read_bytes()).hexdigest() != compiler['sha256']:
        raise ValueError('Host projection compiler changed')
    commands = proof['commands']
    if not commands or any(type(command.get('exitCode')) is not int or command['exitCode'] != 0 for command in commands):
        raise ValueError('Failed host projection command')
    if not any(command['command'][:2] == ['cabal', 'build'] and '--with-compiler=' + compiler['path'] in command['command'] for command in commands):
        raise ValueError('Compiler is not bound to the host build')
    if not any(command['command'] == [compiler['path'], '--numeric-version'] for command in commands):
        raise ValueError('Missing host compiler version command')
    for command in commands:
        log = (proof_path.parent / command['log']).resolve()
        if not log.is_relative_to(proof_path.parent) or hashlib.sha256(log.read_bytes()).hexdigest() != command['logSha256']:
            raise ValueError('Stale host command log')
        if command['command'] == [compiler['path'], '--numeric-version'] and log.read_text().strip() != compiler['version']:
            raise ValueError('Host compiler version differs from evidence')
    evidence = {}
    for collection in ['snapshots', 'mixFiles']:
        if not proof[collection]:
            raise ValueError('Empty host projection artifacts')
        for relative, expected in proof[collection].items():
            path = (proof_path.parent / relative).resolve()
            if not path.is_relative_to(proof_path.parent) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise ValueError('Stale host projection artifact')
            evidence[str(path)] = expected
    actual_mix = {str(path.resolve()) for path in (proof_path.parent / 'mix').rglob('*.mix')}
    if actual_mix != {str((proof_path.parent / name).resolve()) for name in proof['mixFiles']}:
        raise ValueError('Unlisted host projection mix')
    return {'compiler': compiler, 'artifacts': evidence, 'sources': proof['sources']}


def equivalent_hpc_projection(variants):
    """Return summed ticks only for an exactly identical authenticated tick map.

    Component module hashes are not interchangeable. This separate projection
    proves source bytes, runtime, compiler, tab width and every labelled box.
    """
    if len(variants) < 2 or any(not entry.get('authenticated') for entry in variants):
        return None
    keys = ('source', 'source_sha256', 'runtime', 'compiler_sha256', 'compiler_version', 'layout')
    if any(any(entry[key] != variants[0][key] for key in keys) for entry in variants[1:]):
        return None
    if any(entry.get('cpp') for entry in variants):
        return None
    ticks = [entry['ticks'] for entry in variants]
    if any(len(values) != len(ticks[0]) for values in ticks):
        raise ValueError('Projection counter lengths differ')
    return [sum(values) for values in zip(*ticks)]
