---
name: use-cloudflare-workers-hs
description: Build, change, review, or design consumer applications that use cloudflare-workers-hs. Use for choosing supported Workers APIs and bindings, defining Servant APIs, wiring Haskell WASM to the TypeScript runtime, and selecting the required validation. Do not use for developing the cloudflare-workers-hs libraries themselves.
license: MIT
---

# Use cloudflare-workers-hs

Use this skill for an application that consumes `cloudflare-workers-hs`. Keep application requirements separate from proposals to extend the library.

## Revision gate

Before searching for modules, functions, or examples, obtain the exact `cloudflare-workers-hs` tag or commit from the consumer application's Cabal configuration or from the user. The current working directory, a nearby checkout, the skill's source checkout, and the default branch are not evidence of the consumer's pin. If no exact ref is available, keep API availability explicitly pending and give a conditional plan; do not claim that a capability is supported or missing in that consumer revision.

## Start with the boundary

Classify each requirement before writing code:

1. **Cloudflare binding**: a resource or capability configured by Wrangler and supplied by Cloudflare through `env`, such as KV, D1, R2, Queues, Durable Objects, Workflows, Assets, Service Bindings, Vars, or Secrets.
2. **Workers runtime API**: a documented runtime capability that is not an env binding, such as Request, Response, `fetch`, Cache, streams, sockets, or Web Crypto.
3. **Application dependency**: an npm package, SDK, or object constructed by application code. `aws4fetch` is an application dependency even though Cloudflare documents its use with R2.
4. **Application behavior**: API routes, domain rules, schemas, keys, message formats, authorization policy, retries, idempotency, and orchestration of multiple platform operations.

The library implements typed platform access for the first two categories and supplies Servant integration for application APIs. Ownership of the third and fourth categories remains with the consuming application. Read [scope and boundaries](references/scope-and-boundaries.md) when ownership is unclear.

## Workflow

1. Pin this skill to the consumer application's Haskell package tag or commit, and use the TypeScript runtime revision selected by it.
2. Use the minimal example as the application skeleton. Select only the relevant feature example rather than copying a test fixture or an entire showcase application.
3. Define HTTP APIs with Servant. Prefer `NamedRoutes` for new APIs; existing Servant API types remain valid. Treat Queue, Scheduled, Durable Object, Workflow, and Tail handlers as separate non-HTTP entrypoints.
4. Use only a supported, typed library API for Cloudflare bindings and runtime operations. Keep binding names consistent between Haskell and Wrangler.
5. Keep domain behavior and composition in the application. For an external JavaScript dependency, use an application-owned, narrowly typed JSFFI/TypeScript adapter; never present the dependency as a Cloudflare binding or leak raw `JSVal` into domain or application logic.
6. Keep Haskell entrypoints and TypeScript runtime wiring thin. Do not edit generated WASM, post-link JSFFI, or generated Wrangler types.
7. Validate pure behavior on the host, then validate the actual WASM/runtime boundary with Wrangler or workerd. Native tests alone do not establish JSFFI or Workers behavior.

Read [application workflow](references/application-workflow.md) before creating or substantially restructuring an application. Read [capabilities and examples](references/capabilities-and-examples.md) to select packages and examples. Read [validation](references/validation.md) before declaring the work complete.

## Review mode

For a consumer-application review, classify each changed dependency and operation, identify the matching supported API and production example in the pinned revision, and compare the tests with the validation layers. Report scope violations and public API gaps as findings. Do not turn a review into a library implementation task.

## Stop instead of inventing an API

Stop implementation and report a **public API gap** when any of these is true:

- The required Cloudflare operation is documented by Cloudflare but has no supported typed API in the pinned library revision.
- The only apparent route requires a library-internal module or constructor, a custom `FromBindingJSVal`, generated-file edits, or arbitrary object injection into `BindingEnv`.
- The Promise, exception, lifecycle, concurrency, or value-conversion contract cannot be verified.
- No real WASM plus Wrangler/workerd validation path exists for the boundary.

Report the application requirement, the missing public capability, the evidence checked, and any application-side alternative. Propose a separate library issue or design review; do not modify the library as part of the consumer task.

## Sources of truth

- Use current official Cloudflare documentation to decide what a Cloudflare binding or Workers runtime API means.
- Use the pinned revision's supported public API, README, and production examples to decide what `cloudflare-workers-hs` implements.
- When a capability has no production example in that revision, say so and use its supported public module as the implementation evidence. Do not substitute test fixtures or internal examples.
- A Cloudflare feature may be real but unsupported by this library. A package shown in Cloudflare documentation does not thereby become a binding.
