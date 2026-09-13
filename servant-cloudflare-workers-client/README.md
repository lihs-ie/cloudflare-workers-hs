# servant-cloudflare-workers-client

`servant-cloudflare-workers-client` provides a Servant client backend for the
Cloudflare Workers `fetch` API.

It implements `RunClient`, so applications can create typed clients with the
standard `HasClient` and `clientIn` APIs from `servant-client-core`.
Request paths, query parameters, headers, and bodies are converted to
`Cloudflare.Workers.HTTP.Request` values before crossing the Workers runtime
boundary.

## Compatibility

The package supports `servant-client-core` 0.20 and 0.21.

Version 0.21 represents query parameters as partially escaped query items.
The client uses the official `http-types` partial-escape renderer so encoded
sections are not escaped a second time.

## Runtime

The Haskell modules can be type-checked and unit-tested with host GHC.
Executing requests requires a Worker built with GHC's `wasm32-wasi` toolchain.

See the
[repository README](https://github.com/lihs-ie/cloudflare-workers-hs)
for setup instructions and runnable examples.
