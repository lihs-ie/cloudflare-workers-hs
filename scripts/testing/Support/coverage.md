# Coverage evidence

Run from the checkout:

```sh
python3 scripts/testing/Support/coverage_checks.py
python3 scripts/testing/coverage.py --tix path/to/suite.tix --mix-dir path/to/mix --istanbul path/to/coverage-final.json --output artifacts/coverage.json
```

Repeat `--tix`, `--mix-dir`, and `--istanbul` for additional suites. HPC ticks with identical module name, hash and tick count are summed with `hpc sum --union`. `Main` remains suite-local even when hashes match. Different hashes remain separate reports. Source mapping uses the owning Cabal package as well as the `.mix` path, so identically named `Main` modules from different packages cannot be conflated. Cabal-generated modules absent from authored-source inventory are classified separately only when an explicit `autogen-modules` declaration and the generated source warning both exist; the report records both provenance paths. Supply `.mix` directories from the same build as the `.tix` files. Reports must be generated immediately after tests; HPC hashes identify instrumentation, not a cryptographic provenance link to the current checkout.

Istanbul `coverage-final.json` reports merge only when statement, branch and function maps match exactly. Every branch outcome must execute. Line counts follow Istanbul statement-start semantics. JavaScript evidence does not cover WASM internals.

The inventory includes nonignored tracked and untracked Haskell, JavaScript/TypeScript (including `.mts`/`.cts` configs and helpers), Python and shell files, recording current source SHA-256. Unmatched files remain unmeasured. Haskell production `src/` and example programs require host and WASM evidence; tests, Support, host-testkit and the native oracle require host evidence. JavaScript requires Istanbul evidence. Python and shell remain explicitly unmeasured until collectors are added. Declaration files (`.d.ts`, `.d.mts`, `.d.cts`) have `source_kind: type-declaration` and `provenance_status: requires-manifest`; they remain in inventory and are neither silently excluded nor reported as executed. Generated provenance requires the explicit manifest rather than being inferred from a declaration-file extension.

Optional `--scope-manifest path.json` accepts reviewed source-specific provenance and runtime declarations:

```json
{
  "exclusions": [
    {"path": "generated/file.ts", "kind": "generated", "reason": "Produced by the documented generator", "evidence": "docs/generation.md"}
  ],
  "runtimes": [
    {"path": "package/native/Support.hs", "required": ["host"], "reason": "Native-only test support", "evidence": "docs/testing.md"}
  ]
}
```

Only `generated` and `external` provenance exclusions are accepted. Every entry requires a reason and an existing repository evidence file; referenced sources must exist. Runtime requirements cannot be empty. The manifest needs human review: file existence cannot establish the truth of its justification. Technical unreachability exceptions are not implemented and cannot be substituted with provenance exclusions.

HPC `exprs` counts expression ticks, `booleans` counts conditions with **both** outcomes (`count - true - false` in HPC XML), and `alts` counts alternatives. Host line evidence conservatively projects `.mix` expression spans: every expression spanning a line must have executed for that line to count as covered. This may undercount conventional line coverage but does not infer branch execution from line execution. Unsupported mix coordinates fail closed. Zero denominators produce `null`, never 100%.

`complete` is computed from every included source's required runtime evidence, with all nonzero metric denominators at 100%, no unmeasured source/runtime, and no collection errors. Empty inventories and all-excluded inventories cannot pass. Measured code can still have uncovered paths, and unsupported branch measurements remain explicitly incomplete. `--report-only` permits writing incomplete evidence with exit 0; it does not change `complete`. Enforcement should inspect `complete` or run without that flag.

Fixtures use temporary repositories and synthetic HPC/Istanbul evidence. They prove parser, union and gate behavior, not application coverage.

## Instrumented WASM/workerd coverage

Run `python3 scripts/testing/wasm-coverage.py`. It builds the development-only
reactor with `cabal-wasm-coverage.project`, executes the real workerd runtime
suite, and collects `Trace.Hpc.Reflect.examineTix` snapshots from each test-file
isolate through a loopback collector. Production Worker entrypoints do not expose
this endpoint. The runner records source hashes, command results, snapshot
hashes, and matching `.mix` hashes. Do not rebuild runtime packages concurrently
with a running Wrangler test process.

Use repeated `--wasm-tix` and `--wasm-mix-dir` options with `coverage.py` to merge
these snapshots alongside host and JavaScript evidence. Host and WASM counters
are separate even if module names and hashes coincide. Success of the collection
command means the collector worked; `complete=false` still means the full
coverage requirement is unmet. The default collects the Quickstart runtime harness; use `--all-examples` for all six examples. HPC does not measure JavaScript FFI bodies.

