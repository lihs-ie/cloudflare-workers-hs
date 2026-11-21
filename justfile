set shell := ["bash", "-euo", "pipefail", "-c"]

setup-js:
    pnpm install --frozen-lockfile

build-host:
    cabal build all --project-file=cabal.project

build-wasm:
    source ~/.ghc-wasm/env && wasm32-wasi-cabal build all --project-file=cabal-wasm.project

test-runtime-distribution:
    pnpm test:package

test-host:
    node scripts/testing/run.mts host

test-conformance:
    node scripts/testing/run.mts conformance

test-integration:
    node scripts/testing/run.mts integration

test-dev:
    node scripts/testing/run.mts dev

test-docker:
    node scripts/testing/run.mts docker

test-static-assets:
    node scripts/testing/run.mts static-assets

test-realtime:
    node scripts/testing/run.mts realtime

test-workflows:
    node scripts/testing/run.mts workflows

test-minimal:
    node scripts/testing/run.mts minimal

test-api-catalog:
    node scripts/testing/run.mts api-catalog

test-model:
    node scripts/testing/run.mts model --examples 10

test-coverage:
    node scripts/testing/run.mts coverage

test-coverage-report:
    node scripts/testing/run.mts coverage --report-only

test-replay target seed="42":
    node scripts/testing/run.mts replay --target {{quote(target)}} --seed {{quote(seed)}}

test-registration:
    node scripts/testing/registration.mts --output artifacts/testing/registration.json

test-internal-boundary-manifest:
    node scripts/testing/internal-module-boundaries.mts manifest

test-internal-boundaries: test-internal-boundary-manifest
    node scripts/testing/internal-module-boundaries.mts consumer

test-tools:
    pnpm test:tools

test-mutations:
    node scripts/testing/mutations.mts

lint: test-registration test-internal-boundary-manifest
    node scripts/testing/test-boundaries.mts
    scripts/hlint

test-queued-jobs:
    node scripts/testing/run.mts queued-jobs
