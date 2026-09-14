# Server tests

`unit/Spec.hs` discovers only `*Spec.hs` under `unit/`, using the development-only
`testing-support:sydtest-discover-layer` executable. `Server/InternalSpec.hs`
explicitly registers `ParameterCases.spec` and `BodyCases.spec` once each.
Support modules are outside discovery. Fixed and generated assertions describing
the same behavior stay together.

Run from the repository root:

```sh
cabal test servant-cloudflare-workers:unit --enable-tests --test-show-details=direct
cabal test servant-cloudflare-workers:conformance --enable-tests --test-show-details=direct
```

The conformance suite imports the same API type as the development-only
`conformance-oracle` package. Requests are passed to real `servant-server` through
WAI and to `serveWithContext` independently. No reference routing logic is copied.
Fixed case failures show the request and both observations; generated failures
also show the seed and Hedgehog shrink path.

## Outstanding contract decision

The agreed compatibility comparison includes exact Content-Type on errors.
The actual servant-server 0.21.0.0 response to `POST /hello` is status 405 with no
Content-Type. Workers returns status 405 with
`application/json;charset=utf-8` and the independently specified JSON error
body. The comparison deliberately fails on this difference, pending a decision
about the compatibility boundary. It does not strip or normalize the header.

Legacy unregistered golden files are retained under `Support/Fixtures/Legacy`
as historical input, and are not treated as reference expectations.

## Verified baseline (2026-09-14)

- Servant 0.20.4.0, servant-server 0.21.0.0, and GHC 9.14.1.
- Unit suite: 202 tests, 499 examples, no failures.
- Unit-only shipping-library HPC: expressions 1238/1422, alternatives 116/122.
  This is not 100% and does not include the coverage contribution of the failing
  conformance suite or claim WASM/FFI coverage.
- Content-Type default regression first failed on `application/actet-stream`,
  then passed after correcting the implementation to `application/octet-stream`.
- On this macOS toolchain the coverage build requires the installed libffi header
  path via `--ghc-option=-optc-I/opt/homebrew/opt/libffi/include`; this host-specific
  workaround is not embedded in the package configuration.
