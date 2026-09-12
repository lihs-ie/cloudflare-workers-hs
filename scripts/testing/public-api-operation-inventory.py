#!/usr/bin/env python3
"""Expand public facade declarations into conservative operation/option candidates."""
import argparse
import hashlib
import importlib.util
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('lexical_inventory', Path(__file__).with_name('api-example-inventory.py'))
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


def declarations(text):
    """Local declaration spans, deliberately not a Haskell parser."""
    pattern = re.compile(r'^(?:data|newtype|class)\s+(?:\([^\n]*\)\s*=>\s*)?([A-Z][\w\x27]*)\b', re.M)
    result = {}
    for match in pattern.finditer(text):
        end = re.search(r'\n(?=[A-Za-z_][^\n]*(?:::|=)|(?:data|newtype|type|class|instance)\b)', text[match.end():])
        stop = match.end() + end.start() if end else len(text)
        body = text[match.start():stop]
        constructors = re.findall(r'(?:=|\|)\s*([A-Z][\w\x27]*)\b', body)
        constructors += re.findall(r'^\s+([A-Z][\w\x27]*)\s*::', body, re.M)
        fields = re.findall(r'(?:\{|,)\s*([a-z][\w\x27]*)\s*::', body)
        if body.startswith('class '):
            fields += re.findall(r'^\s+([a-z][\w\x27]*)\s*::', body, re.M)
        result[match[1]] = (constructors, fields)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='docs/audits/public-api-operations-20260908.json')
    args = parser.parse_args()
    output = ROOT / args.output
    if output.exists():
        raise SystemExit('Refusing to overwrite an existing audit; choose a new --output path')
    sources = {}
    hashes = {}
    consumers = []
    for package in legacy.PACKAGES:
        for path in (ROOT / package / 'src').rglob('*.hs'):
            text = legacy.clean(path.read_text())
            parsed = legacy.module_exports(text)
            if parsed:
                sources.setdefault(parsed[0], []).append((path, text, parsed[1]))
    for base in ['examples', *legacy.PACKAGES, 'packages/worker-runtime/test']:
        for path in (ROOT / base).rglob('*'):
            if not path.is_file() or path.suffix not in ('.hs', '.ts', '.mts', '.mjs'):
                continue
            rel = path.relative_to(ROOT)
            if any(p.startswith('.') or p.startswith('dist-') or p in ('node_modules', 'test-artifacts', 'worker') for p in rel.parts):
                continue
            if base in legacy.PACKAGES and 'test' not in rel.parts:
                continue
            if path.name.endswith(('-jsffi.mjs', '.d.ts', '.d.mts')):
                continue
            raw = path.read_text()
            text = legacy.clean(raw)
            imports, body = legacy.imports_and_body(text) if path.suffix == '.hs' else (set(), text)
            kind = 'example_test' if rel.parts[0] == 'examples' and 'test' in rel.parts else 'example_source' if rel.parts[0] == 'examples' else 'library_test'
            consumers.append((str(rel), kind, imports, body, raw))
    rows, modules, exclusions = [], [], []

    def add(package, module, source, name, kind, parent=None, notes=None):
        refs = []
        for file, category, imports, body, raw in consumers:
            if package != '@cloudflare-workers-hs/runtime' and module not in imports:
                continue
            if package == '@cloudflare-workers-hs/runtime' and (file.endswith('.hs') or not re.search(r'worker-runtime|@cloudflare-workers-hs/runtime', raw)):
                continue
            for line, content in enumerate(body.splitlines(), 1):
                if re.search(r'(?<![\w\x27])' + re.escape(name) + r'(?![\w\x27])', content):
                    refs.append({'path': file, 'line': line, 'category': category})
        rows.append({'key': f'{package}:{module}:{parent + ":" if parent else ""}{kind}:{name}', 'package': package, 'module': module, 'source': source, 'name': name, 'kind': kind, 'parent': parent, 'source_candidates': refs, 'executed_evidence': [], 'execution_status': 'unverified', 'notes': notes or []})

    for package in legacy.PACKAGES:
        cabal_path = ROOT / package / (package + '.cabal')
        cabal = cabal_path.read_text()
        exposed = set()
        for match in re.finditer(r'^([ \t]*)exposed-modules:[ \t]*([^\n]*)(.*?)(?=\n\s*[\w-]+:|\n\S|\Z)', cabal, re.M | re.S):
            exposed.update(re.findall(r'\b[A-Z][\w]*(?:\.[A-Z][\w]*)+\b', match[2] + match[3]))
        for module in sorted(exposed):
            if '.Internal' in module or module.startswith('GHC.'):
                exclusions.append({'package': package, 'module': module, 'reason': 'Internal/GHC implementation module; excluded from facade scope even when Cabal exposes it'})
                continue
            entry = {'package': package, 'module': module, 'expansion_gaps': []}
            modules.append(entry)
            if module not in sources:
                entry['expansion_gaps'].append('No local source; upstream or conditional module requires compiler-backed expansion')
            for path, text, exports in sources.get(module, []):
                rel = str(path.relative_to(ROOT))
                hashes[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
                local = declarations(text)
                if exports is None:
                    entry['expansion_gaps'].append('Implicit exports require compiler-backed enumeration: ' + rel)
                    continue
                for export in exports:
                    if export.startswith('module '):
                        add(package, module, rel, export[7:], 'module_reexport', notes=['Unexpanded transitive reexport; not a verified API enumeration'])
                        entry['expansion_gaps'].append(export)
                        continue
                    match = re.match(r'(?:type\s+|pattern\s+)?([\w\x27]+|\([^)]*\))', export)
                    if not match:
                        entry['expansion_gaps'].append('Unparsed export: ' + export)
                        continue
                    name = match[1]
                    add(package, module, rel, name, 'type_or_class' if name[0].isupper() else 'operation', notes=['Lexical export: ' + export])
                    group = re.search(r'\((.*)\)', export[len(match[0]):])
                    if not group:
                        continue
                    if group[1].strip() == '..':
                        if name not in local:
                            entry['expansion_gaps'].append('Imported/reexported constructor group: ' + export)
                            continue
                        constructors, fields = local[name]
                        for member in dict.fromkeys(constructors):
                            add(package, module, rel, member, 'constructor_candidate', name)
                        for member in dict.fromkeys(fields):
                            add(package, module, rel, member, 'field_or_method_candidate', name)
                    else:
                        for member in legacy.split_exports(group[1]):
                            add(package, module, rel, member, 'explicit_member', name)
    path = ROOT / 'packages/worker-runtime/src/index.ts'
    raw = path.read_text()
    rel = str(path.relative_to(ROOT))
    hashes[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    modules.append({'package': '@cloudflare-workers-hs/runtime', 'module': 'index.ts', 'expansion_gaps': ['TS fields are lexical candidates; overloads, nested properties and exported aliases need compiler verification']})
    for match in re.finditer(r'^export (?:async )?(function|interface|type|class|const) (\w+)', raw, re.M):
        add('@cloudflare-workers-hs/runtime', 'index.ts', rel, match[2], 'typescript_' + match[1])
        if match[1] == 'interface':
            start = raw.find('{', match.end())
            depth, stop = 1, start + 1
            while start >= 0 and stop < len(raw) and depth:
                depth += (raw[stop] == '{') - (raw[stop] == '}')
                stop += 1
            for field in re.findall(r'^\s*(?:readonly\s+)?(\w+)\??\s*:', raw[start + 1:stop - 1], re.M):
                add('@cloudflare-workers-hs/runtime', 'index.ts', rel, field, 'typescript_field_candidate', match[2])
    limits = ['Lexical inventory, not coverage or complete compiler API extraction.', 'T(..) expands locally declared constructors/record fields conservatively. Imported groups, CPP, reexports, operators, GADTs, associated types, nested TS properties and aliases may be incomplete.', 'Source candidates are textual identifier matches after direct module import. Aliasing, shadowing, reachability and overload resolution are not established.', 'executed_evidence is deliberately empty: test source mentions or aggregate passing counts do not prove an operation/option branch executed.', 'Internal/GHC modules excluded explicitly; opaque types expose no private constructors. Generated worker bundles excluded from candidate search.', 'Every expansion gap remains open; no completeness percentage is computed.']
    data = {'schema_version': 1, 'method_limits': limits, 'source_sha256': hashes, 'modules': modules, 'excluded_modules': exclusions, 'rows': rows, 'summary': {'rows': len(rows), 'kinds': dict(Counter(r['kind'] for r in rows)), 'verified_rows': 0, 'modules_with_expansion_gaps': sum(bool(m['expansion_gaps']) for m in modules)}}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(data['summary']))

if __name__ == '__main__':
    main()
