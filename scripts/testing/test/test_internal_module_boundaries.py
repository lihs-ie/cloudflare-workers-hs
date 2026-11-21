"""Contracts for the Internal module visibility gate."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "internal-module-boundaries.py"
SPEC = importlib.util.spec_from_file_location("internal_module_boundaries", SCRIPT)
boundaries = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(boundaries)


def write_manifests(root, exposed="Public.API"):
    for details in boundaries.PACKAGES.values():
        path = root / details["cabal"]
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "cabal-version: 3.0\n"
            "name: fixture\n"
            "library\n"
            f"  exposed-modules: {exposed}\n"
            "  other-modules: Private.Implementation\n"
        )


class InternalModuleBoundaryTests(unittest.TestCase):
    def test_exposed_module_parser_handles_continuations_comments_and_components(self):
        text = """library
  exposed-modules: Public.One, Public.Two -- comment
    Public.Three
  other-modules: Public.Internal.Hidden

library helper
  exposed-modules:
    Helper.Public
"""
        self.assertEqual(
            boundaries.exposed_modules(text),
            ["Public.One", "Public.Two", "Public.Three", "Helper.Public"],
        )

    def test_manifest_check_rejects_internal_path_segment_only_when_exposed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_manifests(root)
            self.assertEqual(boundaries.manifest_errors(root), [])
            first = next(iter(boundaries.PACKAGES.values()))
            path = root / first["cabal"]
            path.write_text(path.read_text().replace("Public.API", "Public.Internal.API"))
            errors = boundaries.manifest_errors(root)
            self.assertEqual(len(errors), 1)
            self.assertIn("must be in other-modules", errors[0])

    def test_consumer_check_requires_public_control_and_visibility_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            calls = []

            def successful_visibility_run(command, **kwargs):
                calls.append(command)
                if command[1] == "build" or len(calls) == 2:
                    return subprocess.CompletedProcess(command, 0, "", "")
                module = (Path(command[-1]).read_text().split("import qualified ", 1)[1].splitlines()[0])
                return subprocess.CompletedProcess(
                    command, 1, "", f"Could not load module '{module}': it is a hidden module"
                )

            self.assertEqual(boundaries.consumer_errors(root, successful_visibility_run), [])
            self.assertEqual(len(calls), 6)

            calls.clear()

            def unrelated_failure(command, **kwargs):
                calls.append(command)
                if command[1] == "build" or len(calls) == 2:
                    return subprocess.CompletedProcess(command, 0, "", "")
                return subprocess.CompletedProcess(command, 1, "", "parse error")

            errors = boundaries.consumer_errors(root, unrelated_failure)
            self.assertEqual(len(errors), 4)
            self.assertTrue(all("unrelated reason" in error for error in errors))

    def test_consumer_check_rejects_an_import_that_compiles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def always_succeeds(command, **kwargs):
                return subprocess.CompletedProcess(command, 0, "", "")

            errors = boundaries.consumer_errors(root, always_succeeds)
            self.assertEqual(len(errors), 4)
            self.assertTrue(all("unexpectedly imported" in error for error in errors))

    def test_consumer_check_stops_when_the_control_cannot_establish_a_valid_build(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for failing_call, expected in ((1, "could not build"), (2, "inconclusive")):
                calls = []

                def fail_selected_call(command, **kwargs):
                    calls.append(command)
                    code = 1 if len(calls) == failing_call else 0
                    return subprocess.CompletedProcess(command, code, "", "control failure")

                with self.subTest(failing_call=failing_call):
                    errors = boundaries.consumer_errors(root, fail_selected_call)
                    self.assertEqual(len(errors), 1)
                    self.assertIn(expected, errors[0])
                    self.assertEqual(len(calls), failing_call)


if __name__ == "__main__":
    unittest.main()
