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
    python3 scripts/testing/run.py host

test-conformance:
    python3 scripts/testing/run.py conformance

test-integration:
    python3 scripts/testing/run.py integration

test-dev:
    python3 scripts/testing/run.py dev

test-docker:
    python3 scripts/testing/run.py docker

test-static-assets:
    python3 scripts/testing/run.py static-assets

test-realtime:
    python3 scripts/testing/run.py realtime

test-workflows:
    python3 scripts/testing/run.py workflows

test-minimal:
    python3 scripts/testing/run.py minimal

test-library-examples:
    python3 scripts/testing/run.py library-examples

test-model:
    python3 scripts/testing/run.py model --examples 10

test-coverage:
    python3 scripts/testing/run.py coverage

test-coverage-report:
    python3 scripts/testing/run.py coverage --report-only

test-replay target seed="42":
    python3 scripts/testing/run.py replay --target {{quote(target)}} --seed {{quote(seed)}}

test-registration:
    python3 scripts/testing/registration.py --output artifacts/testing/registration.json

test-tools:
    python3 -m unittest discover -s scripts/testing/Support -p 'test_*.py'
    python3 scripts/testing/Support/coverage_checks.py
    python3 scripts/testing/Support/mutation_checks.py

test-mutations:
    python3 scripts/testing/mutations.py

lint:
    scripts/hlint
    just test-registration
