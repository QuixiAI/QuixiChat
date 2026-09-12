# Stable local operation claims

`node packages/storage/tests/operation-claims/run.mjs` runs 21 tests against the
repository's pinned SQLite WASM, checking the artifact SHA-256 before execution.
`node_modules/.bin/tsc --noEmit -p packages/storage/tests/operation-claims/tsconfig.json`
checks the focused TypeScript surface. Both passed on Node 22.23.1, macOS arm64.

The latest [machine report](results/registry-wasm.json) and [TAP](results/registry.tap)
record source fingerprints, migration SQL identity, engine identity and results.
The runner writes `in_progress` before execution and records failed or timed-out
commands, so a failed rerun cannot retain a stale passing report. CI should retain
`packages/storage/tests/operation-claims/results/**`.

These are real SQLite tests in Node's memory VFS. They establish SQL transaction,
repository and schema behavior; they do not establish browser owner termination,
OPFS persistence, public dispatch integration or a PDF extraction engine. The
extraction fixture injects a synthetic document/blob identity while using the
actual extraction repository and durable registry.

## Integration contract

- Apply immutable `OPERATION_CLAIMS_MIGRATION` through the ordinary canonical
  migration ledger before enabling local extraction writes. Version 10 adds
  `quixi_local_operation_claims` and nine stable SQL triggers without rewriting
  canonical history. Raw SQL SHA-256 is
  `48a9b27106bb7bf3c52726a8dad9c3f91fdd05abd191247e8eb48973c3dc8a8b`.
  The canonical ledger separately hashes the canonical JSON string of the SQL.
- Construct `new OperationClaimRegistry(db, sqlite)` with the **same** actual
  database connection and SQLite module used by `ExtractionRepository`. Pass it
  as `operations`. Constructors do not install schema or start transactions.
- The extraction repository checks its existing receipt before calling
  `claim({ operationId, domain: 'extraction', requestDigest })`. The digest covers
  the complete operation kind and arguments. The registry hashes canonical JSON
  `{ version: 1, operationId, domain, requestDigest }`; domains are at most 64
  ASCII characters and both digests are lowercase SHA-256 hex.
- `claim` requires an active transaction, verified with SQLite's
  `sqlite3_get_autocommit` on that connection. Claim, derived receipt and effect
  commit or roll back together. It never commits, rolls back or creates schema
  itself. Missing table or expected guards fails `MIGRATION_FAILED`.
- Existing identical claims reaching `claim` fail `UNKNOWN_OUTCOME`: the prior
  receipt is unavailable, so retry cannot silently execute again. A changed
  request digest or domain fails `CONFLICT`. SQLite constraints map to
  `CONFLICT`; SQLite FULL remains available to the extraction repository's
  `CAPACITY` mapping and rollback handling.
- After the archive journal exists, call
  `installArchiveOperationClaimFences(db)` during owner setup, alongside existing
  archive fences. Its two reciprocal triggers are installed atomically under a
  savepoint. A present archive journal without these guards blocks claims.
  Request execution never installs them.
- `registry.lookup(operationId)` and free
  `readOperationClaim(db, operationId)` return a validated `OperationClaim` or
  `null`, without a writer transaction or schema changes. Corrupt stored fields
  or identity hashes fail `MIGRATION_FAILED`. Public status should consult prior
  receipts first; a claim without a resolvable receipt must become
  `UNKNOWN_OUTCOME`, never `not_found`. Read-only retained readers supporting
  valid pre-10 ledgers may establish that the table is absent by design before
  invoking the helper; the helper itself fails closed on a missing table.

The fences cover both insertion orders for canonical sync operations, import
control, import record reservations, blob operations, importer work and archive
operations. Claim rows cannot be updated, deleted or replaced, even through
`INSERT OR REPLACE`, `INSERT OR IGNORE` or UPSERT. No canonical trigger refers to
`quixi_extract_*` or `quixi_search_*`; those repairable tables are not the identity
authority. The registry checks required guard presence. The owner's normal
canonical migration/schema validation remains responsible for the trusted schema.

## Evidence and compatibility

The 21 tests cover independent versioned digest calculation; fail-closed missing
schema/guards and inactive transactions; same-ID recovery versus changed-payload
conflicts; read-only lookup and corrupt identity refusal; both journal insertion
orders for all six domains; immutable rows; real canonical commit collision and
rollback; migration 9 to 10 preserving canonical history; extraction precommit
rollback and exact receipt replay; extraction clear and complete derived schema
repair; actual SQLite FULL rollback followed by a successful same-ID retry;
SQLite close/reopen; a clean snapshot copy with canonical rows unchanged; and
the actual portable canonical validator accepting empty schema-10 claim metadata
while rejecting an otherwise identical candidate containing a claim. Both
validator cases configure the real defensive/query-only connection and preserve
the candidate's exported SQLite bytes exactly.

The first run had one test-fixture failure: the intentional precommit exception
was armed during extraction schema initialization instead of the operation under
test. The [initial report](results/initial-fixture-failure.json) and
[TAP](results/initial-fixture-failure.tap) are preserved. The fixture was corrected;
production registry code did not require a change.

Claims are durable **local protocol metadata**, not portable canonical history.
They must survive derived clear/repair and must not be garbage-collected as
extraction receipts. They are deliberately excluded by `CleanSnapshotCopy`'s
whitelist: a fresh version-10 target contains the table and stable triggers with
zero claim rows. The test exercises that actual copy, not a mock whitelist.
The owner added a schema-10 portable archive validation check rejecting nonempty
claim tables; matching executable schema alone cannot establish that local rows
are absent. This suite now verifies that real validator check, including a valid
empty-table control. Public status/dispatcher and browser restore integration
belong to the owner workstream and are not claimed by this isolated evidence.
Runtime archive-journal triggers are installed after opening the active archive;
they are not part of the clean portable canonical schema.