The standard `run.py coverage --report-only` lane automatically merges the latest
WASM proof only when source hashes and every snapshot/mix hash still match.
Stale or modified evidence is ignored and cannot fill coverage gaps.

## Python helper coverage

Install the measurement dependency with `python3 -m pip install -r scripts/testing/requirements.txt`.
Run `python3 scripts/testing/Support/python_coverage.py` to execute helper tests
and collect coverage.py line/branch JSON and HTML with no exclusion pragmas.
The standard coverage lane accepts the latest proof only when sources and JSON
hashes match. Python subprocesses started by the helper tests are measured with the documented
`patch = subprocess` option and combined; non-Python child processes remain unmeasured. Missing paths/branches remain incomplete.

## Library example WASM coverage

Run `python3 scripts/testing/wasm-coverage.py --example quickstart --example library-examples`.
The Cabal `wasm-coverage` flag exports snapshots only in instrumented builds.
Library's test fixture collects three HTTP-isolate reactors before shutdown;
separate DO/queue/service isolates are not inferred to be covered. App and
fixture Main modules use different mix directories to avoid collisions.
Rebuild normally afterwards to remove the test-only WASM exports.

Python collector reference: https://coverage.readthedocs.io/en/latest/api_coverage.html

## All six example reactors

`python3 scripts/testing/wasm-coverage.py --all-examples` collects Quickstart,
Library, Minimal, Static Assets, Realtime, and Workflows. For the latter four,
CPP wrappers are linked only by `wasm-coverage` and upload counters after each
export invocation. This also observes per-invocation Workflow reactors and DO
handlers, instead of assuming they share the frontend isolate. The test launcher
injects a loopback endpoint using Wrangler's `--define`; it is absent from normal
builds. The normal build is still verified separately because instrumentation
adds I/O and timing overhead.

Invocation snapshots can overlap cumulatively in persistent reactors. A positive
counter is evidence of execution; summed ticks are not an exact request or call
count. Killed processes or cancelled invocations may not report their last ticks.
No coverage is inferred for those missing observations.

## Reviewed execution environments

`runtime-scope.json` records file-specific runtime requirements with a source-file
reference and reason. The aggregator loads it by default and records its SHA-256.
Pure Haskell modules use host evidence; modules depending on the Cloudflare/WASM
runtime use workerd evidence. Explicit WASI CPP implementation splits require both.
Worker entry points and WASI fixtures use WASM. New files retain the conservative
fallback until their dependency closure is reviewed. This manifest does not exclude
any sources: type declarations, re-export modules and zero-tick modules remain
unresolved rather than silently passing. Runtime assignment is not test success.

For npm coverage, `coverage.py --istanbul <coverage-final.json>` merges matching
Istanbul maps. The standard coverage lane also accepts
`artifacts/testing/npm-coverage-latest.json` with repository-relative `report` and
`proof` paths. The proof must contain `sources` from `run.source_snapshot()`,
`exit_code: 0`, and `sha256` of the report. Create the proof only after successful
measurement against a stable source tree. An absent, stale, tampered or outside-root
proof leaves npm sources unmeasured.

Quickstart production integration now runs with `--coverage` and stores a separate
successful source proof alongside `test-artifacts/coverage/production/coverage-final.json`.
The coverage lane consumes that proof independently from the runtime harness proof.
Node-only example evidence uses `artifacts/testing/example-node-coverage-latest.json`
with the same report/proof contract as npm. Collector include lists partition the
canonical instrumentation of source files; they do not remove files from the global
inventory. If two inputs contain different Istanbul maps for the same source, the
aggregator rejects the merge instead of summing incompatible counters.

## Compile validation is not runtime coverage

Reviewed `runtime-scope.json.validations` entries replace an execution requirement
only for an ambient declaration (`declaration`) or a deliberately compiler-only
consumer fixture (`type-contract`). They remain `compile: unmeasured` until
`--compile-proof proof.json` is supplied. No runtime hit percentage is invented.
The report exposes `runtime_complete` and `compile_validation_complete` separately;
the overall gate requires both kinds of evidence.

A compile proof contains `sources` (repository-relative SHA-256 fingerprints,
including every inventory source and execution configurations), `commands`
(`argv`, integer `exitCode: 0`, and `inputs` from the actual compiler file listing),
and `validated` (`path`, `kind`, integer `commandIndex`). Only compiler inputs
covered by the corresponding successful command and explicitly approved manifest
kind are accepted. Unknown/duplicate paths, failed commands, changed files and
missing fingerprints fail closed. Filter compiler file listings to the repository
source/configuration fingerprints; do not claim a file was checked merely because
it exists beside a tsconfig.

