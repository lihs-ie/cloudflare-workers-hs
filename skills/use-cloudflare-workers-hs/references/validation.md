# Validation

Choose checks according to the boundary changed. Do not claim more than a check proves.

## Required layers

1. **Host tests**: pure domain logic, codecs, handler decisions, request construction, and error classification that can run under native GHC.
2. **Type and build gates**: native build where applicable, `wasm32-wasi` build, post-link generation, generated-artifact freshness, TypeScript type checking, and Wrangler configuration validation.
3. **Real runtime tests**: run the production WASM and TypeScript wiring with Wrangler or workerd. Exercise the actual binding/runtime call, decoded result, and relevant failure path.

Native tests using the host plugin do not prove JSFFI linkage, Promise behavior, workerd object shape, or Wrangler binding configuration.

## Add checks when relevant

- Servant API: expected status, headers, content type and body, plus routing failures such as 404/405 where relevant.
- Binding: missing/misnamed configuration, malformed inputs, platform error mapping, and lifecycle behavior.
- External JS adapter: TypeScript type check, success conversion, rejected Promise/thrown exception, malformed result, and actual WASM invocation.
- Queue/Workflow/Durable Object: retry, duplicate delivery, persistence, restart, alarm, concurrency, or lifecycle behavior actually relied upon by the application.
- Streaming/WebSocket: binary/text boundaries, cancellation/close, backpressure or hibernation behavior actually relied upon.
- Generated artifacts: prove that checked outputs match their Haskell/TypeScript/configuration inputs; never repair failures by editing generated output.

## Local versus remote claims

Use Docker when Linux/workerd parity matters. Use a remote Cloudflare smoke test only for behavior that local workerd cannot establish, such as a platform-specific service limitation or global propagation property.

Document what remains unverified. A successful local test must not be described as proof of a remote/global property.

## Completion report

Report:

- the pinned Haskell library and TypeScript runtime revisions;
- the production example or public modules followed;
- host, build/type, and real-runtime commands executed;
- which binding/runtime and failure paths were exercised;
- any Cloudflare behavior that remains unverified;
- any public API gap kept separate from the application change.
