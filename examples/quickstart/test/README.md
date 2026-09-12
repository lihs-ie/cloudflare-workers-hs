# Test entry points

Run commands from `examples/quickstart`, or use `pnpm --dir examples/quickstart` from the repository root.

- `cabal test quickstart:unit quickstart-domain:unit quickstart-management:unit` (repository root): coordinator state transitions, current domain contracts/properties and management validation.
- `bash scripts/build-wasm.sh runtime-tests` then `pnpm test:runtime`: development-only reactor, real Workers/WASM boundary and Durable Object storage regression tests.
- `pnpm build:model` after the runtime build, then `cabal test quickstart:model --test-options='--max-success 10'`: host Hedgehog generates command sequences; each candidate starts a fresh local workerd and a fresh Durable Object, including during shrinking. Set `RUNTIME_MODEL_BUNDLE` to an absolute bundle filename when running outside the source package. Use Sydtest's seed option to replay a failure; the shrunk command list is included in the failure report.
- `bash scripts/build-wasm.sh` then `pnpm test:integration`: production application contracts covering authentication, CRUD, aggregation, CSV export, recovery and maintenance.

`test/integration/runtime/boundaries.spec.ts` owns its three `*.cases.ts` children. Only `*.spec.ts` entries are automatically collected. Haskell entries mirror implementation modules; helpers, generators, bridge processes and runtime setup live under `Support/`.

Build freshness is checked before every Vitest launch. The build records input hashes before compilation and rejects concurrent source changes before producing its manifest; verification checks the source inputs and both WASM and generated JS glue. Missing or stale artifacts fail, rather than silently running an old binary. Runtime and production artifacts are separate. Compiler binary identity and resolved Cabal plan are not yet captured.

Coverage is not complete. See [the validation status](../../../docs/specs/testing-modernization-status.md) for the measured scope and remaining gaps. The old, unused URLShortener.API types and their JSON-only tests have been removed; current application/domain tests remain. Node-side bridge tests do not replace the host Hedgehog model suite.

## JavaScript coverage

`pnpm test:runtime:coverage` runs the real workerd tests with Istanbul (`@vitest/coverage-istanbul` 4.1.10, matching the installed Vitest). Reports are written to `test-artifacts/coverage/runtime/coverage-final.json`, `coverage-summary.json`, and HTML. `inventory.json` lists every authored JS/TS file in the package source, test, script and Vitest configuration roots, including files without reported instrumentation. Generated JSFFI glue and declaration-only files are excluded from this JS source denominator; Haskell FFI strings and WASM instructions require separate accounting.

Unimported source and Support files remain in the Istanbul report at zero hits. Node-side helpers that ran during build/setup still show zero hits in this workerd-only report; their execution must be measured in a separate Node lane. Vitest currently omits the active suite entry and configuration modules despite the explicit include; the inventory marks these `unmeasured`, not fully covered. WASM-internal Haskell coverage is also unmeasured. No global 100% claim is made from this report.
