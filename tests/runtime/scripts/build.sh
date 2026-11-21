#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNTIME_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNTIME_DIR}/../.." && pwd)"
if ! command -v wasm32-wasi-cabal >/dev/null 2>&1; then
  source "${HOME}/.ghc-wasm/env"
fi
cd "${REPO_ROOT}"
BUILD_DIR="${WASM_BUILD_DIR:-dist-newstyle-runtime}"
PROJECT_FILE="${WASM_PROJECT_FILE:-cabal-wasm.project}"
INPUT_SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/library-runtime-inputs.XXXXXX")"
trap 'rm -f "${INPUT_SNAPSHOT}"' EXIT
node --input-type=module -e 'import {captureBuildInputs} from "./scripts/testing/build-manifest.mts"; captureBuildInputs("library-runtime", process.argv[1]);' "${INPUT_SNAPSHOT}"
wasm32-wasi-cabal build runtime-contracts:exe:library-runtime --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}" -j2
WASM_BIN="$(wasm32-wasi-cabal list-bin runtime-contracts:exe:library-runtime --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "${WASM_BIN}" --output "${RUNTIME_DIR}/worker/library-runtime-jsffi.mjs"
cp "${WASM_BIN}" "${RUNTIME_DIR}/worker/library-runtime.wasm"
node --input-type=module -e 'import {writeBuild} from "./scripts/testing/build-manifest.mts"; writeBuild("library-runtime", process.argv[1]);' "${INPUT_SNAPSHOT}"
