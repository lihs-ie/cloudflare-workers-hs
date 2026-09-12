#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
EXAMPLE_REPO_ROOT="$(cd ../.. && pwd)"
if ! command -v wasm32-wasi-cabal >/dev/null 2>&1; then
  source "${HOME}/.ghc-wasm/env"
fi
BUILD_DIR="${EXAMPLE_REPO_ROOT}/${WASM_BUILD_DIR:-dist-workflows-wasm}"
snapshot="$(mktemp)"
trap 'rm -f "$snapshot"' EXIT
node test/Support/build-manifest.mjs capture "$snapshot"
wasm32-wasi-cabal build exe:workflow-example --project-file="${EXAMPLE_REPO_ROOT}/${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}" -j2
binary="$(wasm32-wasi-cabal list-bin exe:workflow-example --project-file="${EXAMPLE_REPO_ROOT}/${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "$binary" --output worker/workflow-example-jsffi.mjs
cp "$binary" worker/workflow-example.wasm
wasm32-wasi-cabal build exe:workflow-example-fixture --project-file="${EXAMPLE_REPO_ROOT}/${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}" -j2
fixture_binary="$(wasm32-wasi-cabal list-bin exe:workflow-example-fixture --project-file="${EXAMPLE_REPO_ROOT}/${WASM_PROJECT_FILE:-cabal-wasm.project}" --builddir="${BUILD_DIR}")"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" --input "$fixture_binary" --output worker/workflow-example-fixture-jsffi.mjs
cp "$fixture_binary" worker/workflow-example-fixture.wasm
node test/Support/build-manifest.mjs write "$snapshot"
