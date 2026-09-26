# cloudflare-workers-hs

[日本語](README.ja.md)

`cloudflare-workers-hs` is a source-first Haskell library family for building Cloudflare Workers with GHC's `wasm32-wasi` backend. It provides Cloudflare runtime bindings, a Servant server interpreter, a fetch-backed Servant client, and Cloudflare Access authentication.

The libraries are in a pre-release trial stage. They are not published to Hackage, and no stability or compatibility guarantee is made yet. The examples and CI exercise real WASM through workerd, Wrangler, and Docker in addition to native Haskell tests.

## Repository map

| Path | Role | Status |
| --- | --- | --- |
| [`cloudflare-workers/`](cloudflare-workers/) | Requests, responses, event entrypoints, streaming, observability, and bindings for KV, D1, R2, Queues, Durable Objects, Workflows, Cache, Assets, service bindings, and sockets | Pre-release library, `0.1.0.0` |
| [`servant-cloudflare-workers/`](servant-cloudflare-workers/) | Servant server interpreter with `NamedRoutes` and typed `UVerb` responses | Pre-release library, `0.1.0.0` |
| [`servant-cloudflare-workers-client/`](servant-cloudflare-workers-client/) | Servant client backed by Workers `fetch` | Pre-release library, `0.1.0.0` |
| [`servant-cloudflare-workers-access/`](servant-cloudflare-workers-access/) | Cloudflare Access JWT verification through Web Crypto | Pre-release library, `0.1.0.0` |
| [`examples/`](examples/) | Deployable examples and integration tests | Private repository applications |
| [`conformance-oracle/`](conformance-oracle/) | `servant-server` comparison oracle | Repository-only test package |
| `testing-support/` | Shared layered test discovery | Repository-only test package |

