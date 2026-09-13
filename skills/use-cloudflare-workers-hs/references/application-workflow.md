# Application workflow

## 1. Pin compatible sources

During the pre-release stage, pin the required Haskell packages to a Git tag or commit in the Cabal project. Install this skill at the same ref. Use the TypeScript runtime revision pinned by that library revision; do not silently mix latest revisions. If a review does not provide the consumer's exact pin, request or locate it in that consumer's configuration before judging API availability. Neither the current directory, the skill installation, nor another checkout proves the consumer's revision.

## 2. Choose a production example

Start from `examples/minimal` for the application shape:

- `src/<App>/API.hs`: Servant API and request/response types;
- `src/<App>/Application.hs`: handlers and application wiring;
- `app/Main.hs`: thin exported Worker entrypoint;
- `worker/runtime.ts`: WASI/reactor integration;
- `worker/index.ts`: native Worker entrypoint;
- `wrangler.jsonc`: Worker and binding configuration;
- build script and manifest: WASM, post-link output, and freshness checks.

Use the capability map to find a feature-specific example. Copy the smallest relevant public-API usage, not repository test support, probes, generated files, or an entire showcase application.

Some supported capabilities may not yet have a production example. In that case, state the example gap, use the supported public module as the code-level contract, and require a consumer-owned real-runtime test. Do not promote a test fixture into a usage recommendation.

## 3. Define entrypoints

For HTTP, define the API with Servant. New APIs should normally use a record of routes and `NamedRoutes`:

```haskell
data Routes mode = Routes
    { health :: mode :- "health" :> Get '[JSON] HealthResponse
    }
    deriving stock (Generic)

type API = NamedRoutes Routes
```

Connect the corresponding handler record through the server interpreter. Keep request routing and business behavior out of `Main.hs` and the TypeScript loader.

Queue, Scheduled, Durable Object, Workflow, and Tail are Worker event entrypoints, not HTTP routes. Use their dedicated entrypoint APIs and examples.

## 4. Configure bindings

Declare only binding types implemented by the pinned library revision. Keep each binding name identical across:

- the type-level Haskell environment;
- `getBinding` or the dedicated lookup function;
- Wrangler configuration;
- generated Worker environment types.

Vars and Secrets are configuration bindings. KV, D1, R2, Queues, Durable Objects, Workflows, Assets, Images, and Service Bindings are platform bindings when configured through Wrangler. Do not put npm client instances or arbitrary application objects into the binding environment.

The application owns schemas, resource names, migrations, keys, messages, retries, authorization, and operation ordering.

## 5. Integrate an external JavaScript dependency

Keep the dependency in the consumer's `package.json` and TypeScript code. If Haskell needs the capability:

1. Define the smallest application-specific operation rather than exporting the whole JavaScript object.
2. Put the FFI in an application-owned boundary module, such as an infrastructure JSFFI adapter.
3. Exchange explicit text, bytes, records, or tagged results; do not pass raw `JSVal` into domain or application modules.
4. Convert rejected Promises, thrown exceptions, and malformed values into an explicit application error contract.
5. Type-check the TypeScript adapter and exercise it through real WASM and workerd/Wrangler.

Do not add a custom binding type merely to carry the dependency through `env`.

## 6. Wire and build

Use the pinned `@cloudflare-workers-hs/runtime` APIs shown by the matching minimal example to initialize the reactor, bind exports, and define Worker entrypoints. Preserve the example's WASM compiler and linker settings.

Treat these as generated artifacts and never edit them directly:

- the `.wasm` output;
- GHC post-link JSFFI output;
- generated WASM export declarations;
- `wrangler types` output.

Wrangler bundling is not TypeScript type checking. Run the repository's explicit type-check command or `tsc --noEmit` equivalent.

## 7. Handle an unsupported requirement

Do not broaden the consumer task into library development. Report:

- the requested behavior;
- its classification (binding, runtime API, application dependency, or application behavior);
- the pinned revision and public APIs/examples inspected;
- the missing operation or contract;
- an application-side alternative, if one is supported;
- a proposed separate library issue when no supported path exists.
