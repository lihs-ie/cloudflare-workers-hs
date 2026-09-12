"""Contracts of the kcov fixture builder and strict evidence reader."""
import importlib.util
from pathlib import Path
import tempfile
import json
import os
import subprocess
import sys
import unittest

SPEC = importlib.util.spec_from_file_location("shell_coverage", Path(__file__).resolve().parents[1] / "shell-coverage.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def write_boundary_evidence(work):
    """Synthetic Docker-boundary payload; never represents a real kcov run."""
    for directory in (work / "cases").iterdir():
        index, mode = directory.name.split("-", 1)
        source = MODULE.SCRIPTS[int(index)]
        expected = {"capture": 45, "list-bin": 43, "post-link": 44, "write": 46,
                    "build-failure": 42, "invalid-target": 2,
                    "missing": 1 if index in ("1", "5") else 127}.get(mode, 0)
        (directory / "returncode").write_text(str(expected))
        (directory / "tmp").mkdir()
        (directory / "output.log").write_text("synthetic boundary")
        calls = ""
        if mode not in ("missing", "invalid-target"):
            calls += "node <capture>\n"
            if mode != "capture":
                calls += "cabal <build> <exe:runtime-tests> <custom.project> <custom-build>\n"
                if mode != "build-failure":
                    calls += "cabal <list-bin>\n"
                    if mode != "list-bin":
                        calls += "post-link <--input> </work/binary.wasm> <--output>\n"
                        if mode != "post-link":
                            calls += "node <write>\n"
        if calls:
            (directory / "calls.log").write_text(calls)
        xml = directory / "kcov" / "synthetic" / "cobertura.xml"
        xml.parent.mkdir(parents=True)
        xml.write_text(f'<coverage><class filename="/work/repo/{source}"><lines><line number="2" hits="1" /></lines></class></coverage>')
    (work / "version.txt").write_text("kcov synthetic-boundary")


class ShellBuildContracts(unittest.TestCase):
    def test_fixture_copies_authored_scripts_without_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            cases = MODULE.prepare(work)
            self.assertEqual({case["source"] for case in cases}, set(MODULE.SCRIPTS))
            self.assertEqual(len({case["identifier"] for case in cases}), len(cases))
            for relative in MODULE.SCRIPTS:
                self.assertEqual((work / "repo" / relative).read_bytes(), (MODULE.ROOT / relative).read_bytes())
            self.assertEqual(sum(case["mode"] == "opt" for case in cases), 4)
            self.assertEqual(sum(case["mode"] == "build-failure" for case in cases), 6)

    def test_source_drift_rejects_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            cases = MODULE.prepare(work)
            (work / "repo" / MODULE.SCRIPTS[0]).write_text("changed")
            with self.assertRaisesRegex(AssertionError, "Source changed"):
                MODULE.collect(work, cases)

    def test_nonmatching_exit_status_rejects_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            cases = MODULE.prepare(work)
            directory = work / "cases" / cases[0]["identifier"]
            (directory / "returncode").write_text("42")
            (directory / "output.log").write_text("simulated failure")
            with self.assertRaises(AssertionError):
                MODULE.collect(work, cases[:1])

    def test_unclean_snapshot_rejects_report(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            cases = MODULE.prepare(work)
            directory = work / "cases" / cases[0]["identifier"]
            (directory / "returncode").write_text("0")
            (directory / "tmp").mkdir()
            (directory / "tmp" / "leftover").write_text("snapshot")
            with self.assertRaisesRegex(AssertionError, "cleanup"):
                MODULE.collect(work, cases[:1])

    def test_all_contracts_and_xml_union(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            cases = MODULE.prepare(work)
            write_boundary_evidence(work)
            extra = work / "cases" / cases[0]["identifier"] / "kcov/extra/cobertura.xml"
            extra.parent.mkdir()
            extra.write_text(f'<coverage><class filename="unrelated"><lines /></class><class filename="/work/repo/{cases[0]["source"]}"><lines><line number="2" hits="7" /><line number="3" hits="0" /></lines></class></coverage>')
            result = MODULE.collect(work, cases)
            self.assertEqual(result["contracts"]["passed"], 60)
            self.assertEqual(result["files"][cases[0]["source"]]["lines"], {"2": 7, "3": 0})
            self.assertTrue(all(not value["branch_coverage"] for value in result["files"].values()))

    def test_missing_and_invalid_xml_are_rejected(self):
        for kind in ("missing", "malformed", "path", "line-zero", "line-leading-zero", "line-outside", "hits", "version"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                work = Path(temporary)
                cases = MODULE.prepare(work)
                write_boundary_evidence(work)
                source = MODULE.SCRIPTS[0]
                targets = list((work / "cases").glob("0-*/kcov/synthetic/cobertura.xml"))
                if kind == "missing":
                    targets[0].unlink()
                elif kind == "malformed":
                    targets[0].write_text("not XML")
                elif kind == "version":
                    (work / "version.txt").write_text("")
                else:
                    line = {"line-zero": "0", "line-leading-zero": "02", "line-outside": "9999"}.get(kind, "2")
                    hits = "-1" if kind == "hits" else "1"
                    path = "/forged/work/repo/" + source if kind == "path" else "/work/repo/" + source
                    for xml in targets:
                        xml.write_text(f'<coverage><class filename="{path}"><lines><line number="{line}" hits="{hits}" /></lines></class></coverage>')
                with self.assertRaises((AssertionError, MODULE.ET.ParseError)):
                    MODULE.collect(work, cases)

    def test_cli_boundary_and_failures(self):
        direct = subprocess.run([sys.executable, str(Path(__file__)), "ShellBuildContracts.test_fixture_copies_authored_scripts_without_changes"], capture_output=True)
        self.assertEqual(direct.returncode, 0, direct.stderr)
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            tools = base / "bin"
            tools.mkdir()
            docker = tools / "docker"
            docker.write_text("#!" + sys.executable + "\n" +
                "import importlib.util,sys\nfrom pathlib import Path\n" +
                f"spec=importlib.util.spec_from_file_location('boundary', {str(Path(__file__).resolve())!r})\n" +
                "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\n" +
                "work=Path(sys.argv[sys.argv.index('-v')+1].removesuffix(':/work'))\nmodule.write_boundary_evidence(work)\n")
            docker.chmod(0o755)
            env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"])
            output = base / "success"
            command = [sys.executable, str(MODULE.__file__), "--output", str(output)]
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((output / "coverage.json").read_text())
            self.assertEqual(report["collector"]["version"], "kcov synthetic-boundary")
            self.assertEqual(report["contracts"]["passed"], 60)
            original = (output / "coverage.json").read_bytes()
            self.assertNotEqual(subprocess.run(command, env=env, capture_output=True).returncode, 0)
            self.assertEqual((output / "coverage.json").read_bytes(), original)
            self.assertEqual(subprocess.run([sys.executable, str(MODULE.__file__)], capture_output=True).returncode, 2)
            docker.write_text("#!/bin/sh\nexit 37\n")
            failed = base / "failed"
            result = subprocess.run([sys.executable, str(MODULE.__file__), "--output", str(failed)], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((failed / "coverage.json").exists())
            self.assertTrue((failed / "docker.log").exists())


if __name__ == "__main__":
    unittest.main()