`--shell-json` accepts kcov schema 1 source-matched line counts. Shell branch
coverage remains explicitly unmeasured (`complete: false`) even if every line and
CLI contract passes. Tool inability is not a technical-unreachability exemption.

Create compiler proof after source freeze with:

```sh
python3 scripts/testing/compile-validation.py --output artifacts/testing/compile-validation-final
```

The producer first runs the existing Wrangler types `--check` workflow for the
reviewed example projects, then runs each actual `tsc --noEmit --listFiles` project
(including npm's `tsconfig.check.json`). A reviewed path must occur in that
project's compiler output. Existing tsconfig options are preserved, including
`skipLibCheck`; this proves successful compiler integration/type contracts, not an
independent exhaustive check of third-party declaration internals. All tracked
execution source/configuration fingerprints must remain identical. Failures write
`proof.json` with errors but never update the last-success pointer. Success writes
`artifacts/testing/compile-validation-latest.json` (`proof`, `sha256`). The final
coverage command accepts the proof through `--compile-proof`.

The reader independently resolves the referenced command's explicit `--project`
(or `-p` / `--project=...`) and recorded `cwd`, requiring the tsconfig and every
local relative `extends` dependency in the source fingerprints. Scope configuration
and manifest evidence files are required too. Changing compiler configuration
invalidates proof even when declarations are unchanged. Implicit project lookup,
package-based extends, cycles and other unresolved forms fail closed rather than
silently accepting an incomplete dependency set. The current repository projects
use supported explicit projects and relative JSON extends.

## Native compiler and CLI tools

`python3 scripts/testing/native-tools-coverage.py --output artifacts/testing/native-tools-final`
builds isolated HPC executables for discovery and golden generation, then checks
successful behavior and expected argument failures. Every invocation uses a new
absolute `HPCTIXFILE`; root/package `.tix` leftovers are never collected. The
collector also runs the actual GHC API plugin probes (compat and WASM-source
compiler shim) using an HPC-enabled compiler driver because the installed GHC
executable does not flush loaded plugin counters. Generated driver Main is
separated from authored source coverage. Each behavior assertion is preserved
alongside the actual process exit code, including intentional failures.

The last-success pointer is `native-tools-coverage-latest.json`, with source/config
fingerprints, successful assertion command records, six fresh snapshots and copied
mix fingerprints. Collect only after source freeze; concurrent edits leave the
proof failed and do not update the pointer. Native compile acceptance of the Prim
re-export is recorded as a compiler contract, not falsely converted into runtime
hits.

The historical minimal deployment bundle is excluded only after validating its
retained bundle/map/WASM fingerprints, embedded source-content hashes, source-map
reference and successful Wrangler dry-run log. Authored source files remain in
scope. Any evidence change invalidates this specific provenance exclusion.

### Direct host coverage and equivalent source maps

`Support.host_coverage.collect(root, output, targets, snapshot, match=None,
build_directory=None, environment=None)` builds with an explicit fingerprinted
GHC and `--enable-coverage`, then runs each plan-resolved test executable in its
package directory. It preserves the supplied Sydtest configuration, supplies
local package data directories, and gives every suite a previously absent
`HPCTIXFILE`. Exit failure, timeout, an empty/failed/missing runner summary,
malformed counters, unmatched/conflicting mix contents, source drift or unlisted
copied mix files fail the proof. Cabal automatic HTML is never invoked.

`coverage.py --host-proof` authenticates the exact source, compiler and evidence
files before allowing source projection. Raw component modules remain in the
report. Only identical source bytes, host runtime, compiler version/binary and
complete labelled tick maps (including tab width) may combine counters for the
source-level result. CPP sources remain separate conservatively. Missing proof,
different coordinates or compiler evidence keep the previous per-variant
conjunction; they do not silently become equivalent. The projected metrics and
contributing component hashes are recorded separately under `projection`.


## Shared Node and Workers JavaScript counters

After freezing sources, run these collectors in order:

```sh
python3 scripts/testing/workerd-js-coverage.py
python3 scripts/testing/example-node-coverage.py --tools
python3 scripts/testing/shared-node-coverage.py --workerd path/to/fresh-workerd-output
```

The shared collector uses the same source transformation and Istanbul maps for
Node boundary contracts and Workers. It authenticates the source snapshot,
instrumenter identity, command logs, manifests, and raw counters before merging.
The coverage lane consumes this combined report instead of adding the Workers
report twice. It also preserves Workers-only per-source metrics under
`javascript.workerd_only`; Node doubles are not evidence of Cloudflare platform
behavior. Missing combined evidence remains explicitly unmeasured even when a
fresh Workers-only fallback is available.

Revalidate the complete evidence chain independently with:

```sh
node scripts/testing/Support/shared_js_report.mjs --verify path/to/combined/proof.json
```
