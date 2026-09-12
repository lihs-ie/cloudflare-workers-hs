#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
EXAMPLE_REPO_ROOT="$(cd ../.. && pwd)"
if ! command -v wasm32-wasi-cabal >/dev/null 2>&1; then
  source "${HOME}/.ghc-wasm/env"
fi
PROJECT_FILE="${EXAMPLE_REPO_ROOT}/${WASM_PROJECT_FILE:-cabal-wasm.project}"
BUILD_DIR="${EXAMPLE_REPO_ROOT}/${WASM_BUILD_DIR:-dist-library-examples-wasm}"
snapshot="$(mktemp)"
trap 'rm -f "$snapshot"' EXIT
node test/Support/build-manifest.mjs capture "$snapshot"
wasm32-wasi-cabal build exe:library-examples --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}" -j2
binary="$(wasm32-wasi-cabal list-bin exe:library-examples --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "$binary" --output worker/library-examples-jsffi.mjs
cp "$binary" worker/library-examples.wasm
wasm32-wasi-cabal build exe:library-examples-fixtures --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}" -j2
fixture_binary="$(wasm32-wasi-cabal list-bin exe:library-examples-fixtures --project-file="${PROJECT_FILE}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "$fixture_binary" --output worker/library-examples-fixtures-jsffi.mjs
cp "$fixture_binary" worker/library-examples-fixtures.wasm
node test/Support/build-manifest.mjs write "$snapshot"
