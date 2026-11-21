#!/usr/bin/env bash
set -euo pipefail
EXAMPLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
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
SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/realtime-build.XXXXXX")"
trap 'rm -f "${SNAPSHOT}"' EXIT
node "${EXAMPLE_DIR}/test/Support/build-manifest.mts" capture "${SNAPSHOT}"
cd "${REPO_ROOT}"
BUILD_DIR="${WASM_BUILD_DIR:-dist-realtime-wasm}"
wasm32-wasi-cabal build exe:realtime-worker --project-file="${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}" -j2
WASM_BIN="$(wasm32-wasi-cabal list-bin exe:realtime-worker --project-file="${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "${WASM_BIN}" --output "${EXAMPLE_DIR}/worker/realtime-worker-jsffi.mjs"
cp "${WASM_BIN}" "${EXAMPLE_DIR}/worker/realtime-worker.wasm"
wasm32-wasi-cabal build exe:realtime-fixtures --project-file="${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}" -j2
FIXTURE_BIN="$(wasm32-wasi-cabal list-bin exe:realtime-fixtures --project-file="${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "${FIXTURE_BIN}" --output "${EXAMPLE_DIR}/worker/realtime-fixtures-jsffi.mjs"
cp "${FIXTURE_BIN}" "${EXAMPLE_DIR}/worker/realtime-fixtures.wasm"
node "${EXAMPLE_DIR}/test/Support/build-manifest.mts" write "${SNAPSHOT}"
