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
SNAPSHOT="$(mktemp "${TMPDIR:-/tmp}/minimal-build.XXXXXX")"
trap 'rm -f "${SNAPSHOT}"' EXIT
node "${EXAMPLE_DIR}/test/Support/build-manifest.mjs" capture "${SNAPSHOT}"
cd "${REPO_ROOT}"
BUILD_DIR="${WASM_BUILD_DIR:-dist-newstyle-runtime}"
wasm32-wasi-cabal build exe:minimal-worker --project-file="${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}" -j2
WASM_BIN="$(wasm32-wasi-cabal list-bin exe:minimal-worker --project-file="${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "${WASM_BIN}" --output "${EXAMPLE_DIR}/worker/minimal-worker-jsffi.mjs"
cp "${WASM_BIN}" "${EXAMPLE_DIR}/worker/minimal-worker.wasm"
node "${EXAMPLE_DIR}/test/Support/build-manifest.mjs" write "${SNAPSHOT}"
