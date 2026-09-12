#!/usr/bin/env python3
"""Build and test representative mutations in a disposable snapshot of the current tree."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
TARGET = 'cloudflare-workers:test:unit'
MUTATIONS = [
    ('http-method', 'HTTP.hs', 'methodToText GET = "GET"', 'methodToText GET = "POST"'),
    ('header-order', 'Headers.hs', '(flip (++))', '(++)'),
    ('kv-ttl', 'Binding/KV.hs', 'seconds >= 30', 'seconds >= 31'),
]
SUMMARY = re.compile(r'^\s*Passed:[ \t]*(\d+)(?:, Failed:[ \t]*|[ \t]*\n[ \t]*Failed:[ \t]*)(\d+)(?:[ \t]*\(|[ \t]*$)', re.M)


def verdict(record, baseline=False):
    """Only a completed runner with a nonempty, explicit summary can kill a mutant."""
    summaries = SUMMARY.findall(record['output'])
    if record['timed_out'] or len(summaries) != 1:
        return 'error'
    passed, failed = map(int, summaries[0])
    if passed + failed == 0:
        return 'error'
    if record['exit_code'] == 0 and failed == 0:
        return 'passed' if baseline else 'survived'
    if record['exit_code'] == 1 and failed > 0:
        return 'baseline-failed' if baseline else 'killed'
    return 'error'


def snapshot(root, destination):
    """Copy tracked and untracked sources from disk, including uncommitted edits."""
    files = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root
    ).decode().split('\0')
    digests = {}
    for name in sorted(set(files)):
        if not name or Path(name).parts[0] not in ('cloudflare-workers', 'testing-support'):
            continue
        source = root / name
        if not source.is_file():  # A tracked deletion remains deleted in the snapshot.
            continue
        content = source.read_bytes()
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(source.stat().st_mode & 0o777)
        digests[name] = hashlib.sha256(content).hexdigest()
    # Preserve the checked-in compiler, index-state and constraints, limiting packages
    # to this mutation suite so unrelated package builds cannot masquerade as kills.
    project = (root / 'cabal.project').read_text()
    pattern = r'(?m)^packages:[^\n]*(?:\n[ \t]+[^\n]*)*'
    if len(re.findall(pattern, project)) != 1:
        raise ValueError('Expected exactly one packages stanza in cabal.project')
    project = re.sub(pattern, 'packages: cloudflare-workers/cloudflare-workers.cabal\n  testing-support/testing-support.cabal', project)
    (destination / 'cabal.project').write_text(project)
    digests['cabal.project'] = hashlib.sha256((root / 'cabal.project').read_bytes()).hexdigest()
    return digests


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='New evidence directory (must not already exist)')
    parser.add_argument('--seed', type=int, default=73)
    parser.add_argument('--timeout', type=int, default=1800, help='Seconds per command')
    parser.add_argument('--mutation', choices=[item[0] for item in MUTATIONS], action='append')
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = (args.output or ROOT / 'artifacts/testing' / f'mutations-{stamp}').resolve()
    output.mkdir(parents=True, exist_ok=False)
    report = {'seed': args.seed, 'commands': [], 'mutations': [], 'status': 'incomplete'}
    env = os.environ.copy()
    env.update(SYDTEST_RETRIES='0', SYDTEST_GOLDEN_START='false', SYDTEST_GOLDEN_RESET='false')

    def save():
        (output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')

    def run(command, cwd, label):
        log = output / f'{len(report["commands"]):02d}-{label}.log'
        record = {'command': command, 'label': label, 'log': log.name, 'timed_out': False}
        print('+ ' + ' '.join(command), flush=True)
        try:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, start_new_session=True)
            try:
                text, _ = process.communicate(timeout=args.timeout)
            except subprocess.TimeoutExpired:
                record['timed_out'] = True
                os.killpg(process.pid, signal.SIGKILL)
                text, _ = process.communicate()
            record['exit_code'] = process.returncode
        except OSError as error:
            text, record['exit_code'] = str(error), 127
        log.write_text(text)
        report['commands'].append(record)
        save()
        return dict(record, output=text)

    try:
        with tempfile.TemporaryDirectory(prefix='workers-mutations-') as temporary:
            tree = Path(temporary).resolve()
            report['sources'] = snapshot(ROOT, tree)
            save()
            common = ['--enable-tests', '--project-file=cabal.project', '--builddir=dist-mutations']

            def build_and_test(label):
                built = run(['cabal', 'build', TARGET, *common, '-j2'], tree, label + '-build')
                if built['exit_code'] != 0 or built['timed_out']:
                    return {'status': 'build-error'}
                located = run(['cabal', 'list-bin', TARGET, *common], tree, label + '-binary')
                if located['exit_code'] != 0 or located['timed_out']:
                    return {'status': 'binary-error'}
                binary = Path(located['output'].strip())
                if not binary.is_absolute() or not binary.resolve().is_relative_to(tree) or not binary.is_file():
                    return {'status': 'binary-error'}
                tested = run([str(binary), '--seed', str(args.seed), '--synchronous', '--terse',
                              '--no-skip-passed', '--no-fail-fast', '--retries', '0',
                              '--max-success', '100', '--no-golden-start', '--no-golden-reset'], tree, label + '-test')
                return {'status': verdict(tested, baseline=label == 'baseline')}

            report['baseline'] = build_and_test('baseline')
            if report['baseline']['status'] != 'passed':
                raise ValueError('Baseline did not pass; mutations were not executed')
            selected = set(args.mutation or [item[0] for item in MUTATIONS])
            for name, relative, before, after in MUTATIONS:
                if name not in selected:
                    continue
                path = tree / 'cloudflare-workers/src/Cloudflare/Workers' / relative
                original = path.read_text()
                if original.count(before) != 1:
                    raise ValueError(f'{name}: expected exactly one original fragment, found {original.count(before)}')
                try:
                    path.write_text(original.replace(before, after, 1))
                    result = build_and_test(name)
                    result.update(name=name, file=str(path.relative_to(tree)), before=before, after=after)
                    report['mutations'].append(result)
                    print(name + ': ' + result['status'], flush=True)
                finally:
                    path.write_text(original)
                    save()
            report['status'] = 'passed' if all(r['status'] == 'killed' for r in report['mutations']) else 'failed'
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        report['status'], report['error'] = 'error', str(error)
    finally:
        save()
    print(f'Evidence: {output}', flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
