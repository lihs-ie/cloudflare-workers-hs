"""Retain raw V8 data while canonicalizing authored contract module URLs for c8."""
import copy
import hashlib
import json
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit, urlunsplit


def canonical_report(root, data, sources, eligible):
    if not isinstance(data, dict) or not isinstance(data.get('result'), list):
        raise ValueError('Invalid V8 script collection')
    result = copy.deepcopy(data)
    rewrites = []
    for script in result.get('result', []):
        if not isinstance(script, dict) or not isinstance(script.get('url'), str):
            raise ValueError('Invalid V8 script URL')
        original = script['url']
        parsed = urlsplit(original)
        if parsed.scheme != 'file' or set(parse_qs(parsed.query)) != {'contract'}:
            continue
        filename = Path(unquote(parsed.path)).resolve()
        if not filename.is_relative_to(root):
            continue
        relative = str(filename.relative_to(root))
        if relative not in set(eligible):
            continue
        if hashlib.sha256(filename.read_bytes()).hexdigest() != sources.get(relative):
            raise ValueError('Queried V8 module differs from the recorded source')
        canonical = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, '', ''))
        cache = result.get('source-map-cache', {})
        if original in cache:
            if canonical in cache and cache[canonical] != cache[original]:
                raise ValueError('Queried V8 source maps disagree')
            cache[canonical] = cache.pop(original)
        script['url'] = canonical
        rewrites.append({'original': original, 'canonical': canonical, 'source': relative,
                         'sourceSha256': sources[relative]})
    return result, rewrites


def canonical_reports(root, raw, destination, sources, eligible):
    root = root.resolve()
    destination.mkdir()
    records = []
    eligible = set(eligible)
    for path in sorted(raw.glob('*.json')):
        data = json.loads(path.read_text())
        result, rewrites = canonical_report(root, data, sources, eligible)
        target = destination / path.name
        target.write_text(json.dumps(result))
        records.append({'raw': str(path.relative_to(destination.parent)), 'rawSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                        'canonical': str(target.relative_to(destination.parent)), 'canonicalSha256': hashlib.sha256(target.read_bytes()).hexdigest(),
                        'rewrites': rewrites})
    return records
