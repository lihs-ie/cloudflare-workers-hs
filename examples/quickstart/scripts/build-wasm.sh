#!/usr/bin/env bash
# examples/quickstart/scripts/build-wasm.sh
#
# Chains: wasm32-wasi-cabal build (exe:quickstart) -> post-link.mjs (JSFFI
# glue for the `foreign export javascript "fetch"` reactor export) ->
# dist/quickstart.mjs worker entry. Invoked as wrangler.jsonc's
# `build.command`, a pretask that always runs before `wrangler dev` /
# `wrangler deploy` bundle `main` (wrangler's own esbuild does the actual
# bundling of dist/quickstart.mjs + the CompiledWasm .wasm import).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXAMPLE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${EXAMPLE_DIR}/../.." && pwd)"

if ! command -v wasm32-wasi-cabal >/dev/null 2>&1; then
  if [ -f "${HOME}/.ghc-wasm/env" ]; then
    # shellcheck disable=SC1091
    source "${HOME}/.ghc-wasm/env"
  elif [ -f /opt/ghc-wasm/env ]; then
    # shellcheck disable=SC1091
    source /opt/ghc-wasm/env
  else
    echo "ERROR: wasm32-wasi-cabal not found. Run inside nix develop/Docker, or install ghc-wasm-meta." >&2
    exit 127
  fi
fi

echo "==> [1/3] wasm32-wasi-cabal build exe:quickstart"
(
  cd "${REPO_ROOT}"
  wasm32-wasi-cabal build exe:quickstart --project-file=cabal-wasm.project
)

WASM_BIN="$(
  cd "${REPO_ROOT}"
  wasm32-wasi-cabal list-bin exe:quickstart --project-file=cabal-wasm.project
)"

mkdir -p "${EXAMPLE_DIR}/dist"

echo "==> [2/3] post-link.mjs (JSFFI glue for the reactor 'fetch' export)"
"$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" \
  --input "${WASM_BIN}" \
  --output "${EXAMPLE_DIR}/dist/ghc_wasm_jsffi.js"
cp "${WASM_BIN}" "${EXAMPLE_DIR}/dist/quickstart.wasm"

echo "==> [3/3] writing dist/quickstart.mjs (worker entry; wrangler bundles this + the .wasm import via its own esbuild)"
cat >"${EXAMPLE_DIR}/dist/quickstart.mjs" <<'JS'
import wasmModule from "./quickstart.wasm";
import ghc_wasm_jsffi from "./ghc_wasm_jsffi.js";
import { WASI, File, OpenFile, ConsoleStdout } from "@bjorn3/browser_wasi_shim";

let cachedInstance;

async function getInstance() {
  if (cachedInstance) return cachedInstance;

  const wasi = new WASI([], [], [
    new OpenFile(new File([])), // stdin
    ConsoleStdout.lineBuffered((msg) => console.log(msg)), // stdout
    ConsoleStdout.lineBuffered((msg) => console.error(msg)), // stderr
  ]);

  const __exports = {};
  const { instance } = await WebAssembly.instantiate(wasmModule, {
    wasi_snapshot_preview1: wasi.wasiImport,
    ghc_wasm_jsffi: ghc_wasm_jsffi(__exports),
  });
  Object.assign(__exports, instance.exports);
  wasi.initialize(instance);

  cachedInstance = instance;
  return instance;
}

export default {
  async fetch(request, env, ctx) {
    const instance = await getInstance();
    return instance.exports.fetch(request, env, ctx);
  },
};
JS

echo "build-wasm.sh done: dist/quickstart.mjs + dist/quickstart.wasm + dist/ghc_wasm_jsffi.js ready"
