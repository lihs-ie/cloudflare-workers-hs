"""Reviewed constant guards retain raw metrics and explicit unreachable outcomes."""
import copy
import hashlib
import re

BOX = re.compile(r'\((\d+):(\d+)-(\d+):(\d+),(ExpBox|BinBox|TopLevelBox|LocalBox)\b([^)]*)\)')


def constant_guard_metrics(root, path, mix, ticks, metrics, manifest):
    approved = next((entry for entry in (manifest or {}).get('constant_guards', []) if entry['path'] == path), None)
    if approved is None:
        return metrics, []
    source = (root / path).read_bytes()
    if hashlib.sha256(source).hexdigest() != approved['source_sha256']:
        raise ValueError('Reviewed constant-guard source changed: ' + path)
    lines = source.decode().splitlines()
    boxes = BOX.findall(mix)
    if len(boxes) != len(ticks):
        raise ValueError('Constant-guard map/counter mismatch')
    permitted = {tuple(entry['span']): entry for entry in approved['guards']}
    observed = {}
    for box, hits in zip(boxes, ticks):
        start, column, end, last, kind, label = box
        span = tuple(map(int, (start, column, end, last)))
        if kind != 'BinBox' or not label.startswith(' GuardBinBox ') or span not in permitted:
            continue
        entry = permitted[span]
        if start != end or lines[int(start) - 1].expandtabs(8)[int(column) - 1:int(last)] != entry['token'] or entry['token'] != 'otherwise':
            raise ValueError('Reviewed constant guard no longer matches its source')
        if label.endswith(' False') and hits:
            raise ValueError('Reviewed constant guard produced an impossible outcome')
        observed.setdefault(span, {})[label.rsplit(' ', 1)[-1]] = hits
    if any(set(pair) != {'True', 'False'} for pair in observed.values()):
        raise ValueError('Incomplete constant-guard counter pair')
    result = copy.deepcopy(metrics)
    boolean = result['booleans']
    boolean['total'] -= len(observed)
    if boolean['total'] < boolean['covered']:
        raise ValueError('Constant-guard normalization exceeds boolean denominator')
    boolean['percent'] = 100 * boolean['covered'] / boolean['total'] if boolean['total'] else None
    details = [{'span': list(span), 'token': 'otherwise', 'unreachable': False,
                'true_hits': pair['True'], 'basis': 'Reviewed Prelude.otherwise; source fingerprint and exact labelled guard map'}
               for span, pair in observed.items()]
    return result, details
