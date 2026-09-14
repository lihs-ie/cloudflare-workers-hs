#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${EXAMPLE_DIR}/../.." && pwd)"
if ! command -v wasm32-wasi-cabal >/dev/null 2>&1; then
  if [ -f "${HOME}/.ghc-wasm/env" ]; then
    source "${HOME}/.ghc-wasm/env"
  elif [ -f /opt/ghc-wasm/env ]; then
    source /opt/ghc-wasm/env
  else
    echo "wasm32-wasi-cabal is required" >&2
    exit 127
  fi
fi
cd "${REPO_ROOT}"
BUILD_DIR="${WASM_BUILD_DIR:-dist-newstyle-runtime}"
PROJECT_FILE="${WASM_PROJECT_FILE:-cabal-wasm.project}"
TARGET="${1:-quickstart}"
case "${TARGET}" in quickstart|runtime-tests) ;; *) echo "Unknown reactor target" >&2; exit 2 ;; esac
INPUT_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/workers-build-inputs.XXXXXX")"
trap 'rm -f "${INPUT_SNAPSHOT}"' EXIT
node --input-type=module -e 'import {captureBuildInputs} from "./examples/quickstart/test/Support/Runtime/build-manifest.mts"; captureBuildInputs(process.argv[1]);' "${INPUT_SNAPSHOT}"
wasm32-wasi-cabal build "exe:${TARGET}" --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}" -j2
WASM_BIN="$(wasm32-wasi-cabal list-bin "exe:${TARGET}" --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}" | tail -n 1)"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "${WASM_BIN}" --output "${EXAMPLE_DIR}/worker/${TARGET}-jsffi.mjs"
cp "${WASM_BIN}" "${EXAMPLE_DIR}/worker/${TARGET}.wasm"
node --input-type=module -e 'import {writeBuild} from "./examples/quickstart/test/Support/Runtime/build-manifest.mts"; writeBuild(process.argv[1], process.argv[2]);' "${TARGET}" "${INPUT_SNAPSHOT}"
