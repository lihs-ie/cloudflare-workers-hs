"""Run instrumented Cabal tests without Cabal's automatic HTML generation.

Only fresh per-suite counters and uniquely matching mix contents enter the proof.
The caller must reject nonzero exit_code before forwarding its explicit files.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import shutil

TIX = re.compile(r'TixModule\s+("(?:[^"\\]|\\.)*")\s+(\d+)\s+(\d+)\s+\[([\d,\s]*)\]')
MIX = re.compile(r'Mix\s+("(?:[^"\\]|\\.)*").*? UTC\s+(\d+)\s')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def counters(text):
    records = []
    matches = list(TIX.finditer(text))
    residue = TIX.sub('MODULE', text)
    if not re.fullmatch(r'\s*Tix\s*\[\s*MODULE(?:\s*,\s*MODULE)*\s*\]\s*', residue):
        raise ValueError('Malformed counter separators')
    for match in matches:
        name, fingerprint, count, values = match.groups()
        if not re.fullmatch(r'\s*(?:\d+(?:\s*,\s*\d+)*)?\s*', values):
            raise ValueError('Malformed counter values')
        if len([x for x in values.split(',') if x.strip()]) != int(count):
            raise ValueError('Counter count mismatch')
        name = json.loads(name)
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('Unsafe module name')
        records.append((name, fingerprint, int(count)))
    if len(records) != len(set(name for name, _, _ in records)):
        raise ValueError('Duplicate module counters')
    return records


def summary(text):
    passed = re.findall(r'^\s*Passed:\s+(\d+)\s*$', text, re.M)
    failed = re.findall(r'^\s*Failed:\s+(\d+)\s*$', text, re.M)
    return len(passed) == 1 and int(passed[0]) > 0 and failed == ['0']


def copy_mix(records, candidates, output):
    result = {}
    for name, fingerprint, count in records:
        matches = {}
        for path in candidates:
            if path.stem != name.rsplit('/', 1)[-1]:
                continue
            content = path.read_text()
            match = MIX.match(content)
            if match and match.group(2) == fingerprint:
                boxes = re.findall(r'\(\d+:\d+-\d+:\d+,', content)
                if len(boxes) != count:
                    raise ValueError('Mix counter count mismatch: ' + name)
                matches[content] = path
        if len(matches) != 1:
            raise ValueError('Missing or ambiguous mix: ' + name)
        relative = Path('mix') / fingerprint / (name + '.mix')
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        content = next(iter(matches))
        if destination.exists() and destination.read_text() != content:
            raise ValueError('Conflicting copied mix')
        destination.write_text(content)
        result[str(relative)] = digest(destination)
    return result


def collect(root, output, targets, snapshot, match=None, build_directory=None, environment=None):
    root, output = Path(root).resolve(), Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    build = (root / Path(build_directory or 'dist-testing-coverage')).resolve()
    proof = {'schema': 1, 'sources': snapshot(), 'commands': [], 'snapshots': {}, 'mixFiles': {}, 'errors': [], 'exit_code': 1}
    environment = dict(os.environ if environment is None else environment)
    environment.pop('HPCTIXFILE', None)
    environment.pop('GHCRTS', None)
    ffi = Path('/opt/homebrew/opt/libffi/include')
    if ffi.is_dir():
        environment['C_INCLUDE_PATH'] = str(ffi) + (os.pathsep + environment['C_INCLUDE_PATH'] if environment.get('C_INCLUDE_PATH') else '')

    def execute(argv, cwd, label, env=None):
        try:
            process = subprocess.run(argv, cwd=cwd, env=env or environment, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=1200)
        except subprocess.TimeoutExpired as error:
            partial = error.stdout or ''
            if isinstance(partial, bytes):
                partial = partial.decode(errors='replace')
            process = subprocess.CompletedProcess(argv, 124, partial + '\nHost coverage command timed out.\n')
        except OSError as error:
            process = subprocess.CompletedProcess(argv, 127, str(error) + '\n')
        log = output / (label + '.log')
        log.write_text(process.stdout)
        proof['commands'].append({'command': argv, 'cwd': str(cwd), 'exitCode': process.returncode, 'log': log.name, 'logSha256': digest(log)})
        if process.returncode:
            raise ValueError('Command failed: ' + label)
        return process.stdout

    try:
        if not targets or len(targets) != len(set(targets)):
            raise ValueError('Targets must be nonempty and unique')
        compiler = Path(shutil.which('ghc', path=environment.get('PATH')) or '').resolve()
        if not compiler.is_file():
            raise ValueError('Missing GHC compiler')
        version = execute([str(compiler), '--numeric-version'], root, 'compiler').strip()
        proof['compiler'] = {'path': str(compiler), 'sha256': digest(compiler), 'version': version}
        common = ['--project-file=cabal.project', '--builddir=' + str(build), '--enable-coverage', '--with-compiler=' + str(compiler)]
        execute(['cabal', 'build', *targets, *common, '-j2'], root, 'build')
        plan_path = build / 'cache/plan.json'
        plan_data = json.loads(plan_path.read_text())
        if plan_data.get('compiler-id') != 'ghc-' + version:
            raise ValueError('Build plan compiler differs from requested GHC')
        plan = plan_data['install-plan']
        proof['planSha256'] = digest(plan_path)
        for item in plan:
            source = item.get('pkg-src', {})
            if source.get('type') == 'local':
                package_root = (root / source['path']).resolve()
                if not package_root.is_relative_to(root):
                    raise ValueError('Nonlocal package data path')
                cabal_files = list(package_root.glob('*.cabal'))
                if len(cabal_files) != 1:
                    raise ValueError('Ambiguous package data configuration')
                data_dirs = re.findall(r'^data-dir:\s*(.+)$', cabal_files[0].read_text(), re.M | re.I)
                if len(data_dirs) > 1:
                    raise ValueError('Ambiguous data-dir')
                data_directory = (package_root / (data_dirs[0].strip() if data_dirs else '.')).resolve()
                if not data_directory.is_relative_to(package_root):
                    raise ValueError('External package data-dir')
                environment[item['pkg-name'].replace('-', '_') + '_datadir'] = str(data_directory)
        candidates = sorted(build.rglob('*.mix'))
        for index, target in enumerate(targets):
            package, kind, suite = target.split(':')
            if kind != 'test':
                raise ValueError('Only test components are accepted')
            entries = [item for item in plan if item.get('pkg-name') == package and item.get('component-name') == 'test:' + suite]
            if len(entries) != 1:
                raise ValueError('Ambiguous test component in plan')
            entry = entries[0]
            cwd = (root / entry['pkg-src']['path']).resolve()
            if not cwd.is_relative_to(root) or entry['pkg-src']['type'] != 'local':
                raise ValueError('Test source is not local')
            binary = (root / Path(execute(['cabal', 'list-bin', target, *common], root, f'list-{index}').strip())).resolve()
            if not binary.is_relative_to(build) or not binary.is_file() or binary != (root / entry['bin-file']).resolve():
                raise ValueError('Binary differs from local build plan')
            tix = output / f'suite-{index}.tix'
            if tix.exists():
                raise ValueError('Refusing stale counters')
            argv = [str(binary), *(['--match', match] if match else [])]
            text = execute(argv, cwd, f'suite-{index}', {**environment, 'HPCTIXFILE': str(tix)})
            if not summary(text):
                raise ValueError('Missing, failed or empty test summary')
            if not tix.is_file() or tix.is_symlink():
                raise ValueError('Missing fresh counters')
            records = counters(tix.read_text())
            proof['mixFiles'].update(copy_mix(records, candidates, output))
            proof['snapshots'][tix.name] = digest(tix)
        if digest(compiler) != proof['compiler']['sha256']:
            raise ValueError('Compiler changed during host coverage')
        if snapshot() != proof['sources']:
            raise ValueError('Sources changed during host coverage')
        if {str(p.relative_to(output)) for p in (output / 'mix').rglob('*.mix')} != set(proof['mixFiles']):
            raise ValueError('Unlisted mix files')
        proof['exit_code'] = 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        proof['errors'].append(str(error))
    (output / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    return proof
