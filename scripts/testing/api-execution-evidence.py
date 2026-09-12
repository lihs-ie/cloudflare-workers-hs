#!/usr/bin/env python3
"""Attach observed HPC binding entries to lexical public API candidates, conservatively."""
import argparse
import hashlib
import json
from pathlib import Path


def correlate(inventory, reports):
    rows = []
    for original in inventory['rows']:
        row = dict(original, executed_evidence=[])
        for filename, report in reports:
            if report.get('errors'):
                raise ValueError('Coverage report contains collection errors: ' + filename)
            sources = {source['path']: source for source in report['sources']}
            source = sources.get(row['source'])
            expected = inventory['source_sha256'].get(row['source'])
            if not source or not expected or source['sha256'] != expected:
                continue
            for runtime in ['host', 'wasm']:
                for module in report.get(runtime + '_hpc', []):
                    if row['source'] not in module['sources']:
                        continue
                    for binding in module.get('bindings', []):
                        if binding['name'] == row['name'] and binding['hits'] > 0:
                            row['executed_evidence'].append({'runtime': runtime, 'report': filename, 'module': module['module'], 'moduleHash': module['hash'], 'binding': binding['name'], 'entryHits': binding['hits']})
        row['execution_status'] = 'binding_entry_observed' if row['executed_evidence'] else 'unverified'
        rows.append(row)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--coverage', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    inventory = json.loads(args.inventory.read_text())
    reports = [(str(path), json.loads(path.read_text())) for path in args.coverage]
    rows = correlate(inventory, reports)
    result = {'method': 'Match exact source SHA-256, module source mapping and positive HPC TopLevelBox entry ticks. This proves binding evaluation, not every argument, option, error branch or direct call site. Reexports, constructors and compiler-eliminated bindings may remain unresolved. No API completeness percentage is inferred.',
              'inputs': {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in [args.inventory, *args.coverage]},
              'summary': {'candidates': len(rows), 'bindingEntriesObserved': sum(bool(row['executed_evidence']) for row in rows)}, 'rows': rows}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2))
    print(json.dumps(result['summary']))


if __name__ == '__main__':
    main()
