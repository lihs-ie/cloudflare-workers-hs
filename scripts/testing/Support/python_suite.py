#!/usr/bin/env python3
"""Run discovered helper tests inside an externally measured Python process."""
import argparse
import json
from pathlib import Path
import unittest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-directory', required=True, type=Path)
    parser.add_argument('--result', required=True, type=Path)
    args = parser.parse_args()
    suite = unittest.TestSuite()
    for pattern in ['test_*.py', 'coverage_checks.py']:
        suite.addTests(unittest.defaultTestLoader.discover(str(args.test_directory), pattern=pattern))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    successful = result.wasSuccessful() and result.testsRun > 0
    args.result.write_text(json.dumps({'tests': result.testsRun, 'successful': successful}) + '\n')
    return 0 if successful else 1


if __name__ == '__main__':
    raise SystemExit(main())
