# Managed selection catalog acceptance

The production component is
[`managed-catalog.ts`](../../../src/selection/managed-catalog.ts). It uses the
initialized module supplied by
[`loadStorageSqlite()`](../../../src/worker/sqlite-module.ts), shared with the
worker's canonical archive connection. There are no proof fault hooks in either
production file. Tests wrap the actual injected SQLite module to interrupt SQL or
lose confirmation; canonical fixture databases and the catalog use real OPFS.

Run from the repository root:

```sh
npx tsc --noEmit -p packages/storage/tests/selection/managed/tsconfig.json
node packages/storage/tests/selection/managed/run.mjs
```

The shared `QUIXI_TEST_BROWSERS` selector applies. Port 4203 and disposable
persistent browser profiles isolate the suite. The latest retained
[browser-evidence.json](browser-evidence.json) has 11 Chromium and 10 WebKit check
groups. Chromium adds actual browser-enforced OPFS quota denial with an 8 MiB
transaction, under a total quota below 32 MiB. WebKit explicitly records that
the equivalent CDP API is unavailable; real SQLite FULL rollback runs in both.
This is component acceptance, not production restore activation or native-host
qualification. Candidate reviews are original synthetic fixtures; the test
barrier owns the candidate Web Lock but does not replace full archive validation.

## Stable integration API

```ts
const catalog = new ManagedSelectionCatalog(await loadStorageSqlite(), {
  initializeDefault: async () => {
    // Already under catalog.gate. Acquire default owner with ifAvailable,
    // create/validate its concrete canonical database, then close/release.
  },
});
await catalog.read();
await catalog.status(operationId, optionalFullArgs);
await catalog.guard(expectedSelection, async () => canonicalWork());
await catalog.activateReviewed(
  { operationId, expectedSelection, review },
  { signal, withReviewedCandidate: commit => archive.withActivationReview(
      review, signal, async () => commit(),
    ) },
);
```

`ManagedArchiveSelection` is `{archiveId, selectionRevision}`. The activation
receipt contains `{operationId, payloadSha256, previous, selected, review}`.
`ManagedActivationStatus` distinguishes `not_found`, `prepared`, `interrupted`,
`failed` and `committed`; only committed includes a receipt. Local exported types
can be aliased by the integration boundary. Metadata is preflight-bounded at
16 KiB; every field of the normalized complete review and candidate summary is
included in identity checks. Unknown fields are rejected instead of ignored.
Stored payload/receipt/status and schema reads are bounded before entering JS.

Production location and initial selection are fixed:
`/quixi-selection/catalog/selection.sqlite3`, lock `quixi:selection:owner`, initial
`{archiveId:'default',selectionRevision:0}`. Only explicit `testDirectory:'test-*'`
options can override the directory, with a corresponding isolated test gate.
There is no arbitrary initial archive or switch operation; trying to activate a
previously selected retained candidate under a new operation is rejected.

## Bootstrap and recovery responsibilities

On an absent catalog root, `initializeDefault` runs before any catalog directory
or SQL is created. It must create/validate the actual default archive and return
only after durable completion. It must use **nonwaiting `ifAvailable` owner-lock
admission**: waiting for a source owner while holding the catalog gate would
invert normal source-owner → catalog ordering. It must not reenter the catalog.
The callback's failure leaves no newly created catalog. An existing catalog never
calls it, even when required catalog files or the selected archive have vanished.

The application callback must also distinguish whole-catalog deletion from first
initialization using independent durable bootstrap evidence in the default
archive. Root integration is responsible for its `quixi_local_state` marker:
when a prior marker exists but the whole catalog root is gone, refuse adoption
and require recovery. A crash between recording that marker and creating the
catalog fails closed; do not automatically remove the marker. The component
cannot reconstruct a deleted catalog from absent files. Complete origin storage
clearing is indistinguishable from a fresh installation.

`read`, `guard` and a new activation check that the selected namespace and
`database` directory exist. Global `status` requires only valid catalog
schema/head/receipt metadata; it remains usable when a selected archive is missing.
Same-ID committed activation replay also precedes archive existence checks, so
receipt recovery never requires reopening a missing source or selected archive.
Existing archive files are never created as recovery. The canonical owner
must additionally verify `/archive.sqlite3` exists on ordinary startup, because
the catalog cannot acquire an already-owned archive's SAH pool to inspect that
mapping. Physical catalog corruption, missing SQLite mapping, missing required
directory, unsupported schema or invalid head/receipt fail unavailable.

## Ordering and outcomes

Normal canonical work enters its source owner queue before `guard`. The guard
holds the global gate until its effect returns; it never acquires archive locks
on the caller's behalf. `activateReviewed` also owns exactly one global gate.
Its external barrier is responsible for the sole candidate lock, full persisted
review validation, schema compatibility, source high-water and producer checks.
Do not wrap activation in `guard` or nest another selection call in its callback.

Prepared intent is durable before validation. Only the synchronous, single-use
commit callback atomically writes head, per-operation receipt and retention.
It expires after validator return/throw. A confirmed receipt remains authoritative
after cleanup throws, cancellation arrives, or pool close fails. A usable
connection can reconcile a lost COMMIT confirmation; if publication was attempted
and cannot be inspected, the result is `UNKNOWN_OUTCOME`, even if cancellation
also arrived. Stable operation identity resolves that outcome after restart.
An interrupted prepared intent is never treated as committed. Retry requires the
same complete review and a new execution of validation.

Source/candidate canonical transactions and this catalog transaction are separate.
No cross-database atomicity is claimed. Catalog and archive pools open within
their respective lock lifetimes and pause after each catalog operation. A close
failure poisons that catalog instance; known committed receipt remains available
to the caller, and a new owner can reopen to inspect durable state.

## Measured cases

- Bootstrap failure and default-owner contention create no catalog; existing
  reads do not bootstrap again; module initialization is shared and admission
  is bounded to 16 calls per instance.
- Two real workers race atomic head/receipt publication. Stale guard does not
  write the separate real fixture database; current guard can write it.
- Complete candidate/review identity conflicts, oversized fields, callback
  expiry/double use, precommit cancellation and postcommit cleanup outcomes.
- SQLite FULL and actual Chromium quota rollback; lost/unreadable COMMIT
  confirmation including concurrent cancellation.
- Actual worker termination after intent and inside a SQL transaction; explicit
  same-ID revalidation; lost real committed reply recovered after a later switch.
- Pool-close failure, missing catalog directory, missing SQLite file mapping,
  missing selected namespace and physical SQLite header corruption. A missing
  selected namespace blocks reads/guards but preserves global receipt inspection
  and same-ID committed replay.
- Complete persistent browser-process restart preserves active selection,
  earlier receipt and meaningful interrupted intent.
