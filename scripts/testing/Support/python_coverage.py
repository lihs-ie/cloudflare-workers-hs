#!/usr/bin/env python3
"""Collect helper-test and child-process line/branch evidence without exclusions."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import subprocess

# Import the installed distribution before tests add scripts/testing/coverage.py
# to sys.path. That repository file is a report merger, not this distribution.
import coverage

ROOT = Path(__file__).resolve().parents[3]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--test-directory', type=Path, default=Path(__file__).parent, help='Helper test directory; defaults to the full suite')
    args = parser.parse_args()
    output = (args.output or ROOT / 'artifacts/testing' / ('python-coverage-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))).resolve()
    if not output.is_relative_to(ROOT) or output.exists():
        parser.error('Choose a new output directory inside the repository')
    test_directory = args.test_directory.resolve()
    if not test_directory.is_relative_to(ROOT) or not test_directory.is_dir():
        parser.error('Choose an existing test directory inside the repository')
    output.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location('testing_runner', ROOT / 'scripts/testing/run.py')
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    sources = runner.source_snapshot()
    config = output / 'coverage.ini'
    include = '\n    '.join(str(ROOT / name) for name in sources if name.endswith('.py'))
    config.write_text('[run]\nbranch = true\nparallel = true\npatch = subprocess\ndata_file = ' + str(output / '.coverage') + '\ninclude =\n    ' + include + '\n[report]\nexclude_lines =\npartial_branches =\n')
    measured = coverage.Coverage(config_file=str(config))
    measured.clear_exclude('exclude')
    measured.clear_exclude('partial')
    # Keep the driver outside its own measurement process: nested Coverage.start()
    # replaces an enclosing collector's trace and hides driver setup/finalization.
    suite_result = output / 'suite-result.json'
    command = [sys.executable, '-m', 'coverage', 'run', '--rcfile', str(config),
               str(Path(__file__).with_name('python_suite.py')),
               '--test-directory', str(test_directory), '--result', str(suite_result)]
    with (output / 'tests.log').open('w') as log:
        completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
    result = json.loads(suite_result.read_text()) if suite_result.is_file() else {'tests': 0, 'successful': False}
    errors = []
    report = output / 'python.json'
    try:
        measured.combine(data_paths=[str(output)], strict=True, keep=True)
        measured.save()
        measured.json_report(outfile=str(report))
        measured.html_report(directory=str(output / 'html'))
    except coverage.exceptions.NoDataError:
        errors.append('No Python coverage data was produced')
        report.write_text(json.dumps({'meta': {'branch_coverage': True}, 'files': {}}))
    if completed.returncode != 0 or not result['successful'] or result['tests'] <= 0:
        errors.append('Helper test run failed or contained no tests')
    if sources != runner.source_snapshot():
        errors.append('Source inputs changed during collection')
    proof = {'sources': sources, 'exit_code': 1 if errors else 0, 'errors': errors,
             'sha256': hashlib.sha256(report.read_bytes()).hexdigest(), 'tests': result['tests'],
             'collector': {'name': 'coverage.py', 'version': coverage.__version__, 'branch': True, 'subprocesses': True}}
    (output / 'proof.json').write_text(json.dumps(proof, indent=2))
    if not errors:
        (ROOT / 'artifacts/testing/python-coverage-latest.json').write_text(json.dumps({'report': str(report.relative_to(ROOT)), 'proof': str((output / 'proof.json').relative_to(ROOT))}))
    print(json.dumps({'output': str(output), 'tests': result['tests'], 'errors': errors}))
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
