#!/usr/bin/env python3
"""Verify that Internal modules are private to their Cabal library components."""

import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]

PACKAGES = {
    "cloudflare-workers": {
        "cabal": "cloudflare-workers/cloudflare-workers.cabal",
        "public": "Cloudflare.Workers.HTTP",
        "internal": "Cloudflare.Workers.Internal.FFI.Bytes",
    },
    "servant-cloudflare-workers": {
        "cabal": "servant-cloudflare-workers/servant-cloudflare-workers.cabal",
        "public": "Servant.Cloudflare.Workers.Server",
        "internal": "Servant.Cloudflare.Workers.Server.Internal.Router",
    },
    "servant-cloudflare-workers-client": {
        "cabal": "servant-cloudflare-workers-client/servant-cloudflare-workers-client.cabal",
        "public": "Servant.Cloudflare.Workers.Client.Fetch",
        "internal": "Servant.Cloudflare.Workers.Client.Internal.FFI.Fetch",
    },
    "servant-cloudflare-workers-access": {
        "cabal": "servant-cloudflare-workers-access/servant-cloudflare-workers-access.cabal",
        "public": "Servant.Cloudflare.Workers.Access",
        "internal": "Servant.Cloudflare.Workers.Access.Internal.Claims",
    },
}

MODULE = re.compile(r"\b[A-Z][A-Za-z0-9_']*(?:\.[A-Z][A-Za-z0-9_']*)+\b")


def exposed_modules(text):
    """Return module names from every exposed-modules field in a Cabal file."""
    lines = text.splitlines()
    modules = []
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)exposed-modules\s*:\s*(.*)$", lines[index])
        if match is None:
            index += 1
            continue
        indentation = len(match.group(1).expandtabs(8))
        field = [match.group(2)]
        index += 1
        while index < len(lines):
            line = lines[index]
            if not line.strip():
                break
            content = line.lstrip()
            continuation_indentation = len(line[: len(line) - len(content)].expandtabs(8))
            if continuation_indentation <= indentation:
                break
            field.append(content)
            index += 1
        uncommented = "\n".join(part.split("--", 1)[0] for part in field)
        modules.extend(MODULE.findall(uncommented))
    return modules


def manifest_errors(root):
    errors = []
    for package, details in PACKAGES.items():
        path = root / details["cabal"]
        if not path.is_file():
            errors.append(f"{details['cabal']}: missing Cabal file")
            continue
        for module in exposed_modules(path.read_text()):
            if "Internal" in module.split("."):
                errors.append(
                    f"{details['cabal']}: {module} must be in other-modules, not exposed-modules"
                )
    return errors


def ghc_command(packages, source):
    command = [
        "cabal",
        "exec",
        "--project-file=cabal.project",
        "--",
        "ghc",
        "-fno-code",
        "-fforce-recomp",
        "-v0",
        "-hide-all-packages",
        "-package",
        "base",
    ]
    for package in packages:
        command.extend(["-package", package])
    return [*command, str(source)]


def consumer_errors(root, run=subprocess.run):
    errors = []
    build = run(
        [
            "cabal",
            "build",
            "--project-file=cabal.project",
            *[f"{package}:lib:{package}" for package in PACKAGES],
        ],
        cwd=root,
        text=True,
        capture_output=True,
    )
    if build.returncode != 0:
        return ["could not build public libraries before consumer probes:\n" + build.stderr]

    with tempfile.TemporaryDirectory(prefix="internal-module-boundaries-") as directory:
        source = Path(directory) / "Probe.hs"
        imports = "\n".join(
            f"import qualified {details['public']}" for details in PACKAGES.values()
        )
        source.write_text(f"module Probe where\n{imports}\nprobe :: ()\nprobe = ()\n")
        public = run(
            ghc_command(PACKAGES, source),
            cwd=root,
            text=True,
            capture_output=True,
        )
        if public.returncode != 0:
            return ["public import control failed; Internal failures would be inconclusive:\n" + public.stderr]

        for package, details in PACKAGES.items():
            internal = details["internal"]
            source.write_text(
                f"module Probe where\nimport qualified {internal}\nprobe :: ()\nprobe = ()\n"
            )
            result = run(
                ghc_command([package], source),
                cwd=root,
                text=True,
                capture_output=True,
            )
            diagnostic = (result.stdout + "\n" + result.stderr).lower()
            if result.returncode == 0:
                errors.append(f"{package}: external consumer unexpectedly imported {internal}")
            elif internal.lower() not in diagnostic or not any(
                phrase in diagnostic for phrase in ("hidden module", "not exposed")
            ):
                errors.append(
                    f"{package}: import failed for an unrelated reason instead of module visibility:\n"
                    + result.stderr
                )
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("manifest", "consumer"))
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    root = args.root.resolve()
    errors = manifest_errors(root)
    if args.mode == "consumer" and not errors:
        errors.extend(consumer_errors(root))
    report = {"mode": args.mode, "packages": sorted(PACKAGES), "errors": errors}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
