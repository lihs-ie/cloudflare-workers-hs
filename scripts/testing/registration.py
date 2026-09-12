#!/usr/bin/env python3
"""Static test-file registration inventory; not proof of dynamic test execution.

Only literal qualified Haskell `.spec` uses and named TypeScript register* calls
are accepted for child registration. Runtime test-name inventories must be checked
separately: matching total counts is never sufficient.
"""
import argparse
import json
import re
from pathlib import Path

DEFAULT_ROOTS = [
    "packages/worker-runtime/test",
    'cloudflare-workers/test/unit', 'cloudflare-workers/test/host-testkit',
    'servant-cloudflare-workers/test/unit', 'servant-cloudflare-workers/test/conformance',
    'servant-cloudflare-workers-client/test/unit',
    'servant-cloudflare-workers-access/test/unit', 'examples/quickstart/test/unit',
    'examples/quickstart/test/integration', 'examples/quickstart/test/model',
    'conformance-oracle/test/unit', 'testing-support/test/integration',
    'examples/quickstart/packages/domain/test/unit',
    'examples/quickstart/apps/management/test/unit',
    'examples/library-examples/test/integration',
    'examples/minimal/test/integration',
    'examples/static-assets/test/integration',
    'examples/realtime/test/integration',
    'examples/workflows/test/integration',
]


JS_EXTENSIONS = ('.ts', '.mts', '.cts', '.js', '.mjs', '.cjs')
JS_ENTRIES = tuple('.spec' + extension for extension in JS_EXTENSIONS)
JS_CHILDREN = tuple('.cases' + extension for extension in JS_EXTENSIONS)

def source(path):
    text = path.read_text()
    if path.suffix == '.hs':
        text = re.sub(r'\{-.*?-\}', '', text, flags=re.S)
        return re.sub(r'--[^\n]*', '', text)
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'^\s*//[^\n]*', '', text, flags=re.M)


def check(root, layer_names):
    errors, inventory = [], []
    seen = set()
    for layer_name in layer_names:
        layer = root / layer_name
        if not layer.is_dir():
            errors.append(f'missing required test layer: {layer_name}')
            continue
        if layer.resolve() in seen:
            errors.append(f'duplicate test layer: {layer_name}')
            continue
        seen.add(layer.resolve())
        files = sorted(p for p in layer.rglob('*') if p.is_file() and 'Support' not in p.relative_to(layer).parts)
        entries = [p for p in files if (p.name.endswith('Spec.hs') and p.name != 'Spec.hs') or p.name.endswith(JS_ENTRIES)]
        children = [p for p in files if p.name.endswith('Cases.hs') or p.name.endswith(JS_CHILDREN)]
        if not entries:
            errors.append(f'no test entrypoints: {layer_name}')
        owners = {p: [] for p in children}
        hs_modules = {'.'.join(p.relative_to(layer).with_suffix('').parts): p for p in children + entries if p.suffix == '.hs'}
        for entry in entries:
            text = source(entry)
            owned = []
            if entry.suffix == '.hs':
                for match in re.finditer(r'^import\s+(?:qualified\s+)?([\w.]+)(?:\s+qualified)?(?:\s+as\s+(\w+))?', text, re.M):
                    module, alias = match.groups()
                    if not module.endswith(('Cases', 'Spec')):
                        continue
                    target = hs_modules.get(module)
                    if target is None:
                        errors.append(f'{entry.relative_to(root)}: unresolved test module {module}')
                        continue
                    if target in entries:
                        errors.append(f'{entry.relative_to(root)}: imports another entry {module}')
                        continue
                    body = '\n'.join(line for line in text.splitlines() if not line.startswith('import '))
                    body = re.sub(r'"(?:\\.|[^"\\])*"', '""', body)
                    count = len(re.findall(r'\b' + re.escape(alias or module) + r'\.spec\b', body))
                    if count != 1:
                        errors.append(f'{entry.relative_to(root)}: {module}.spec registered {count} times, expected once')
                    owners[target].append(entry)
                    owned.append(str(target.relative_to(root)))
            else:
                for match in re.finditer(r'import\s*\{([^}]+)\}\s*from\s*[\'"]([^\'"]+)[\'"]', text):
                    bindings, reference = match.groups()
                    if '.cases' not in reference:
                        continue
                    target = (entry.parent / reference).resolve()
                    if target.suffix in ('.js', '.mjs', '.cjs') and not target.is_file():
                        target = target.with_suffix({'.js': '.ts', '.mjs': '.mts', '.cjs': '.cts'}[target.suffix])
                    elif target.suffix not in JS_EXTENSIONS:
                        target = Path(str(target) + '.ts')
                    target = next((p for p in children if p.resolve() == target), None)
                    if target is None:
                        errors.append(f'{entry.relative_to(root)}: unresolved child {reference}')
                        continue
                    names = [binding.strip().split(' as ')[-1] for binding in bindings.split(',')]
                    names = [name for name in names if name.startswith('register')]
                    body = text[:match.start()] + text[match.end():]
                    count = sum(len(re.findall(r'\b' + re.escape(name) + r'\s*\(', body)) for name in names)
                    if count != 1:
                        errors.append(f'{entry.relative_to(root)}: {reference} registered {count} times, expected once')
                    owners[target].append(entry)
                    owned.append(str(target.relative_to(root)))
            inventory.append({'layer': layer_name, 'entry': str(entry.relative_to(root)), 'children': owned})
        for child, child_owners in owners.items():
            if len(child_owners) != 1:
                errors.append(f'{child.relative_to(root)}: has {len(child_owners)} owners, expected one')
        test_root = next((parent for parent in [layer, *layer.parents] if parent.name == 'test'), layer)
        for support in (test_root / 'Support').rglob('*'):
            if support.is_file() and (support.name.endswith(('Spec.hs', 'Cases.hs') + JS_ENTRIES + JS_CHILDREN)):
                errors.append(f'{support.relative_to(root)}: test registration file forbidden in Support')
        package = test_root.parent
        cabals = list(package.glob('*.cabal'))
        if cabals:
            cabal = cabals[0].read_text()
            for path in entries + children:
                if path.suffix == '.hs':
                    module = '.'.join(path.relative_to(layer).with_suffix('').parts)
                    if not re.search(r'(?<![\w.])' + re.escape(module) + r'(?![\w.])', cabal):
                        errors.append(f'{path.relative_to(root)}: module absent from {cabals[0].relative_to(root)}')
    return {'scope': 'static file/import/registration structure only; runtime full test names require separate verification', 'inventory': inventory, 'errors': sorted(set(errors))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--layer', action='append', help='required test layer relative to root; repeatable')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = check(args.root.resolve(), args.layer or DEFAULT_ROOTS)
    rendered = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
        print(f"Registration: {len(result['inventory'])} entrypoints, {len(result['errors'])} errors; inventory: {args.output}")
        for error in result['errors']:
            print(error)
    else:
        print(rendered, end='')
    return bool(result['errors'])


if __name__ == '__main__':
    raise SystemExit(main())
