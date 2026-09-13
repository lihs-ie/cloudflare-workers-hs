# Capabilities and examples

Use this map to select a starting point. It is a guide for the skill revision, not a claim that every Cloudflare or Servant feature is implemented.

## Package selection

| Need | Package |
| --- | --- |
| Worker HTTP types, runtime APIs, event entrypoints, or bindings | `cloudflare-workers` |
| Serve a Servant API on Workers | `servant-cloudflare-workers` |
| Call a Servant API through Workers `fetch` or a Service Binding | `servant-cloudflare-workers-client` |
| Verify Cloudflare Access tokens and inject claims into Servant handlers | `servant-cloudflare-workers-access` |
| Initialize and connect the Haskell WASM reactor | `@cloudflare-workers-hs/runtime` |

## Example selection

| Application need | Canonical example |
| --- | --- |
| Small HTTP Worker and application skeleton | `examples/minimal` |
| Multi-Worker application with Access, D1, R2, Queue, Scheduled, and Durable Objects | `examples/quickstart` |
| Individual KV, Cache, D1, R2, client, Queue, socket, configuration, and logging operations | `examples/library-examples` |
| Static files and Haskell API in one Worker | `examples/static-assets` |
| WebSocket and Durable Object SQL | `examples/realtime` |
| Durable Workflow steps, retries, waits, events, and lifecycle control | `examples/workflows` |
| Cloudflare Images inspection and transformation | No canonical production example in this revision; use the pinned public `Cloudflare.Workers.Binding.Images` module as the contract and add a consumer-owned real-runtime test |

Use `examples/features.md` in the matching repository revision for the exact implementation and verification location.
Treat this table as the complete canonical-example map for this skill revision. Do not infer that an omitted feature has a production example, and do not substitute a test fixture when the table says that no canonical example exists.

## Capability groups

The library family currently demonstrates these groups:

- HTTP, URL, headers, request/response bodies, streaming, middleware, and observability;
- fetch, Cache API, managed sockets, execution context, and Worker lifecycle support;
- KV, D1 and typed queries, R2, Images, Queue producer/consumer, Durable Objects and SQL, Workflows, Assets, Service Bindings, Vars, and Secrets;
- fetch, Queue, Scheduled, Tail, Durable Object, and Workflow entrypoints;
- Servant server routing, Workers-specific cache/assets/data-center behavior, a fetch-backed Servant client, and Cloudflare Access authentication.

Confirm exact operations and types in the pinned public modules. Do not turn this summary into an invented API name.

## Ownership examples

| Example requirement | Library responsibility | Application responsibility |
| --- | --- | --- |
| Store an object in R2 | Typed R2 operation | Bucket choice, key layout, metadata policy |
| Inspect/transform an image | Typed Images operations | Source acquisition, transform policy, destination |
| R2 -> Images -> R2 | Individual platform operations | Entire orchestration and failure policy |
| Consume a Queue message | Entrypoint and typed delivery/ack primitives | Message schema, idempotency, retry decision |
| Query D1 | Execution and decoding primitives | Schema, migration, SQL meaning, transaction boundary |
| Authenticate with Access | Token verification and claim injection | Role mapping and authorization policy |
| Call another Worker | Service Binding and Servant client support | RPC API and domain-level retry/idempotency policy |
| Sign an R2 S3 request with aws4fetch | Secret/Var access, if used | npm dependency, `AwsClient`, signing adapter |
