#!/usr/bin/env python3
"""Conservative host HPC evidence report. Unmeasured code never passes the gate."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parent))
from Support.coverage_evidence import apply_scope, full, hpc_lines, hpc_bindings, javascript_evidence, python_evidence, hpc_source_candidates, compile_evidence, shell_evidence, native_compile_evidence, host_projection_proof, equivalent_hpc_projection, validated_shared_javascript

TIX = re.compile(r'TixModule\s+("(?:[^"\\]|\\.)*")\s+(\d+)\s+(\d+)\s+\[([\d,\s]*)\]')


def run(args, cwd=None):
    return subprocess.run(args, cwd=cwd, text=True, check=True, capture_output=True).stdout


def parse_tix(text):
    records = []
    for match in TIX.finditer(text):
        name, fingerprint, count, ticks = match.groups()
        values = [int(value) for value in ticks.split(',') if value.strip()]
        if len(values) != int(count):
            raise ValueError('Tix tick count mismatch')
        records.append((json.loads(name), fingerprint, int(count), match.group()))
    residue = TIX.sub('', text)
    if not records or not re.fullmatch(r'\s*Tix\s*\[\s*(?:,\s*)*\]\s*', residue):
        raise ValueError('Empty or unsupported Tix format')
    return records


def metrics(xml):
    result = {}
    for module in ET.fromstring(xml).findall('module'):
        values = {}
        for tag in ('exprs', 'booleans', 'alts'):
            node = module.find(tag)
            if node is None:
                raise ValueError(f'Missing HPC metric: {tag}')
            total, covered = int(node.attrib['boxes']), int(node.attrib['count'])
            if tag == 'booleans':
                covered -= int(node.attrib['true']) + int(node.attrib['false'])
            if not 0 <= covered <= total:
                raise ValueError(f'Invalid HPC metric: {tag}')
            values[tag] = {'covered': covered, 'total': total,
                           'percent': 100 * covered / total if total else None}
        result[module.attrib['name']] = values
    if not result:
        raise ValueError('HPC report has no modules')
    return result


def inventory(root):
    paths = run(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root).split('\0')
    packages = []
    for name in paths:
        path = root / name
        if path.suffix == '.cabal' and path.is_file():
            match = re.search(r'^name:\s*(\S+)', path.read_text(), re.M | re.I)
            if match:
                packages.append((path.parent.relative_to(root), match.group(1)))
    result = []
    for name in sorted(set(paths)):
        path = root / name
        if path.is_file() and path.suffix in ('.hs', '.lhs', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.sh'):
            content = path.read_text(errors='replace')
            declaration = re.search(r'^module\s+([A-Z][\w.]*)', content, re.M)
            owners = [(directory, package) for directory, package in packages if Path(name).is_relative_to(directory)]
            owner = max(owners, key=lambda owner: len(owner[0].parts)) if owners else None
            package = owner[1] if owner else None
            declaration_file = name.endswith(('.d.ts', '.d.mts', '.d.cts'))
            result.append({'source_kind': 'type-declaration' if declaration_file else 'executable-or-configuration',
                           'provenance_status': 'requires-manifest' if declaration_file else 'authored-or-unclassified',
                           'package': package, 'package_root': str(owner[0]) if owner else None, 'path': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                           'language': 'haskell' if path.suffix in ('.hs', '.lhs') else ('javascript' if path.suffix in ('.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts') else 'tooling'),
                           'module': declaration.group(1) if declaration else ('Main' if path.suffix == '.hs' else None),
                           'host': 'unmeasured',
                           'wasm': 'unmeasured' if path.suffix in ('.hs', '.lhs') else 'not-applicable'})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--tix', type=Path, action='append', default=[])
    parser.add_argument('--mix-dir', type=Path, action='append', default=[])
    parser.add_argument('--wasm-tix', type=Path, action='append', default=[])
    parser.add_argument('--wasm-mix-dir', type=Path, action='append', default=[])
    parser.add_argument('--istanbul', type=Path, action='append', default=[], help='Istanbul coverage-final.json; repeated files union only identical maps')
    parser.add_argument('--shared-js-proof', type=Path, help='Verified combined Node/workerd raw evidence; workerd-only metrics retained')
    parser.add_argument('--workerd-only', type=Path, help='Fresh workerd report retained separately when shared evidence is unavailable')
    parser.add_argument('--python-json', type=Path, help='Validated coverage.py line/branch JSON')
    parser.add_argument('--shell-json', type=Path, help='Source-matched kcov shell line evidence; branch completeness remains unmeasured')
    parser.add_argument('--native-compile-proof', type=Path, help='Fresh GHC re-export compiler/interface proof')
    parser.add_argument('--host-proof', type=Path, help='Authenticated host compiler and counters for equivalent-map projection')
    parser.add_argument('--compile-proof', type=Path, help='Current-source successful compiler contracts, separate from runtime coverage')
    parser.add_argument('--scope-manifest', type=Path, help='Reviewed provenance exclusions and runtime requirements')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--report-only', action='store_true', help='Write evidence without enforcing completeness; never reports success coverage')
    args = parser.parse_args()
    root = args.root.resolve()
    sources = inventory(root)
    report = {'schema': 1, 'scope': 'all repository-authored executable sources; no silent exclusions',
              'sources': sources, 'host_hpc': [], 'wasm_hpc': [], 'errors': [],
              'javascript': {'status': 'unmeasured', 'note': 'Collect JS line/statement/branch coverage separately; HPC does not measure JS.'},
              'wasm': {'status': 'unmeasured', 'note': 'Host CPP coverage does not measure WASM or JavaScript FFI branches.'},
              'line_coverage': {'status': 'unmeasured', 'note': 'HPC expressions/boolean pairs/case alternatives are not line coverage.'}}
    groups = {}
    projection_variants = {}
    group_inputs = {}
    try:
        host_proof = host_projection_proof(root, args.host_proof)
        manifest_path = args.scope_manifest or root / 'scripts/testing/runtime-scope.json'
        manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else None
        if args.scope_manifest and manifest is None:
            raise ValueError('Requested scope manifest does not exist')
        report['runtime_manifest'] = {'path': str(manifest_path), 'sha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest()} if manifest is not None else None
        apply_scope(root, sources, manifest)
        compiled = compile_evidence(root, sources, args.compile_proof, manifest_path)
        compiled.update(native_compile_evidence(root, sources, args.native_compile_proof, manifest_path))
        report['compile_validation'] = {'status': 'validated' if compiled else 'unmeasured', 'files': compiled, 'required_sources': [source['path'] for source in sources if 'compile' in source['required_runtimes']]}
        for source in sources:
            if source['path'] in compiled:
                source['evidence']['compile'] = compiled[source['path']]
        shell = shell_evidence(root, args.shell_json)
        report['shell'] = {'status': 'measured' if shell else 'unmeasured', 'files': shell}
        if set(shell) - {source['path'] for source in sources if 'shell' in source['required_runtimes']}:
            raise ValueError('Shell report contains non-shell inventory paths')
        for source in sources:
            if source['path'] in shell:
                source['evidence']['shell'] = shell[source['path']]
        shared = validated_shared_javascript(root, args.shared_js_proof) if args.shared_js_proof else None
        shared_sources = javascript_evidence(root, [shared['combined']]) if shared else {}
        # Shared evidence is authoritative for its sources. Do not add older c8
        # or Vitest maps/counters to this independently authenticated pipeline.
        js = javascript_evidence(root, args.istanbul)
        js.update(shared_sources)
        workerd_path = shared['workerdOnly'] if shared else args.workerd_only
        workerd_only = javascript_evidence(root, [workerd_path]) if workerd_path else {}
        report['javascript'] = {'status': 'measured' if js else 'unmeasured', 'files': js,
            'shared_execution': {'status': 'measured' if shared else 'unmeasured',
                'proof': str(shared['proof']) if shared else None,
                'note': 'Node boundary doubles and workerd counters share authenticated instrumentation; Node is not Cloudflare platform verification.' if shared else 'Fresh combined Node/workerd evidence unavailable; no combined completion claim.'},
            'workerd_only': {'status': 'measured' if workerd_only else 'unmeasured', 'files': workerd_only}}
        for source in sources:
            if source['language'] == 'javascript':
                source['javascript_execution'] = {'workerd_only': workerd_only.get(source['path'], {'status': 'unmeasured', 'complete': False}),
                    'shared_execution': 'measured' if shared and source['path'] in shared_sources else 'unmeasured'}
        python = python_evidence(root, args.python_json)
        report['python'] = {'status': 'measured' if python else 'unmeasured', 'files': python}
        if set(python) - {source['path'] for source in sources}:
            raise ValueError('Python report contains sources absent from inventory')
        for source in sources:
            if source['path'] in python and 'python' in source['evidence']:
                source['evidence']['python'] = python[source['path']]
        known_js = {source['path'] for source in sources if source['language'] == 'javascript'}
        if set(workerd_only) - known_js:
            raise ValueError('Workerd-only report contains sources absent from inventory')
        if set(js) - known_js:
            raise ValueError('Istanbul report contains sources absent from inventory')
        for source in sources:
            if source['path'] in js and 'javascript' in source['evidence']:
                source['evidence']['javascript'] = js[source['path']]
                source['host'] = 'measured'
        for runtime, tix in [('host', path) for path in args.tix] + [('wasm', path) for path in args.wasm_tix]:
            for name, fingerprint, count, record in parse_tix(tix.read_text()):
                key = (runtime, name, fingerprint, count, str(tix.resolve()) if name == 'Main' else '')
                groups.setdefault(key, []).append(record)
                group_inputs.setdefault(key, []).append(str(tix.resolve()))
        mix_files_by_runtime = {runtime: [path for directory in directories for path in directory.rglob('*.mix')] for runtime, directories in [('host', args.mix_dir), ('wasm', args.wasm_mix_dir)]}
        with tempfile.TemporaryDirectory(prefix='workers-hpc-') as temp:
            temp = Path(temp)
            for index, ((runtime, name, fingerprint, count, suite), records) in enumerate(groups.items()):
                files = []
                for n, record in enumerate(records):
                    path = temp / f'{index}-{n}.tix'
                    path.write_text(f'Tix [{record}]')
                    files.append(str(path))
                merged = temp / f'merged-{index}.tix'
                run(['hpc', 'sum', '--union', f'--output={merged}', *files])
                # Isolate matching mix files so another build's same module cannot shadow it.
                mix = temp / f'mix-{index}'
                mix.mkdir()
                source_names = set()
                matched_mix = set()
                matched_paths = []
                for path in mix_files_by_runtime[runtime]:
                    content = path.read_text()
                    match = re.match(r'Mix\s+("(?:[^"\\]|\\.)*").*? UTC\s+(\d+)\s', content)
                    if path.stem == name.rsplit('/', 1)[-1] and match and match.group(2) == fingerprint:
                        target = mix / (name + '.mix')
                        target.parent.mkdir(parents=True, exist_ok=True)
                        matched_mix.add(content)
                        matched_paths.append(str(path.resolve()))
                        target.write_text(content)
                        source_names.add(json.loads(match.group(1)))
                if len(matched_mix) > 1:
                    raise ValueError(f'Conflicting mix files for {name} hash {fingerprint}')
                if not source_names:
                    raise ValueError(f'No matching mix for {name} hash {fingerprint}')
                values = metrics(run(['hpc', 'report', '--xml-output', '--per-module', f'--hpcdir={mix}', str(merged)], temp))[name]
                line_metric, line_hits = hpc_lines(next(iter(matched_mix)), parse_tix(merged.read_text())[0][3])
                values['lines'] = line_metric
                candidates = hpc_source_candidates(root, sources, name, source_names)
                item = {'module': name, 'hash': fingerprint, 'suite': suite or None, 'metrics': values,
                        'bindings': hpc_bindings(next(iter(matched_mix)), parse_tix(merged.read_text())[0][3]),
                        'line_hits': line_hits, 'line_method': 'all spanning HPC expression ticks executed', 'mix_sources': sorted(source_names), 'sources': [s['path'] for s in candidates]}
                report[runtime + '_hpc'].append(item)
                generated = []
                if not candidates:
                    # Cabal's explicit autogen-modules declaration is provenance,
                    # corroborated by the generated file's own Cabal warning.
                    module_name = name.rsplit('/', 1)[-1]
                    for source_name in source_names:
                        generated_path = Path(source_name)
                        if generated_path.is_absolute() and generated_path.is_file() and 'WARNING: This module was generated by Cabal.' in generated_path.read_text():
                            for cabal_name in run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '*.cabal'], root).splitlines():
                                cabal_path = root / cabal_name
                                if cabal_path.is_file() and re.search(r'autogen-modules:[^\n]*\b' + re.escape(module_name) + r'\b', cabal_path.read_text()):
                                    generated.append({'path': source_name, 'kind': 'generated', 'evidence': cabal_name, 'reason': 'Explicit Cabal autogen-modules declaration and Cabal-generated source warning'})
                if generated:
                    item['scope'] = 'generated-excluded'
                    item['provenance'] = generated
                elif len(candidates) != 1:
                    report['errors'].append(f'Ambiguous or missing source mapping: {name}')
                else:
                    source = candidates[0]
                    source[runtime] = 'measured'
                    source_text = (root / source['path']).read_text()
                    content = next(iter(matched_mix))
                    layout_match = re.match(r'Mix\s+("(?:[^"\\]|\\.)*").*? UTC\s+\d+\s+(\d+\s+\[.*\])\s*$', content, re.S)
                    merged_record = parse_tix(merged.read_text())[0][3]
                    tick_text = TIX.fullmatch(merged_record).group(4)
                    authenticated = (runtime == 'host' and bool(host_proof)
                        and all(path in host_proof['artifacts'] for path in group_inputs[(runtime, name, fingerprint, count, suite)])
                        and any(path in host_proof['artifacts'] for path in matched_paths)
                        and host_proof['sources'].get(source['path']) == hashlib.sha256((root / source['path']).read_bytes()).hexdigest())
                    compiler = host_proof.get('compiler', {})
                    variant = {'source': source['path'], 'source_sha256': hashlib.sha256((root / source['path']).read_bytes()).hexdigest(),
                        'runtime': runtime, 'compiler_sha256': compiler.get('sha256'), 'compiler_version': compiler.get('version'),
                        'layout': layout_match.group(2) if layout_match else None, 'ticks': [int(t) for t in tick_text.split(',') if t.strip()],
                        'authenticated': authenticated and layout_match is not None,
                        'cpp': bool(re.search(r'^\s*#|\bCPP\b', source_text, re.M)), 'item': item, 'mix': content}
                    projection_variants.setdefault((source['path'], runtime), []).append(variant)
                    if runtime in source['evidence']:
                        previous = source['evidence'][runtime]
                        source['evidence'][runtime] = {'status': 'measured', 'complete': full(values) and previous.get('complete', True), 'modules': previous.get('modules', []) + [item]}
            for (source_path, runtime), variants in projection_variants.items():
                ticks = equivalent_hpc_projection(variants)
                if ticks is None:
                    continue
                first = variants[0]
                name = first['item']['module']
                fingerprint = first['item']['hash']
                projection_dir = temp / ('projection-' + hashlib.sha256((runtime + source_path).encode()).hexdigest())
                projected_mix = projection_dir / (name + '.mix')
                projected_mix.parent.mkdir(parents=True)
                projected_mix.write_text(first['mix'])
                projected_tix = projection_dir / 'projection.tix'
                record = 'TixModule ' + json.dumps(name) + ' ' + fingerprint + ' ' + str(len(ticks)) + ' [' + ','.join(map(str, ticks)) + ']'
                projected_tix.write_text('Tix [' + record + ']')
                projected_metrics = metrics(run(['hpc', 'report', '--xml-output', '--per-module', '--hpcdir=' + str(projection_dir), str(projected_tix)], temp))[name]
                projected_metrics['lines'], projected_hits = hpc_lines(first['mix'], record)
                source = next(source for source in sources if source['path'] == source_path)
                if runtime in source['evidence']:
                    source['evidence'][runtime]['complete'] = full(projected_metrics)
                    source['evidence'][runtime]['projection'] = {'method': 'authenticated identical source/compiler/runtime/full labelled tick map',
                        'source_sha256': first['source_sha256'], 'compiler_sha256': first['compiler_sha256'], 'compiler_version': first['compiler_version'],
                        'map_sha256': hashlib.sha256(first['layout'].encode()).hexdigest(), 'metrics': projected_metrics, 'line_hits': projected_hits,
                        'variants': [{'module': entry['item']['module'], 'hash': entry['item']['hash']} for entry in variants]}
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ET.ParseError) as error:
        report['errors'].append(str(error))
    report['unmeasured_sources'] = [s['path'] for s in sources if any(e['status'] == 'unmeasured' for e in s.get('evidence', {'unknown': {'status': 'unmeasured'}}).values())]
    host_sources = [s for s in sources if 'host' in s.get('required_runtimes', [])]
    report['host_hpc_complete'] = bool(host_sources) and all(s['evidence']['host'].get('complete', False) for s in host_sources)
    report['line_coverage'] = {'status': 'partial' if report['host_hpc'] or report['javascript'].get('files') else 'unmeasured', 'note': 'HPC expression-span projection; JS uses Istanbul statement-start lines. WASM remains separate.'}
    wasm_sources = [s for s in sources if 'wasm' in s.get('required_runtimes', [])]
    report['wasm']['status'] = ('partial' if report['wasm_hpc'] else 'unmeasured') if wasm_sources else 'not-applicable'
    report['wasm']['note'] = 'WASM HPC measures instrumented Haskell ticks; JavaScript FFI requires separate instrumentation.'
    report['wasm']['required_sources'] = [s['path'] for s in wasm_sources]
    runtime_evidence = [entry for source in sources for runtime, entry in source.get('evidence', {}).items() if runtime != 'compile']
    compile_entries = [source['evidence']['compile'] for source in sources if 'compile' in source.get('evidence', {})]
    report['runtime_complete'] = bool(runtime_evidence) and not report['errors'] and all(entry.get('complete', False) for entry in runtime_evidence)
    report['compile_validation_complete'] = not report['errors'] and all(entry.get('complete', False) for entry in compile_entries)
    report['complete'] = bool(sources) and not report['errors'] and any(s.get('required_runtimes') for s in sources) and all(all(e.get('complete', False) for e in s.get('evidence', {'unknown': {}}).values()) for s in sources)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(f"Coverage evidence: {args.output}; {len(report['host_hpc'])} HPC modules; {len(report['unmeasured_sources'])} unmeasured sources; complete={str(report['complete']).lower()}")
    return 0 if args.report_only or report['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