The TypeScript runtime is maintained separately in [`cloudflare-workers-hs-runtime`](https://github.com/lihs-ie/cloudflare-workers-hs-runtime). This workspace consumes an exact Git revision through the pnpm catalog; applications import it as `@cloudflare-workers-hs/runtime`.

```text
applications
  ├─ servant-cloudflare-workers-access
  ├─ servant-cloudflare-workers-client
  └─ servant-cloudflare-workers
       └─ cloudflare-workers
            └─ @cloudflare-workers-hs/runtime
```

## Requirements

- GHC `9.14.1` and Cabal `3.16.1.0` for native builds and tests
- The GHC WASM `wasm32-wasi` toolchain for Worker builds
- Node.js 24 and pnpm `12.4.1`
- Wrangler, installed by the locked pnpm workspace
- `just` for the documented task shortcuts
- Docker for `just test-docker`

`nix develop` supplies the WASM toolchain, Node.js, pnpm, and repository tools on `x86_64-linux` and `aarch64-darwin`. It intentionally does not supply native GHC; install GHC `9.14.1` separately, for example with GHCup.

## Get started

```sh
nix develop
just setup-js
just test-minimal
```

The [minimal example](examples/minimal/README.md) explains the Haskell entrypoint, `NamedRoutes` API, TypeScript loader, Wrangler configuration, generated WASM, and files needed when moving an application into another project.

## Examples

| Example | What it demonstrates | Command |
| --- | --- | --- |
| [Minimal](examples/minimal/README.md) | One `GET /health` API with no platform bindings | `just test-minimal` |
| [Quickstart](examples/quickstart/README.md) | A multi-Worker URL shortener using Access, D1, R2, Queues, Scheduled events, and Durable Objects | `just test-dev` |
| [Library examples](examples/library-examples/README.md) | KV, Cache, D1, R2, typed clients, Queues, sockets, configuration, and logging | `just test-library-examples` |
| [Static Assets](examples/static-assets/README.md) | Static files and a Haskell API in one Worker | `just test-static-assets` |
| [Realtime](examples/realtime/README.md) | WebSockets with Durable Object SQL | `just test-realtime` |
| [Workflows](examples/workflows/README.md) | Durable steps, retries, waits, events, and lifecycle controls | `just test-workflows` |

See the [example guide](examples/README.md) for directory conventions and [`examples/features.md`](examples/features.md) for each capability's implementation and verification locations.

## Development commands

```sh
just build-host             # Build the native Haskell workspace
just build-wasm             # Build the WASM workspace
just test-host              # Native unit and integration tests
just test-conformance       # Servant behavior comparison
just test-integration       # Real WASM and workerd integration
just test-model             # Generated state-machine scenarios
just test-dev               # Production Workers through wrangler dev
just test-docker            # Production Workers through Linux Docker/workerd
just test-registration      # Test entrypoint and Cabal registration checks
just test-tools             # Test infrastructure regression checks
just test-coverage-report   # Preserve measured and unmeasured coverage
```

`just test-coverage` enforces the complete multi-runtime coverage target and fails when required evidence is missing or incomplete. `just test-coverage-report` writes the same conservative report without converting missing coverage into success. Test failures still fail both commands. Evidence is stored under the Git-ignored `artifacts/testing/` directory.

## Trial consumption

During the trial stage, consume the Haskell packages from a checked-out source tree or a pinned Git revision in your Cabal project. Do not depend on a Hackage release yet. The TypeScript runtime is pinned in [`pnpm-workspace.yaml`](pnpm-workspace.yaml); consumers do not need to run `pnpm pack`.

Start with the [minimal example's extraction notes](examples/minimal/README.md#独立したプロジェクトにする場合). Versioning and distribution decisions are in [ADR-0018](docs/adr/0018-versioning-release-distribution.md), and the runtime repository split is in [ADR-0025](docs/adr/0025-separate-typescript-runtime-repository.md).

## Scope

The library family provides typed Haskell interfaces to the Cloudflare bindings and Workers runtime APIs implemented by the pinned revision, Servant server/client integration, Cloudflare Access authentication, and WASM integration with the separately distributed TypeScript runtime.

A Cloudflare binding is configured by Cloudflare or Wrangler and supplied through the Worker's `env` as a platform resource or capability. Request, Response, `fetch`, Cache, streams, sockets, and Web Crypto are Workers runtime APIs, not bindings.

External npm packages and SDKs, application domain models, schemas, authorization, retries, and compositions of multiple operations are outside the library's scope. For example, `aws4fetch` is documented by Cloudflare for R2 but remains an application-owned npm dependency rather than a binding. R2 read -> Images transform -> R2 write is also an application workflow. See [ADR-0027](docs/adr/0027-define-consumer-library-boundary.md) for the decision boundary.

Servant's standard `UVerb` contract is part of the server interpreter rather
than an application workflow. See the [typed response guide](docs/specs/uverb-support.md).

## Consumer Agent Skill

The repository includes the `use-cloudflare-workers-hs` Skill for agents that build, change, or review consumer applications. Install it with GitHub CLI's preview `gh skill` command and pin it to the same tag or commit as the Haskell packages used by the application.

```sh
gh skill preview lihs-ie/cloudflare-workers-hs use-cloudflare-workers-hs

gh skill install lihs-ie/cloudflare-workers-hs use-cloudflare-workers-hs \
  --agent codex \
  --scope project \
  --pin 0123456789abcdef
```

Replace `0123456789abcdef` with the same tag or commit selected by the application's Cabal project. The skill source is [`skills/use-cloudflare-workers-hs`](skills/use-cloudflare-workers-hs).

## Architecture

The [ADR index](docs/adr/README.md) covers the WASM backend, reactor integration, JSFFI boundaries, Servant execution, Cloudflare bindings, authentication, WebSockets, Workflows, testing, and distribution. The [glossary](GLOSSARY.md) defines repository-specific terms.

## License

The repository-level license is [MIT](LICENSE). Individual Cabal manifests also declare package-specific licenses; review the relevant manifest before distribution.
