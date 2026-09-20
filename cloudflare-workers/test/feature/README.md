# Durable Object native storage bindings

The transaction fixture calls the public Haskell library from the existing
realtime test Worker, against local Wrangler/workerd SQLite storage. No upstream
runtime changes, cloud deployment, credentials, or hut-specific abstractions
are required.

```sh
pnpm install --frozen-lockfile
bash examples/realtime/scripts/build.sh
node --test cloudflare-workers/test/feature/durable-object-transaction.spec.mjs
```

The same Haskell checks run through the existing realtime SQL integration test.
Assertions are split between `DurableObject/TransactionFixture.hs`,
`DurableObject/TransactionLifecycle.hs`, and `DurableObject/SQLExecFixture.hs`.
Host-only input validation tests live under `test/unit`.

## Contract

- `doStorageTransactionWith storage action` bridges SQLite-backed
  `storage.transaction`. Run SQL, KV and Alarm operations against that storage.
  The native transaction owns isolation and commit/rollback.
- A normally returned value, including `Left`, commits. An exception escaping
  the action rejects the callback. Its Haskell type and payload are retained.
  Catching an SQL exception inside the action does not add an implicit abort.
- Native transaction failure retains its JS cause internally in the opaque
  `DurableObjectTransactionError`. Only its diagnostic text accessor is public;
  no JSVal accessor or domain-error conversion is added.
- Cancellation before/during the callback rejects it and waits for settlement.
  Cancellation after successful callback completion cannot undo a requested
  commit. Cleanup waits uninterruptibly for native settlement before releasing
  the controller, and may block if native settlement never arrives.
- Callback values are not deeply evaluated. Await async work in the callback;
  do not launch storage work that outlives it. No retry or timeout policy is added.
- KV-backed DO callback retries and their transaction object are not supported
  by this new function. The bridge checks SQLite availability before invoking
  the action. The existing KV operation-list API is unchanged.
- `sqlExec` eagerly consumes the cursor with the existing `SQLLimits` encoding,
  but does not introduce `transactionSync`. Consequently, a post-execution
  output-limit/decoding error alone does not roll back the executed statement.
  Let it escape the enclosing transaction callback when rollback is needed.
- `sqlExecute` and `sqlBatch` retain their existing transactionSync behavior.
- `doStorageGetAlarm` returns the epoch-millisecond timestamp or `Nothing`, with
  the platform's default options. Alarm scheduling/recovery policy belongs to
  the caller.

## Evidence and limitations

Real storage checks cover commit/rollback of SQL and Alarm changes, typed
exceptions, native SQL constraints, caught errors, normal `Left` returns,
eight overlapping Haskell callbacks with suspension, cancellation during the
action, and 100 sequential controller lifecycles. Direct SQL checks cover typed
values, no added transactionSync, and output-limit rollback boundaries.

Controlled native test doubles separately cover pre-entry failure, commit
failure, unprintable errors, and cancellation while queued or settling. These
are lifecycle tests, not proof of remote commit durability or acknowledgement
loss handling. A process crash, WASM trap, or CPU exhaustion cannot be turned
into guaranteed Haskell cleanup by this bridge. There is no distributed
transaction, Outbox, TransactionManager, or DomainError implementation here.

Sources:
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://downloads.haskell.org/ghc/9.14.1/docs/users_guide/wasm.html#foreign-imports
