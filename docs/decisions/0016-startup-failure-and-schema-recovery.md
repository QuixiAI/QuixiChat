# ADR 0016 — Startup failure outcomes and schema-mismatch recovery

Date: 2026-09-09  
Status: Accepted for the startup outcome view; Proposed for the rescue export and read-only recovery steps below.

## Context

[Plan 03](../plans/03_build_storage_repositories.md) requires the recovery and
export path to be defined before a canonical migration that cannot safely
complete is shipped. [Plan 23](../plans/23_build_diagnostics_and_recovery.md)
later builds general diagnostics and repair on the same foundation. The
canonical migrations are still unreleased, so no user archive can yet meet a
migration this build refuses, but the roadmap's first usable build will freeze
that boundary.

What the repository already guarantees, each with existing evidence:

- The [canonical migration runner](../../packages/storage/src/worker/canonical/repository.ts)
  commits each upgrade together with its checksummed ledger row. An injected
  failure inside a migration rolls that migration back and leaves the previous
  valid schema and data in place; an altered ledger checksum, an unknown future
  ledger row and an unsupported target version all fail with `MIGRATION_FAILED`
  and change nothing. See the
  [canonical SQL suite](../../packages/storage/tests/canonical/repository.test.ts)
  ("migration upgrades and injected failures preserve the previous valid schema
  and data", "schema 7 upgrade retains canonical history").
- The [frozen schema-8 worker proof](../../packages/storage/tests/selection/schema8/README.md)
  shows an actual older production worker rejecting a newer committed schema at
  startup with `MIGRATION_FAILED` while every canonical, sync and transaction row
  stays byte-identical, in Chromium and WebKit.
- The [retained archive reader](../../packages/storage/tests/retained/README.md)
  reads an existing archive without migrating it when its ledger is a prefix of
  this build's migrations, and refuses schema-7, future, altered-ledger, missing
  and hot-journal states without changing any file. It never opens the ordinary
  writable constructor.
- [ADR 0012](./0012-archive-selection.md) fixes the rules: retained access is a
  narrow reader, an upgraded-but-unselected archive is a recoverable state, and
  silent downgrade or empty-archive recreation is forbidden.

What was missing: both host entry points reduced every startup failure to a
plain text line, with no distinction between a denied storage session, another
window holding the archive, a schema mismatch or a read error, no retry, and no
statement of what the user can still do. `openActiveStorageClient` already
surfaces the worker's typed boundary code, so the information was available and
discarded.

## Decision

### 1. Typed startup outcome view (implemented)

Both the web and desktop entries now render a shared startup-failure view when
the selected archive cannot be opened. It is derived from the boundary code by
[`describeStartupFailure`](../../packages/app/src/runtime/startup-failure.ts):

| Code | What the user is told | Retry |
| --- | --- | --- |
| `MIGRATION_FAILED` | The archive's schema history does not match this build; it was not opened or changed; use the Quixi version that last used it or update; a recovery export from this state is not available yet | Offered, not expected to succeed |
| `CONFLICT` | Another Quixi window, possibly an older version, holds the archive; close it and retry | Yes |
| `UNSUPPORTED` | Local archive storage is unavailable in this session; use a regular profile with site storage | Offered |
| `QUOTA_EXCEEDED` / `IO_ERROR` | Storage full or a local read/write failed; free space or check site data | Yes |
| `NOT_FOUND` | The selected archive is missing; Quixi does not create an empty one in its place | Offered |
| other | Generic failure with the exact message kept for diagnosis | Yes |

The view keeps the exact worker message under "Technical details", states that
the screen reads no history and changes no archive data, and never promises a
recovery path that is not implemented. A successful retry unmounts the view
before the application mounts. The mapping is unit-tested in
[`startup-failure.test.ts`](../../packages/app/tests/startup/startup-failure.test.ts),
and [`tests/e2e/startup-failure.spec.ts`](../../tests/e2e/startup-failure.spec.ts)
drives the real built web application with OPFS denied inside the production
worker, checking the heading, guidance, technical code and message, the absence
of any conversation controls, and a retry that fails again in place.

### 2. Rescue export (implemented)

When startup fails with `MIGRATION_FAILED`, the user must be able to move the
archive to a Quixi version that can open it without any code path interpreting
the unknown schema. `exportRescueArchive` in `@quixi/storage/client` and its
[dedicated worker](../../packages/storage/src/worker/rescue-export.ts) implement
the design below; the [retained proof](../../packages/storage/tests/retained/README.md#rescue-export)
shows byte-exact rescue of a compatible archive and of one with a future
ledger row, every refusal, and unchanged file hashes in Chromium and WebKit.
The startup outcome view now offers "Export archive for recovery" whenever the
host could read which archive was selected:
[`prepareRescueDownload`](../../packages/app/src/features/archives/rescue.ts)
streams the rescue chunks into host file staging one acknowledged write at a
time, finishes the transfer against the export's own length and digest, and the
view hands the verified file to the host's save flow from a separate user
gesture, with the same retained temporary-download confirmation as ordinary
exports. `tests/e2e/startup-rescue.spec.ts` (Chromium) creates a real archive
with a conversation, denies the owner worker's blob-directory creation on the
next start so the archive stays intact but cannot be opened, prepares and saves
the rescue archive from the outcome view, and verifies the downloaded TAR:
exact entry order, SQLite magic, manifest length and digest matching the
database bytes, a compatible ledger, the conversation title present in the
bytes, temporary-copy cleanup, and the untouched archive opening normally once
the denial is lifted. Design:

- A dedicated read-only worker, following the retained reader's admission,
  owner-lock `ifAvailable` and no-journal rules, streams the exact
  `/archive.sqlite3` bytes out of the SAH pool slot and every published blob
  file into the standard portable TAR through the existing host staging and
  `file_save` transfer path. It refuses when a hot journal or transient slot is
  present (`IO_ERROR`, "recovery requires its compatible writable owner"),
  because the bytes would not be a consistent database.
- `format.json` declares `kind: "rescue"`. The manifest's `recovery` block
  records the ledger rows as found (version, name, checksum) or the reason they
  could not be read, whether that ledger is a prefix of the build's migrations,
  the build's own migration count, the SQLite header page size and page count,
  the database length and SHA-256, and blob-file counts including names it
  skipped. It contains no interpretation of canonical rows. The ledger is read
  only after the exact bytes are copied, through the same validated read-only
  pool path as the retained reader.
- No derived index, workspace metadata, credential or host secret is copied.
- The outcome view offers "Export archive for recovery" only when the host
  could read the selected archive identity; the section is absent, not
  disabled, otherwise. A refusal (held owner, journal state, missing database)
  is shown as the export's own error and changes nothing.

### 3. Restore validation of rescue archives (implemented from schema 8)

The production restore path accepts `kind: "rescue"`. The received database
is imported as a raw file, verified against its received checksum, and its own
migration ledger must agree with the manifest and be equal to, or a strict
prefix of, this build's migrations. It is then cleaned into a fresh candidate
database with the same `CleanSnapshotCopy` step that portable exports use, so
local selection state, operation claims, producer leases, unfinished imports
and derived data never enter the candidate. From there the standard schema,
integrity, record, topology, journal and blob validation run unchanged, with
the manifest's canonical summary derived from the cleaned candidate. Blob
files copied "as found" that no canonical record references are removed from
the candidate once validation passes.

Since 2026-09-09 the same path is the migration-aware candidate upgrade: the
fresh-schema copy creates the candidate at this build's schema and copies the
canonical, journal, referenced-catalog and local-state rows from the raw
database, so a prefix ledger is upgraded in the isolated candidate before
validation and before the review token is bound; the received bytes and the
failing source archive are never migrated. The upgrade floor is schema 8, the
first cohort with a frozen production writer proof, because every later
migration only adds objects or replaces triggers (`RESTORE_UPGRADE_FLOOR` in
the [archive worker](../../packages/storage/src/worker/archives/index.ts)).
Portable archives whose declared ledger is such a prefix take the same raw
import and clean copy. A ledger below the floor, beyond this build, or with a
migration whose name or checksum differs from this build's history is refused
naming the version, and the manifest must match the database's own ledger.
The job reports `sourceSchemaVersion`, and the review names the upgrade. The
[retained proof](../../packages/storage/tests/retained/README.md) restores a
genuine schema-8 rescue archive and refuses a schema-7 archive and a tampered
ledger; the [archive proof](../../packages/storage/tests/archives/README.md)
restores a genuine schema-8 portable with identical records and journal and
revalidates it after owner restart. A rescue archive is never activated in
place of the failing archive without the reviewed replacement flow from ADR
0012.

### 4. Read-only history at a compatible prefix (implemented)

When the ledger is a compatible prefix of this build (a rolled-back or
interrupted upgrade, or an environmental failure with an intact archive) the
retained reader serves bounded canonical reads. The outcome view now mounts
[`RetainedHistory`](../../packages/app/src/features/recovery/RetainedHistory.tsx)
on exactly those operations: a paged library list, a thread view with its
system prompt, the active conversation window and each message's inline text
parts. Long blob-backed text and non-text parts are named, not loaded. It
offers no sending, editing, importing, search or write and runs no migration;
an incompatible ledger is reported as history this version cannot read, with
the rescue export as the way forward. `tests/e2e/startup-rescue.spec.ts`
lists and opens the real conversation from the failure view before the rescue
export in Chromium.

### 5. Migration policy that keeps recovery possible

- Every migration stays a single committed step with its ledger row; a step
  that needs data rewriting must be resumable from its own committed state or
  fail as a whole. No migration deletes canonical rows or blobs.
- A migration that this build cannot complete on a given archive must fail with
  `MIGRATION_FAILED` and leave the previous schema; the runner must never mark
  the ledger ahead of the data.
- Before the first release that freezes a schema, steps 2 and 3 must pass their
  browser proofs, so a user on a newer build can always carry an archive
  forward and a user on an older build is refused with the exact reason.

## Consequences

- Startup failures are now distinguishable, retryable where sensible, and
  honest about what is unavailable. This closes the "visible, actionable
  failure" half of plan 03's migration task; the export/recovery half remains
  open until the rescue export and its restore validation pass their proofs.
- The recovery export is byte-level by design, so it cannot be silently wrong
  about canonical semantics it does not understand; the receiving build owns
  interpretation.
- Plan 23's "what remains accessible when a migration fails" is answered by
  sections 2 and 4: the exact bytes and, at a compatible prefix, bounded
  read-only history. Derived-index failure is unaffected by this ADR: search
  data is rebuildable and never blocks startup.

## Evidence and remaining gates

- On 2026-09-09, `npm run test:app:startup` (2 tests) and
  `npx playwright test tests/e2e/startup-failure.spec.ts tests/e2e/storage-unavailable.spec.ts`
  passed in Chromium and Playwright WebKit on macOS 26.6.2 against the built
  web application, and `npm run check` passed. In Chromium the injected denial
  reaches the selection catalog worker, which now reports `UNSUPPORTED` with
  the browser's own error preserved as the cause; the view shows the
  storage-unavailable guidance and the exact message.
- Interrupted first run, found and fixed by this proof: the previous WebKit
  run showed that a first-run initialization interrupted after the namespace
  directory existed but before its pool database was written left every later
  attempt refusing with "Selected archive database is missing", because
  default initialization decided "existing archive" from the directory alone
  and then opened without creation. `ArchiveDatabase.open` now takes
  `create: 'if-empty'` for default initialization: a namespace with neither a
  pool database nor any blob file is created; a namespace with a database is
  opened as is; a namespace with blob files but no database is refused. No
  empty archive ever replaces data. `tests/e2e/startup-failure.spec.ts`
  (Chromium, persistent profile) denies creation of the pool directory inside
  the production workers, checks the typed outcome and a failing retry, lifts
  the denial, and requires the retry to open a fresh archive that survives
  reload. Worker-script interception is not deterministic in WebKit, so
  `tests/e2e/startup-unsupported-session.spec.ts` covers WebKit with its real
  ephemeral-context storage failure: the typed view and retry are required and
  the outcome codes are recorded per run. On the recorded run the first attempt
  reported `UNSUPPORTED` from the catalog's storage access and the retry
  reported the generic outcome with "Archive selection worker failed", because
  the second selection worker did not start in that context; both rendered the
  view and neither mounted the application.
- The boundary mapping change (`NotAllowedError`/`SecurityError`, directly or
  as a wrapped cause, become `UNSUPPORTED`) is covered by the same runs; the
  managed selection browser suite is rerun after the catalog change.
- Rescue export, 2026-09-09: `npm run test:storage:retained` passes ten groups
  per engine with the rescue worker and client; the report and captured
  sources are retained under `packages/storage/tests/retained/evidence/rescue/`.
  `npm run test:storage:archives` (13 tests plus the browser snapshot proof) and
  `npm run check` pass after the format declaration change.
- Rescue restore, 2026-09-09: `npm run test:storage:retained` passes eleven
  groups per engine. A rescue of the candidate restores into an isolated ready
  candidate at this build's schema whose history reads back exactly and whose
  unreferenced planted blob is dropped; a rescue of the live default archive,
  including its selection state and claims, restores into a clean candidate;
  a future-ledger rescue is refused naming the schema versions; source files
  stay unchanged. `npm run test:storage:archives` and the selection suites are
  rerun after the restore-path change.
- Read-only history, 2026-09-09: the same Chromium spec shows the failed
  archive's library and opens its conversation read-only before the export,
  with no alert raised and the archive still opening normally afterwards.
- Outcome-view rescue, 2026-09-09: `tests/e2e/startup-rescue.spec.ts` passes in
  Chromium against the built web application alongside the other startup
  specs; WebKit is skipped for the same worker-interception reason as the
  interrupted-first-run spec. The desktop entry shares the view and workflow
  through its own host but has not been exercised natively.
- Not yet verified: an actual `MIGRATION_FAILED` reaching the view in the
  production web app. The frozen schema-8 proof shows the worker side; an
  end-to-end fixture needs a future-ledger row written into an archive the
  production entry will select, which requires either the activation flow or a
  test-only namespace route that ADR 0012 forbids on the production worker.
  Step 2's proof should use the activation flow on a cloned candidate.
- The desktop entry shares the view but has not been exercised in a native
  failure run.
