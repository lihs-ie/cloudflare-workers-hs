"""Record the resolved cross compiler and the plans used by reactor builds."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def compiler_evidence(root, output, environment):
    env_file = Path.home() / '.ghc-wasm/env'
    script = 'if ! command -v wasm32-wasi-ghc >/dev/null; then source "$1"; fi; command -v wasm32-wasi-ghc; printf "%s\\n" "$PATH"'
    command = ['bash', '-c', script, 'wasm-compiler', str(env_file)]
    resolved = subprocess.run(command, env=environment, capture_output=True, text=True, check=True)
    lines = resolved.stdout.splitlines()
    if len(lines) != 2:
        raise ValueError('Cross compiler resolution returned ambiguous paths')
    alias = Path(lines[0])
    compiler = alias.resolve()
    cabal = shutil.which('wasm32-wasi-cabal', path=lines[1])
    if cabal is None:
        raise ValueError('Missing cross-compiler Cabal wrapper')
    cabal = Path(cabal).resolve()
    records = []
    for label, argv, content in [('resolution', command, resolved.stdout),
                                 ('version', [str(compiler), '--numeric-version'], None),
                                 ('platform', [str(compiler), '--print-target-platform'], None)]:
        if content is None:
            content = subprocess.check_output(argv, env=environment, text=True)
        log = output / ('compiler-' + label + '.log')
        log.write_text(content)
        records.append({'command': argv, 'exitCode': 0, 'log': log.name, 'logSha256': digest(log)})
    version = (output / 'compiler-version.log').read_text().strip()
    platform = (output / 'compiler-platform.log').read_text().strip()
    if platform not in ('wasm32-wasi', 'wasm32-unknown-wasi'):
        raise ValueError('Coverage cross compiler does not target wasm32-wasi')
    return {'compiler': {'path': str(compiler), 'sha256': digest(compiler), 'version': version,
                         'cabal_path': str(cabal), 'cabal_sha256': digest(cabal), 'alias': str(alias), 'search_path': lines[1], 'platform': platform},
            'compilerCommands': records,
            'toolchainEnvironment': {'path': str(env_file), 'sha256': digest(env_file)} if env_file.is_file() else None}


def save_build_plan(root, output, directory, example, compiler):
    path = root / directory / 'cache/plan.json'
    plan = json.loads(path.read_text())
    if plan['compiler-id'] != 'ghc-' + compiler['version'] or plan['arch'] != 'wasm32' or plan['os'] != 'wasi':
        raise ValueError('WASM build plan differs from the recorded compiler')
    saved = output / 'plans' / (example + '.json')
    saved.parent.mkdir(exist_ok=True)
    shutil.copyfile(path, saved)
    return {'path': str(saved.relative_to(output)), 'sha256': digest(saved),
            'buildDirectory': str((root / directory).resolve()), 'compiler': plan['compiler-id']}
