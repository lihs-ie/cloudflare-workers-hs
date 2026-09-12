#!/usr/bin/env python3
"""Conservative lexical export inventory; not a compiler reference or coverage proof."""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGES = ['cloudflare-workers', 'servant-cloudflare-workers',
            'servant-cloudflare-workers-client', 'servant-cloudflare-workers-access']


def clean(text):
    text = re.sub(r'\{-.*?-\}', lambda m: '\n' * m[0].count('\n'), text, flags=re.S)
    text = re.sub(r'"(?:\\.|[^"\\])*"', lambda m: '"' + '\n' * m[0].count('\n') + '"', text)
    return re.sub(r'--[^\n]*', '', text)


def split_exports(text):
    result, start, depth = [], 0, 0
    for index, char in enumerate(text):
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
        elif char == ',' and depth == 0:
            result.append(text[start:index].strip())
            start = index + 1
    result.append(text[start:].strip())
    return [re.sub(r'\s+', ' ', value) for value in result if value]


def module_exports(text):
    match = re.search(r'\bmodule\s+([\w.]+)\s*', text)
    if not match:
        return None
    tail = text[match.end():]
    if not tail.startswith('('):
        return match[1], None
    depth = 0
    for index, char in enumerate(tail):
        if char == '(':
            depth += 1
        elif char == ')':
            depth -= 1
            if depth == 0:
                return match[1], split_exports(tail[1:index])
    raise ValueError('Unclosed export list: ' + match[1])


def imports_and_body(text):
    pattern = r'^import\s+(?:qualified\s+)?([A-Z][\w.]*)\b(?:\s+qualified)?(?:\s+as\s+([A-Z][\w.]*))?(?:\s+hiding)?[ \t]*(?:\([^)]*(?:\)[^\n)]*\))*\))?'
    modules = {m[1] for m in re.finditer(pattern, text, re.M)}
    # Strip whole import declarations including multiline lists. Keep line numbers.
    lines = text.splitlines()
    active, depth = False, 0
    for index, line in enumerate(lines):
        if re.match(r'^import\b', line):
            active = True
        if active:
            depth += line.count('(') - line.count(')')
            lines[index] = ''
            if depth <= 0:
                active = False
                depth = 0
    return modules, '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='docs/audits/api-example-inventory.json')
    args = parser.parse_args()
    paths = []
    for package in PACKAGES:
        paths.extend((ROOT / package).rglob('*.hs'))
    sources = {}
    for path in paths:
        if any(part.startswith('dist-') for part in path.parts) or 'test' in path.parts:
            continue
        parsed = module_exports(clean(path.read_text()))
        if parsed:
            sources.setdefault(parsed[0], []).append((path, parsed[1]))
    consumers = []
    for base in ['examples', *PACKAGES, 'packages/worker-runtime/test']:
        for path in (ROOT / base).rglob('*'):
            if not path.is_file() or path.suffix not in ('.hs', '.ts', '.mts', '.mjs'):
                continue
            rel = path.relative_to(ROOT)
            if any(p.startswith('.') or p.startswith('dist-') or p in ('node_modules', 'test-artifacts') for p in rel.parts):
                continue
            if base in PACKAGES and 'test' not in rel.parts:
                continue
            if path.name.endswith(('-jsffi.mjs', '.d.ts', '.d.mts')):
                continue
            kind = 'example_test' if 'examples' == rel.parts[0] and 'test' in rel.parts else 'example_source' if rel.parts[0] == 'examples' else 'library_test'
            text = clean(path.read_text())
            imported, body = imports_and_body(text) if path.suffix == '.hs' else (set(), text)
            consumers.append((str(rel), kind, imported, body))
    rows, unresolved = [], []
    for package in PACKAGES:
        cabal = (ROOT / package / (package + '.cabal')).read_text()
        exposed = set()
        for match in re.finditer(r'^([ \t]*)exposed-modules:[ \t]*([^\n]*)(.*?)(?=\n\s*[\w-]+:|\n\S|\Z)', cabal, re.M | re.S):
            exposed.update(re.findall(r'\b[A-Z][\w]*(?:\.[A-Z][\w]*)+\b', match[2] + match[3]))
        for module in sorted(exposed):
            if module not in sources:
                unresolved.append({'package': package, 'module': module, 'reason': 'source not resolved (including upstream/conditional modules)'})
                continue
            for path, exports in sources[module]:
                if exports is None:
                    unresolved.append({'package': package, 'module': module, 'source': str(path.relative_to(ROOT)), 'reason': 'implicit export list; manual compiler-backed expansion required'})
                    continue
                for export in exports:
                    name_match = re.match(r'(?:type\s+|pattern\s+)?([\w\']+)', export)
                    name = name_match[1] if name_match else None
                    refs = []
                    if name and not export.startswith('module '):
                        pattern = re.compile(r'(?<![\w\'])' + re.escape(name) + r'(?![\w\'])')
                        for file, kind, imported, body in consumers:
                            if module not in imported:
                                continue
                            for lineno, line in enumerate(body.splitlines(), 1):
                                if pattern.search(line):
                                    refs.append({'path': file, 'line': lineno, 'kind': kind})
                    kinds = {r['kind'] for r in refs}
                    status = 'example_source_candidate' if 'example_source' in kinds else 'test_only_candidate' if refs else 'no_direct_reference_found'
                    rows.append({'package': package, 'module': module, 'source': str(path.relative_to(ROOT)), 'export': export, 'name': name, 'internal': '.Internal' in module or module.startswith('GHC.'), 'status': status, 'references': refs})
    source = ROOT / 'packages/worker-runtime/src/index.ts'
    for match in re.finditer(r'^export (?:async )?(?:function|interface|type) (\w+)', source.read_text(), re.M):
        name = match[1]
        refs = []
        for file, kind, _, body in consumers:
            if file.endswith('.hs') or not re.search(r'worker-runtime|@cloudflare-workers-hs/runtime', (ROOT / file).read_text()):
                continue
            for lineno, line in enumerate(body.splitlines(), 1):
                if re.search(r'\b' + name + r'\b', line):
                    refs.append({'path': file, 'line': lineno, 'kind': kind})
        rows.append({'package': '@cloudflare-workers-hs/runtime', 'module': 'index.ts', 'source': str(source.relative_to(ROOT)), 'export': name, 'name': name, 'internal': False, 'status': 'example_source_candidate' if any(r['kind'] == 'example_source' for r in refs) else 'test_only_candidate' if refs else 'no_direct_reference_found', 'references': refs})
    output = ROOT / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({'method': 'Lexical candidates only. Export groups T(..) are not expanded; reexports, aliases, constructors, shadowing, CPP and transitive calls require manual resolution. TS import occurrences may be included. example_source is a path category, not proof of reachability from a production entrypoint. No runtime coverage or completeness claim.', 'rows': rows, 'unresolved_modules': unresolved}, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'exports_groups': len(rows), 'status': dict(Counter(row['status'] for row in rows)), 'unresolved_modules': unresolved}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
