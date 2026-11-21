# @cloudflare-workers-hs/runtime

[日本語](README.ja.md)

Typed ESM bridges between GHC WASM reactors and Cloudflare Workers. The package initializes WASI, validates reactor exports, and connects Worker, Durable Object, and Workflow entrypoints while application behavior remains in Haskell.

## Trial installation

The package is not published to npm yet. Pin an exact Git commit during the trial period:

```sh
pnpm add 'github:lihs-ie/cloudflare-workers-hs#COMMIT_SHA&path:/packages/runtime'
```

Consumers do not run `pnpm pack`. pnpm installs the Git dependency and the package `prepare` script builds `dist` automatically. Replace `COMMIT_SHA` deliberately when accepting a runtime update.

pnpm 12 blocks Git dependency build scripts by default. Add the exact package key shown by `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` to `allowBuilds` in `pnpm-workspace.yaml`. This approval is SHA-specific, so update the allowlist when you change the pinned revision. The [former repository](https://github.com/lihs-ie/cloudflare-workers-hs-runtime) retains its existing commits for projects that pin them.

## Connect a reactor

```ts
import {
  bindExport,
  createReactor,
  decodeResponse,
  defineWorker,
} from '@cloudflare-workers-hs/runtime';
import makeImports from './application-jsffi.mjs';
import wasmModule from './application.wasm';

const reactor = await createReactor(wasmModule, makeImports, (exports) => ({
  fetch: bindExport<[request: Request, env: Env, context: ExecutionContext], Response>(
    exports,
    'fetch',
    decodeResponse,
  ),
}));

export default defineWorker({ fetch: reactor.fetch });
```

Run `pnpm exec wrangler types` in the application and include the generated declaration file. Its `Env` and `ExecutionContext` describe the real Cloudflare configuration. Generated JSFFI and WASM imports also need declarations in the application.

`createReactor` validates `memory`, `_initialize`, and the optional GHC scheduler export before constructing the adapter. `bindExport` requires a callable export and decodes every resolved result. The package supplies `decodeResponse`, `decodeString`, and `decodeVoid`; application-specific decoders should validate `unknown` inputs.

## Platform helpers

| API                    | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `defineWorker`         | Validate and freeze fetch, queue, scheduled, and tail handlers.      |
| `initializeObject`     | Register Durable Object initialization with `blockConcurrencyWhile`. |
| `runObject`            | Run an object operation with optional native serialization.          |
| `decodeWorkflowResult` | Validate a Workflow result envelope.                                 |
| `unwrapWorkflowResult` | Return success or preserve native and non-retryable failures.        |

Durable Object and Workflow classes remain explicit Cloudflare subclasses. This keeps generated Cloudflare types available at every entrypoint and avoids unchecked type assertions.

## Development

From the repository root, use the pinned Node and pnpm versions:

```sh
pnpm install --frozen-lockfile
pnpm --filter @cloudflare-workers-hs/runtime check
```

After editing runtime source, run `pnpm --filter @cloudflare-workers-hs/runtime build` before running examples against the updated package.

`pnpm check` runs oxfmt, typed Oxlint, TypeScript 7 checks, TSDoc validation, Vitest coverage, build, publint, and Are the Types Wrong. Runtime source has a 100% threshold for statements, branches, functions, and lines. `pnpm pack` builds a normal npm tarball when one is needed for release validation.

Run `pnpm test:package` from the repository root to verify an external install from the checked-out commit.
