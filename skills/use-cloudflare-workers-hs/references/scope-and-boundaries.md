# Scope and boundaries

## What the library family provides

`cloudflare-workers-hs` is a source-first family of Haskell libraries for GHC's `wasm32-wasi` backend:

- `cloudflare-workers`: Workers HTTP types, headers, URLs, streaming, observability, event entrypoints, runtime APIs, and typed access to implemented Cloudflare bindings.
- `servant-cloudflare-workers`: a Workers-native Servant server interpreter and Workers-specific combinators. It reuses the Servant core DSL and does not use WAI, Warp, or `servant-server` at runtime.
- `servant-cloudflare-workers-client`: a Servant client backend implemented with Workers `fetch`, including Service Binding execution where supported.
- `servant-cloudflare-workers-access`: Cloudflare Access JWT verification through Workers Web Crypto and Servant authentication combinators.
- `@cloudflare-workers-hs/runtime`: a separately distributed TypeScript package that initializes the WASI reactor and connects WASM exports to Worker entrypoints.

Support is revision-specific. The project is pre-release and source-first; do not infer support from Cloudflare's platform catalog or from a newer repository revision.

## What it does not provide

The library does not own:

- wrappers for arbitrary npm packages, JavaScript SDKs, Node-compatible packages, or external SaaS clients;
- Cloudflare control-plane REST APIs, account provisioning, token creation, DNS management, infrastructure-as-code, or deployment policy;
- application API design, domain models, authorization policy, D1 schemas and migrations, R2 key layout, Queue message schemas, Durable Object state machines, or Workflow composition;
- application-level orchestration such as R2 read -> Images transform -> R2 write;
- application resource topology, Wrangler environment values, routes, cron schedules, or secret contents;
- a general dependency-injection container or an arbitrary `JSVal` escape hatch.

The library supplies platform operations. The application decides why, when, and in what order to invoke them.

## Binding classification test

Call a value a Cloudflare binding only when all of the following hold:

1. Current official Workers or Wrangler documentation defines it as a binding.
2. Wrangler or the Cloudflare platform configures and supplies it through the Worker environment.
3. It represents a platform resource, permission, or runtime capability rather than an object constructed by application code.

Then separately check whether the pinned `cloudflare-workers-hs` revision implements a supported typed API for it.

`env` membership alone is insufficient. An application can pass or construct JavaScript values, but doing so does not make them Cloudflare bindings.

## aws4fetch example

Cloudflare's R2 documentation imports `AwsClient` from the `aws4fetch` npm package and constructs it with credentials. Therefore:

- the credentials may originate in Secret or Var bindings;
- an R2 bucket may separately be an R2 binding;
- the constructed `AwsClient` is an application dependency, not a binding.

If Haskell must invoke it, keep the npm dependency and TypeScript code in the consumer application. Expose only a narrow application-owned operation across JSFFI, translate failures at that boundary, and keep `JSVal` out of domain and application logic.

## Decision table

| Requirement | Owner and action |
| --- | --- |
| Official binding, supported typed API | Configure it in Wrangler and use the library binding type. |
| Official runtime API, supported typed API | Use the library runtime module. |
| Official Cloudflare feature without a supported API | Report a public API gap; separate any library proposal. |
| npm package or external SDK | Implement an application-owned TypeScript/JSFFI adapter. |
| Domain policy or multi-operation workflow | Implement it in the application. |
| Requires generated-file edits or internal constructors | Stop and report the unsupported route. |
