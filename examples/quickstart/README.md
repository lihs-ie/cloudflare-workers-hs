# URL shortener: Haskell Workers applications

Four independently configured HTTP Workers each expose one Servant root handler:

| Worker | Routes | Access |
| --- | --- | --- |
| Redirect | `GET /r/:code` | public |
| Management | `POST/GET /urls`, `GET/PUT/DELETE /urls/:identifier`, `GET /stats` | Access JWT |
| Export | `POST /exports`, `GET /exports/:identifier`, `GET /exports/:identifier/download` | Access JWT |
| Recovery | `GET /events`, `POST /events/:identifier/replay` | Access JWT |

Queue consumers, Scheduled maintenance, and the export coordinator Durable Object have separate entrypoints under `workers/`. Business logic runs in Haskell/WASM. TypeScript files load the reactor and connect platform events. Each Worker selects a fixed export; no environment-controlled application routing is used. The current build shares one reactor artifact across these independent Workers.

D1 is authoritative. Redirects use primary reads and `302`, with no response cache. Deleted codes remain reserved. Management updates require the current `version`; conflicts return409. Creation requires an administrator-scoped `Idempotency-Key`, retained for7days, and replays the initial201 response. Clicks are best-effort asynchronous events, atomically deduplicated and counted by UTC occurrence day within30days. All admins share URL, export and recovery access.

CSV generation materializes a D1 snapshot, streams it to R2, and preserves the completed result for7days. The coordinator limits concurrent generation; retries renew their lease and cannot overwrite an existing object. Scheduled work removes expired records and repairs pending export delivery. Invalid JWTs never acquire administrator authority.

## Run the tests

From the repository root, install dependencies with `just setup-js`, then use:

```sh
just test-host
just test-conformance
just test-integration
just test-dev
just test-docker
```

`test-dev` builds the production reactor, launches the real multi-Worker `wrangler dev` process with isolated D1/R2/Queue/DO state, serves ephemeral signed test JWKS, and executes authenticated HTTP contracts. Its test-only gateway forwards requests to the actual application Workers. `test-docker` runs the same HTTP suite and the independent library examples in Linux Docker, using freshness-checked WASM built before container execution. Docker does not claim to compile Haskell inside the container. Failures produce nonzero exit codes and logs under `artifacts/testing/`.

See [dev testing](../../docs/specs/dev-testing.md) and [the implementation plan](../../docs/specs/quickstart-full-library-plan.md) for the complete contract. Configurations contain local resource names and placeholder Access settings; replace them with your actual settings for deployment. Test commands never deploy or provision remote resources.

## HTTP examples

Use each application's own local address or deployed origin and a real Access JWT. Set `MANAGEMENT_ORIGIN`, `REDIRECT_ORIGIN`, `EXPORT_ORIGIN`, `RECOVERY_ORIGIN`, and `ACCESS_JWT` in your shell before running these commands.

```sh
curl "$MANAGEMENT_ORIGIN/urls" \
  -H "Cf-Access-Jwt-Assertion: $ACCESS_JWT" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: example-create-1' \
  --data '{"destination":"https://example.com/docs","expiresAt":null}'

curl -i "$REDIRECT_ORIGIN/r/$URL_IDENTIFIER"

curl "$MANAGEMENT_ORIGIN/urls/$URL_IDENTIFIER" -X PUT \
  -H "Cf-Access-Jwt-Assertion: $ACCESS_JWT" -H 'Content-Type: application/json' \
  --data '{"destination":"https://example.com/new","expiresAt":null,"version":1}'

curl "$MANAGEMENT_ORIGIN/stats?start=2026-09-01&end=2026-09-07" \
  -H "Cf-Access-Jwt-Assertion: $ACCESS_JWT"

curl "$EXPORT_ORIGIN/exports" \
  -H "Cf-Access-Jwt-Assertion: $ACCESS_JWT" -H 'Content-Type: application/json' \
  --data '{"startDay":"2026-09-01","endDay":"2026-09-07"}'

curl "$EXPORT_ORIGIN/exports/$EXPORT_IDENTIFIER" \
  -H "Cf-Access-Jwt-Assertion: $ACCESS_JWT"

curl "$EXPORT_ORIGIN/exports/$EXPORT_IDENTIFIER/download" \
  -H "Cf-Access-Jwt-Assertion: $ACCESS_JWT" --output clicks.csv

curl "$RECOVERY_ORIGIN/events" -H "Cf-Access-Jwt-Assertion: $ACCESS_JWT"
```

Read the returned URL/export identifier into the corresponding shell variable. Date ranges are inclusive UTC dates and at most366days. Download returns409 while generation is incomplete and404 after expiry.
