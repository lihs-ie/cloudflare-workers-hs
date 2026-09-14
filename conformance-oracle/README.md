# Development-only Servant oracle

`Support.Conformance.Oracle` interprets the shared `ReferenceAPI` with the real
`servant-server-0.21.0.0` WAI application. Shipping libraries must not depend
on this package; it is disabled on WASI.

The 50 named requests cover method/path selection, capture/query/header parsing,
Accept and Content-Type negotiation, and JSON bodies. `evaluateReference` also
accepts generated requests from `Support.Conformance.Generators`.

From the repository root, regenerate the committed fixture with:

```sh
cabal run regenerate-conformance-golden -- conformance-oracle/test/Support/Golden/reference.json
cabal test conformance-oracle:unit --test-show-details=direct
```

The fixture records exact byte arrays, including Content-Type parameters. Status
is always compared. For errors (4xx/5xx), Content-Type and body follow the independent
Workers contract and are tested in the server unit suite. Other responses retain
exact Content-Type comparison, and bodies are compared for all 2xx statuses. Golden
regeneration is explicit and is never performed automatically by a failing test.

`test/unit/Spec.hs` is discovered by sydtest-discover; only `*Spec.hs` modules are test
entries. Shared development helpers use `src/Support/**`; fixture data is under
`test/Support/Golden/**`.
