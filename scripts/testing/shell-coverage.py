#!/usr/bin/env python3
"""Measure real Bash execution with kcov; compiler and manifest boundaries are doubles."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import xml.etree.ElementTree as ET

KCOV_IMAGE = "kcov/kcov@sha256:481289ae32e55e5b733019515acd10948a4f76dfed381765577db909664fc603"

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = [f"examples/{name}/scripts/{script}" for name, script in [
    ("quickstart", "build-wasm.sh"), ("library-examples", "build.sh"),
    ("minimal", "build.sh"), ("static-assets", "build.sh"),
    ("realtime", "build.sh"), ("workflows", "build.sh")]]


def executable(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/bash\nset -eu\n" + text)
    path.chmod(0o755)


def prepare(work: Path) -> list[dict]:
    """Copy exact source bytes and create disposable external-tool contracts."""
    for relative in SCRIPTS:
        destination = work / "repo" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / relative, destination)
        (destination.parent.parent / "worker").mkdir()
    # Keep stdout clean: list-bin is command substitution in the authored scripts.
    executable(work / "tools/wasm32-wasi-cabal", '''{ printf 'cabal'; printf ' <%s>' "$@"; printf '\\n'; } >> "$CALL_LOG"
if [ "$1" = build ] && [ "${FAIL_BUILD:-0}" = 1 ]; then exit 42; fi
if [ "$1" = list-bin ] && [ "${FAIL_STAGE:-}" = list-bin ]; then exit 43; fi
if [ "$1" = list-bin ]; then echo /work/binary.wasm; fi
''')
    executable(work / "tools/wasm32-wasi-ghc", 'echo /work/lib\n')
    executable(work / "lib/post-link.mjs", '''{ printf 'post-link'; printf ' <%s>' "$@"; printf '\\n'; } >> "$CALL_LOG"
[ "${FAIL_STAGE:-}" != post-link ] || exit 44
[ "$1" = --input ] && [ "$3" = --output ]
printf fixture > "$4"
''')
    executable(work / "base/node", '''{ printf 'node'; printf ' <%s>' "$@"; printf '\\n'; } >> "$CALL_LOG"
''')
    node = work / "base/node"
    node.write_text(node.read_text() + r'''if [ "$1" = --input-type=module ]; then operation="$3"; else operation="$2"; fi
case "${FAIL_STAGE:-}:$operation" in
capture:*capture*) exit 45 ;;
write:*write*) exit 46 ;;
esac
''')
    (work / "binary.wasm").write_bytes(b"fixture-only-not-wasm")
    cases = []
    for index, relative in enumerate(SCRIPTS):
        modes = ["direct", "home", "missing", "build-failure", "override", "capture", "list-bin", "post-link", "write"]
        if index not in (1, 5):
            modes.append("opt")
        if index == 0:
            modes += ["runtime-tests", "invalid-target"]
        for mode in modes:
            cases.append({"identifier": f"{index}-{mode}", "source": relative, "mode": mode,
                          "expected": {"capture": 45, "list-bin": 43, "post-link": 44, "write": 46}.get(mode, 42 if mode == "build-failure" else 2 if mode == "invalid-target" else (1 if index in (1,5) else 127) if mode == "missing" else 0)})
    commands = ['set -eu', 'kcov --version > /work/version.txt', 'mkdir -p /opt/ghc-wasm']
    for case in cases:
        identifier, mode = case["identifier"], case["mode"]
        directory = work / "cases" / identifier
        directory.mkdir(parents=True)
        commands += [f'mkdir -p /work/cases/{identifier}/home /work/cases/{identifier}/tmp',
                     'rm -f /opt/ghc-wasm/env',
                     f'export HOME=/work/cases/{identifier}/home TMPDIR=/work/cases/{identifier}/tmp CALL_LOG=/work/cases/{identifier}/calls.log',
                     'export PATH=/work/base:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                     'unset FAIL_BUILD FAIL_STAGE WASM_BUILD_DIR WASM_PROJECT_FILE']
        if mode in ("home", "opt"):
            env = '$HOME/.ghc-wasm/env' if mode == "home" else '/opt/ghc-wasm/env'
            commands += ['mkdir -p "$HOME/.ghc-wasm"', f"echo 'export PATH=/work/tools:$PATH' > {env}"]
        elif mode != "missing":
            commands += ['export PATH=/work/tools:$PATH']
        if mode == "build-failure":
            commands += ['export FAIL_BUILD=1']
        if mode in ("capture", "list-bin", "post-link", "write"):
            commands += [f"export FAIL_STAGE={mode}"]
        if mode == "override":
            commands += ['export WASM_BUILD_DIR=custom-build WASM_PROJECT_FILE=custom.project']
        arg = " runtime-tests" if mode == "runtime-tests" else " invalid" if mode == "invalid-target" else ""
        commands += ['set +e', f'kcov --include-path=/work/repo/{case["source"]} /work/cases/{identifier}/kcov /work/repo/{case["source"]}{arg} > /work/cases/{identifier}/output.log 2>&1',
                     f'echo $? > /work/cases/{identifier}/returncode', 'set -e']
    (work / "run.sh").write_text("\n".join(commands) + "\n")
    return cases


def collect(work: Path, cases: list[dict]) -> dict:
    for relative in SCRIPTS:
        assert (work / "repo" / relative).read_bytes() == (ROOT / relative).read_bytes(), f"Source changed during collection: {relative}"
    files = {relative: {"sha256": hashlib.sha256((ROOT / relative).read_bytes()).hexdigest(),
                        "lines": {}, "branch_coverage": False} for relative in SCRIPTS}
    for case in cases:
        directory = work / "cases" / case["identifier"]
        actual = int((directory / "returncode").read_text())
        assert actual == case["expected"], (case, actual, (directory / "output.log").read_text())
        assert not list((directory / "tmp").iterdir()), f"Snapshot cleanup failed: {case}"
        calls = (directory / "calls.log").read_text() if (directory / "calls.log").exists() else ""
        if actual == 0:
            assert "cabal <build> <exe:" in calls and "cabal <list-bin>" in calls
            assert "post-link <--input> </work/binary.wasm> <--output>" in calls
            assert calls.count("node <") == 2
            if case["mode"] == "override":
                assert "custom.project" in calls and "custom-build" in calls
            if case["mode"] == "runtime-tests":
                assert "<exe:runtime-tests>" in calls
        elif case["mode"] == "build-failure":
            assert calls.count("node <") == 1 and "post-link" not in calls and "list-bin" not in calls
        elif case["mode"] == "capture":
            assert calls.count("node <") == 1 and "cabal" not in calls
        elif case["mode"] == "list-bin":
            assert "cabal <list-bin>" in calls and "post-link" not in calls
        elif case["mode"] == "post-link":
            assert "post-link" in calls and calls.count("node <") == 1
        elif case["mode"] == "write":
            assert "post-link" in calls and calls.count("node <") == 2
        else:
            assert not calls
        xmls = list((directory / "kcov").rglob("cobertura.xml"))
        assert xmls, f"No kcov evidence: {case}"
        for xml in xmls:
            for cls in ET.parse(xml).iter("class"):
                if cls.attrib["filename"] == "/work/repo/" + case["source"]:
                    for line in cls.findall("./lines/line"):
                        number, hits = line.attrib["number"], int(line.attrib["hits"])
                        assert str(int(number)) == number and 1 <= int(number) <= len((ROOT / case["source"]).read_text().splitlines()), "Invalid source line"
                        assert hits >= 0, "Invalid hit count"
                        files[case["source"]]["lines"][number] = max(hits, files[case["source"]]["lines"].get(number, 0))
    assert all(item["lines"] for item in files.values()), "Missing source line mapping"
    version = (work / "version.txt").read_text().strip()
    assert version.startswith("kcov "), "Invalid collector version"
    return {"schema": 1, "collector": {"name": "kcov", "version": version, "runtime": "Linux Docker / real Bash", "boundaries": "compiler, post-link, and manifest are test doubles"}, "files": files, "contracts": {"passed": len(cases), "cases": cases}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--image", default=KCOV_IMAGE)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    work = output / "fixture"
    work.mkdir()
    cases = prepare(work)
    with (output / "docker.log").open("w") as log:
        subprocess.run(["docker", "run", "--rm", "--security-opt", "seccomp=unconfined", "--entrypoint", "/bin/bash", "-v", f"{work}:/work", args.image, "/work/run.sh"], stdout=log, stderr=subprocess.STDOUT, check=True)
    result = collect(work, cases)
    result["collector"]["image"] = args.image
    (output / "coverage.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"report": str(output / "coverage.json"), "contracts": len(cases)}))

if __name__ == "__main__":
    main()
