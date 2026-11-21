#!/usr/bin/env python3
"""Check test ownership and prevent production/example infrastructure coupling."""
import argparse
from pathlib import Path
import re

LIBRARIES = ('cloudflare-workers', 'servant-cloudflare-workers',
             'servant-cloudflare-workers-client', 'servant-cloudflare-workers-access')
IMPORT = re.compile(r'''(?:\bfrom\s*|\bimport\s*\()(['"])([^'"\n]+)\1''')


def violations(root):
    root = root.resolve()
    errors = []
    for directory in (*[root / name for name in LIBRARIES], root / 'examples',
                      root / 'scripts/testing/Support', root / 'tests/runtime', root / 'testing-support'):
        for file in sorted(directory.rglob('*')):
            relative = file.relative_to(root)
            if any(part in ('node_modules', '.wrangler', 'test-artifacts') or part.startswith('.dev-test-') for part in relative.parts):
                continue
            if file.suffix not in ('.ts', '.mts', '.js', '.mjs', '.hs', '.cabal') or file.name.endswith(('.d.ts', '.d.mts', '-jsffi.mjs')):
                continue
            text = file.read_text()
            if file.suffix == '.mjs':
                errors.append(f'{relative}: handwritten JavaScript must use TypeScript')
            for _, reference in IMPORT.findall(text):
                if not reference.startswith('.'):
                    continue
                target = (file.parent / reference).resolve()
                if not target.is_relative_to(root):
                    errors.append(f'{relative}: import escapes repository: {reference}')
                    continue
                destination = target.relative_to(root).parts
                library_test = relative.parts[0] in LIBRARIES and 'test' in relative.parts
                generic_support = str(relative).startswith('scripts/testing/Support/')
                if (library_test or generic_support or relative.parts[:2] == ('tests', 'runtime')) and destination[0] == 'examples':
                    errors.append(f'{relative}: library/test infrastructure imports an example: {reference}')
                production = relative.parts[0] == 'examples' and relative.parts[2] in ('worker', 'src', 'app', 'apps', 'workers', 'packages')
                if production and ('test' in destination or destination[:2] == ('tests', 'runtime')):
                    errors.append(f'{relative}: production imports test support: {reference}')
            shared_package = relative.parts[0] in (*LIBRARIES, 'testing-support') or relative.parts[:2] == ('tests', 'runtime')
            if file.suffix == '.cabal' and shared_package and 'examples/' in text:
                errors.append(f'{relative}: shared library/test composition depends on example modules')
            if file.suffix == '.hs' and shared_package:
                if re.search(r'^import\s+(?:qualified\s+)?(?:ApiCatalog|QueuedJobs|UrlShortener|Minimal|Realtime|WorkflowExample|StaticAssets)\b', text, re.M):
                    errors.append(f'{relative}: shared Haskell code imports an example module')
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    errors = violations(args.root.resolve())
    for error in errors:
        print(error)
    print(f'Test ownership: {len(errors)} violation(s)')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
