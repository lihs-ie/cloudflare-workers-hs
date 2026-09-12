#!/usr/bin/env python3
"""Run dev HTTP tests in Docker; export evidence even when tests fail."""
import datetime
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]

def main():
    subprocess.run(["docker", "info"], check=True, stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix="workers-docker-") as directory:
        image_file = pathlib.Path(directory) / "image"
        subprocess.run(["docker", "build", "--iidfile", str(image_file), "-f", "docker/dev-tests.Dockerfile", "."], cwd=ROOT, check=True)
        image = image_file.read_text().strip()
        container = subprocess.check_output(["docker", "create", image, *sys.argv[1:]], text=True).strip()
        try:
            result = subprocess.run(["docker", "start", "--attach", container])
            evidence = ROOT / "artifacts/testing/docker"
            evidence.mkdir(parents=True, exist_ok=True)
            copied = subprocess.run(["docker", "cp", f"{container}:/work/artifacts/testing/.", str(evidence)])
            exit_code = result.returncode or copied.returncode
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
            (evidence / f"run-{stamp}.json").write_text(json.dumps({
                "image": image, "container": container,
                "command": ["node", "examples/quickstart/test/Support/Dev/docker.mts"],
                "exitCode": exit_code, "artifactCopyExitCode": copied.returncode,
            }, indent=2) + "\n")
            return exit_code
        finally:
            subprocess.run(["docker", "rm", "--force", container], check=True)

if __name__ == "__main__":
    sys.exit(main())
