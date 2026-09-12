# Haskell Workflows example

A named Servant root API starts an approval Workflow. The TypeScript entrypoint only connects Cloudflare's native `WorkflowEntrypoint` and `NonRetryableError` to WASM; decisions, durable steps, retries, D1 writes, sleep and event handling run in Haskell.

```sh
bash examples/workflows/scripts/build.sh
node --test examples/workflows/test/integration/workflow.spec.mjs
```

Tests run actual `wrangler dev --local`, apply the D1 migration in isolated storage, and restart the Wrangler process to verify durable step replay. The installed Wrangler comes from `examples/quickstart/node_modules`. Install that project's pinned dependencies first. Generated WASM/glue and the build proof must match all source inputs; stale artifacts fail before startup.

For an interactive session:

```sh
cd examples/workflows
../quickstart/node_modules/.bin/wrangler d1 execute AUDIT --local --file migrations/0001_audit.sql
../quickstart/node_modules/.bin/wrangler dev --local
```

```sh
curl -H 'Content-Type: application/json' -d '{"identifier":"report-1","parameters":{"message":"publish report","behavior":"retry"}}' http://localhost:8787/workflows
curl http://localhost:8787/workflows/report-1
curl http://localhost:8787/workflows/report-1/audit
curl -H 'Content-Type: application/json' -d '{"approved":true}' http://localhost:8787/workflows/report-1/approve
curl http://localhost:8787/workflows/report-1
```

`behavior` is `normal`, `retry` (two injected response failures after the committed write), or `fail` (native `NonRetryableError`). A unique D1 key based on the Workflow instance protects the side effect across retries; Workflow callback execution itself is not exactly once. The audit shows attempts separately from committed effects. Step names are stable across replay.

The `/workflows/:instance/control` endpoint accepts a JSON string `"pause"`, `"resume"`, `"restart"`, or `"terminate"`. It returns an acknowledgement (`accepted`, `identifier`, and `operation`), not a status snapshot. Read `/workflows/:instance` separately to observe progress. A successful control call does not mean the asynchronous state transition has finished. Remote validation observed queued stalls when status was read immediately after restart, including a separate HTTP request. The acknowledgement does not resolve that platform interaction: the validation scenario checks a new audit checkpoint before reading status. Immediate status polling remains an unresolved remote limitation. Restart begins a fresh execution of the instance; destination-side deduplication still protects its write. This example has no authentication and is intended for local operation; add the library's Access authentication when exposing administrative routes.

## Public library APIs

- `Workflow params`, `WorkflowIdentifier`, `workflowCreate`, `workflowGet`, `workflowStatus`, `workflowSendEvent` provide typed JSON binding access.
- `workflowStepDo` accepts typed JSON input/output, a stable name, retry/backoff/timeout options, and a callback receiving the native step name/count/attempt.
- `workflowSleep`, `workflowSleepUntil`, `workflowWaitForEvent` use native durable timers and events.
- `workflowPause`, `workflowResume`, `workflowRestart`, `workflowTerminate` expose lifecycle controls.
- `createWorkflowHandler` decodes typed events and binding environments, contains Haskell exceptions (including lazy serialization failures), and returns an explicit outcome to the thin TS entrypoint. Native engine abort errors retain their original JS object identity so pause, resume, terminate and restart remain engine control operations.

The adapter keeps a Promise mailbox for the entire native `step.do`, including retries. Per-attempt Haskell actions run in scoped threads; a retry cancels the previous action and scope completion cancels remaining actions. Callback registration is masked against asynchronous exceptions. Cancellation is cooperative: user callbacks must not block indefinitely under `uninterruptibleMask`.

Values are JSON, not arbitrary structured-clone values. Unsafe integer numbers are rejected at native parsing boundaries instead of silently rounding; encode large integers as strings. The platform's step-result size limits remain applicable.

Local Workflows may report `running` while waiting for an event, until the engine's idle grace period expires. Tests therefore verify the durable approval checkpoint, absent output and subsequent event-driven completion, without inventing a `waiting` status. Depending on the installed local engine, terminal errors for `NonRetryableError` use a native generic message; the single-attempt audit verifies its non-retryable behavior.

Test-only timeout, lazy-output, unsafe-number and D1 query exports compile from `test/Support/Main.hs` into the separate `workflow-example-fixture.wasm`. The test entrypoint instantiates that reactor separately. Production WASM exports only fetch and workflow; production `worker/entry.ts` imports no fixture code. Runtime process logs are archived by the test harness before isolated state is removed.

References: [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/), [Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/), [Local development](https://developers.cloudflare.com/workflows/build/local-development/).

## UTC scheduled completion

Set optional `parameters.executeAt` to a UTC RFC3339 timestamp ending in `Z`,
for example `"2026-12-01T09:00:00.000Z"`. Invalid dates, numeric timestamps,
and non-UTC offsets return HTTP 400 before creating a Workflow. Omit the field
(or use `null`) to complete immediately after approval. A past timestamp also
completes immediately after approval; it never bypasses the approval event.

After receiving approval, Haskell calls `workflowSleepUntil` when the target is
still in the future, then runs the durable `finish-request` step. Preparation happens before approval; the deduplicated D1 business write and
completion both happen after approval and the scheduled time. Approval with
`approved: false` remains a recorded decision and follows the same completion
schedule. Native pause, resume, termination and restart behavior is preserved.

The real Wrangler tests reject malformed dates, verify that a past schedule
still waits for approval, and check that a future schedule cannot finish early.

The test-only Workflow also covers event timeout, unrelated event types,
malformed approval payloads and each retry backoff mode. Another test restarts
Wrangler while the UTC timer is pending, explicitly wakes native replay with a
test-only unrelated event, and checks that the business write is not early or
duplicated. Automatic timer resumption after process restart failed in the
tested local Wrangler 4.118.0 / Miniflare 4.20260722.0 environment; this recovery
test does not claim otherwise. Cloud-hosted automatic recovery is untested. See [operation coverage](../../docs/audits/workflow-coverage.md)
for the operation-to-scenario-to-test mapping and its explicit limits.

## Platform-generated identifiers for one-off requests

`POST /workflows/generated` accepts an `ApprovalRequest` directly, without an
`identifier` or `parameters` wrapper:

```sh
curl -H 'Content-Type: application/json' \
  -d '{"message":"one-off report","behavior":"normal"}' \
  http://localhost:8787/workflows/generated
```

Haskell calls `workflowCreate workflow Nothing input`. The response includes the
platform-generated `identifier`; retain it and use the existing status, approval,
audit and control URLs with that value. Optional `executeAt` has the same UTC
validation and scheduling semantics as requests with explicit identifiers.

Each submission creates a separate instance, even if its body is identical.
This endpoint is therefore **not idempotent across HTTP retries**: if a create
response is lost, blindly resubmitting can create another job. Use the original
`POST /workflows` route with a caller-managed stable identifier when a submission
must address a known instance, and use status lookup to recover an uncertain
creation outcome. The existing instance-scoped D1 deduplication prevents repeat
business writes within one instance; it does not deduplicate separate generated
instances. A duplicate explicit create follows native Workflow error semantics,
not a promise that this HTTP API returns the existing instance.

Each HTTP request and Workflow run creates its own reactor from the shared compiled WebAssembly module. The GHC scheduler and JSFFI state are not shared across invocations: sharing them caused cross-request I/O errors during concurrent Workflow activity. Test fixture invocations follow the same ownership rule.
