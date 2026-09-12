# Frozen production schema-8 writer barrier

This isolated compatibility proof captures the actual pre-fence production
`packages/storage/src/worker/archive.ts`, including its database/repository and
protocol dependencies. It does not replace the old worker with a cooperative
fixture. The page sends the existing public worker envelopes directly; the old
owner election, BroadcastChannel forwarding, migration check, canonical commit,
sync journal and shutdown execute from the frozen bundle.

Run from the repository root:

```sh
npx tsc --noEmit -p packages/storage/tests/selection/schema8/tsconfig.json
node packages/storage/tests/selection/schema8/run.mjs
```

The shared `QUIXI_TEST_BROWSERS` selector applies; default is Chromium and WebKit.
The runner uses port 4202 and disposable persistent browser profiles. It writes
`test-results/schema8-writer-barrier.json`. The retained
[browser-evidence.json](browser-evidence.json) records seven checks per engine on
macOS 26.6.2/arm64, including complete browser-process restart. This is browser
evidence, not installed Safari, Tauri or Linux qualification.

## Immutable old code

[frozen/manifest.json](frozen/manifest.json) records the capture time, source-input
hashes and artifact hashes. The captured worker SHA-256 is
`87d0d0e60cbb3a5972b9d2fd7810be7ef6f18f34e44dd27b8049b69cbe05e5dd`.
`freeze.mjs` refuses to overwrite that manifest and refuses any source migration
set other than version 8. **Do not rebuild this worker when production advances.**
Acceptance verifies the retained JS artifact, and copies only the exact pinned
SQLite WASM bytes named by the frozen manifest into its temporary server. WASM is
globally ignored; a differing/missing pinned WASM fails rather than silently
substituting a new engine. The marker worker is separately built test code.

## What the evidence establishes

1. The real old owner and follower commit valid canonical threads with sync
   operations through the existing protocol. The old owner holds
   `quixi:archive:<id>:owner` and excludes a prospective upgrade.
2. An explicit SQL rollback leaves version 8 and unchanged canonical data. An
   old production worker can reopen it.
3. Terminating the marker worker inside its actual SQLite transaction recovers
   the rollback journal. The old worker still opens schema 8 and can commit.
4. A marker commits version 9 while holding the same owner lock. A previously
   running old follower queued after the marker acquires the lock next and
   rejects its queued mutation with `MIGRATION_FAILED`.
5. A newly created frozen old worker likewise refuses before canonical commit.
6. A separate candidate namespace behaves identically after abrupt old-owner
   termination, marker commit and old-worker restart.
7. A complete persistent browser-process restart preserves version 9 and the
   refusal. Exact canonical rows, sync rows and transaction receipts match the
   pre-refusal snapshot; SQLite integrity remains `ok`.

The future marker is a **test-only** migration-ledger row in restricted
`schema8-proof-*` namespaces. It is not migration 9, a selection pointer, archive
activation or an accepted application rollout. No production migration changed.

## Startup and failure analysis

In the captured `worker/archive.ts`, `start` acquires the exclusive owner lock
before `ArchiveDatabase.open`. The owner announces itself and starts foreground
or idle work only after opening succeeds. `ArchiveDatabase` constructs its
repository and calls `migrate()` before blob-catalog owner reconciliation,
producer recovery, views, archive jobs, search initialization or request drain.
`CanonicalRepository.migrate()` rejects `max(version) > 8` before attempting any
canonical migration. There is no reset/downgrade/recreate fallback in this path.
Failed opening closes the blob store/database, pauses the SAH pool, releases the
owner lock and emits the migration failure.

Refusal is a logical canonical-write barrier, not a promise of byte-identical
OPFS: directory/pool opening, SQLite journal recovery, PRAGMAs and the existing
migration-table `CREATE IF NOT EXISTS` occur before the version rejection. The
proof checks logical canonical/sync/transaction equality and integrity.

## Conditions and remaining production work

- **Schema alone does not fence forwarded requests.** Old followers can send
  v1 calls without opening/migrating locally; the first check demonstrates this
  forwarding. New owners need a new protocol/channel and mandatory validated
  selection fences. They must reject legacy/unversioned envelopes rather than
  serving v1 writes to an old follower on its behalf. That new protocol has not
  been implemented or tested here.
- An already-open old owner remains writable until it releases its lock. The
  upgrader must wait or fail; it cannot declare activation complete while an
  old owner remains. Only a committed upgrade is a barrier. Both the source and
  candidate need the supported newer schema before the selection commit, with
  their owner locks held across the relevant validation/publication sequence.
- This proves the captured current production writer, not every build called
  "schema 8" or every older version. Enumerate and inspect actual shipped
  cohorts. Code that bypasses migrations/owner locks, edits migration history,
  or accesses the file through an unrelated writer is outside this proof. The
  earlier selection fixture's direct SQL legacy bypass remains a valid negative
  result for such a writer. The older storage proof uses its own nested
  `proof-<namespace>/proof.sqlite3`, not this canonical database.
- Current restore validation opens a fresh candidate read-only after import;
  its owning source `ArchiveDatabase` still passed migration at startup.
  Replacing schema-8 restore validation with migration-aware schema-9 candidate
  handling is separate work. A migration changes database bytes/ledger/version:
  perform it before binding the final reviewed candidate summary/token, or
  require a fresh review. Do not reuse a hash/token for the pre-upgrade image.
- The selection catalog and source/candidate upgrades are distinct SQLite
  transactions. Persisted recovery must tolerate an upgraded source/candidate
  without a switched pointer, a failed upgrade, and a lost selection reply;
  never downgrade a committed barrier as cancellation cleanup.
- Production managed-client bootstrap, retained inspection, recovery/idle
  writes, stale new-protocol requests, restore review composition and actual
  native lifecycle remain unqualified. ADR 0012 remains Proposed and activation
  stays disabled.
