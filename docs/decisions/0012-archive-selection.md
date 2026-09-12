# 0012 — Reviewed archive selection and stale-context fencing

**Status: Accepted for the implemented local selection protocol.** Production-path Chromium/WebKit evidence supports the implementation described below. Shared UI/remount acceptance and complete deployed-host, scale and older-portable compatibility qualification remain open.

## Implemented protocol and evidence

The public [selection contracts](../../packages/core/src/contracts/selection.ts)
and [managed client](../../packages/storage/src/client/selection.ts) supersede the
earlier proposal shapes retained below. Both hosts resolve one selection and await
its owner handshake before mounting. Every production worker call carries that
fixed archive ID/revision; owner startup, foreground effects and background work
check the catalog while holding its global gate. Separate test workers accept only
explicit `test-*` namespaces and do not change the production ingress policy.

Canonical migration 9 is a committed ledger barrier for the known schema-8 writer
cohort. Protocol 2 rejects old direct and forwarded envelopes. The
[mixed-version proof](../../packages/storage/tests/protocol/README.md) uses the
unchanged frozen old binary; arbitrary same-origin code and unqualified deployed
cohorts remain outside that evidence.

The [managed catalog](../../packages/storage/tests/selection/managed/README.md)
stores the exact full review, selection and receipt atomically. Source queue →
catalog gate → nonwaiting candidate-owner lock is the activation order. The
existing review barrier alone acquires/revalidates the candidate. Known successful
receipts survive later cleanup errors, cancellation and lost replies. Global
receipt status remains readable when the selected archive disappears; ordinary
startup/guard/new activation still refuse missing data.

Fresh catalog bootstrap creates or adopts the real default archive under a
nonwaiting owner lock and writes an independent local bootstrap marker before
creating the catalog. A missing catalog with that marker is recovery-required,
not permission to select default again. Interrupted bootstrap can therefore
require explicit recovery; there is no empty-archive fallback. Clearing the whole
origin is indistinguishable from a new installation.

[Production activation checks](../../packages/storage/tests/selection/integration/README.md)
exercise real export/restore, reviewed selection, stale writes, live producers,
lost replies, process restart, missing data and retained source history. An
uncertain dispatched request keeps its original identity and reports
`UNKNOWN_OUTCOME`; a later stale notification cannot prove it did not commit.
Pending canonical changes can be reconciled through their original archive
without replaying them into the selected archive.

The [retained reader](../../packages/storage/tests/retained/README.md) is a separate
restricted worker: bounded raw SAH metadata validation, existing database only,
read-only SQLite, supported migration checks and a read-operation allowlist. It
never invokes the ordinary migration/recovery constructor. Actual file hashes
cover successful reads and refusal of malformed metadata, missing databases and
an interrupted transaction requiring recovery.

The remainder records design reasoning and the original integration inventory;
statements describing a proposed API or pre-integration state are historical.

## Requirement and current boundary

[Product §98](../product.md#98-archive-export), [§12](../product.md#12-multi-tab-ownership), [plan 09](../plans/09_add_archives_and_open_export.md), and [ADR 0010](./0010-portable-archives.md) require recoverable portable archives and coordinated local ownership. Restoration must preserve the previous usable archive and require an explicit review before replacement. It is not a merge, an import, or a deletion command.

`ArchiveRepository` currently produces an isolated candidate, persists an `ArchiveActivationReview`, and offers `withActivationReview`. That method compares the exact persisted token/job/candidate, checks the source's sync high-water, acquires the candidate owner lock without waiting, revalidates the candidate in bounded steps, and invokes a final callback while retaining that lock. It is a useful final barrier. It does not persist an active selection, fence other tabs, or make a pointer write atomic with either archive database.

Both host mains currently open archive `default`. Production composition must move to a managed selection client before activation can be exposed. Bootstrap should adopt that existing namespace when the selection catalog is absent, rather than inventing an empty archive and hiding existing history. An existing but unreadable selection store is recovery-required, not a first run.

“Host-wide” here means contexts sharing the same browser storage bucket/profile. Separate browser profiles, origins/ports and the native application are independent selections. Web Locks are cooperative coordination within a storage bucket, not protection against arbitrary same-origin code. [Web Locks specification](https://www.w3.org/TR/web-locks/)

## Minimal public contract proposal

Keep these host-local control identities outside portable canonical/sync history. Core types remain serializable and runtime-independent; the storage worker owns persistence and locks.

```ts
interface ArchiveSelection {
  version: 1;
  selectionRevision: number; // monotonic safe integer, never reset or reused
  archiveId: string;
}
interface ArchiveSelectionContext {
  selection: ArchiveSelection;
  sourceSyncHighWater: number;
}
interface ActivateArchiveArgs {
  operationId: QuixiId; // assigned at the user's logical action, reused on retry
  expectedSelection: ArchiveSelection;
  review: ArchiveActivationReview;
}
interface ArchiveActivationReceipt {
  operationId: QuixiId;
  payloadSha256: string;
  previous: ArchiveSelection;
  selected: ArchiveSelection;
  jobId: QuixiId;
  reviewToken: QuixiId;
  candidateManifestSha256: string;
}
```

Add `readArchiveSelection`, `readArchiveSelectionContext`, `activateArchive`, and `archiveActivationStatus({operationId})`. Activation returns a durable receipt; status distinguishes `committed` with that receipt, `not_found` only when the receipt store is readable and authoritative, and `unknown_outcome` when evidence cannot be read or its retention cannot establish the answer. A committed receipt can be superseded by a later selection; return current selection separately and never replay it by switching back. A reused operation ID with a different canonicalized payload is a conflict. Cap each request/receipt at 16 KiB and validate revisions against safe-integer overflow.

There are **two different revisions**. Existing `ArchiveActivationReview.expectedRevision` is the source `max(quixi_sync_ops.sequence)`. The proposed `selectionRevision` is the local pointer revision and catches switch-away/switch-back even if the same archive is selected again. Both must match. Existing `diagnostics.syncOperations` returns `count(*)`; it is not a valid substitute for high-water when a restored log contains gaps. The review-context read must expose actual `max(sequence)` under the same selection/owner fence. Keep count as count in diagnostics.

A token proves which candidate was reviewed, not user consent. The shared UI presents current archive, candidate summary, preservation of the previous archive, and interruption implications. Only its explicit replacement action invokes activation. A changed source, changed selection or candidate mismatch requires renewed review, not silent acceptance.

## Ordering and fencing

1. Enter the current source owner's serialized foreground queue. Drain preceding writes and pause maintenance. Coordinate live generation/import work before preparing the final review; the conservative first implementation refuses activation while a registered producer is live and asks the user to stop it. Provider cancellation cannot promise that external computation or billing stopped. Suspended contexts cannot be trusted to acknowledge a broadcast.
2. Acquire a global selection gate, then read and compare selection. Do not acquire that gate and subsequently wait for work queued behind a source operation that itself needs the gate. The lock order is source-owner queue → selection gate → candidate owner lock (`ifAvailable`), preserving the existing candidate refusal behavior.
3. Run `withActivationReview` while holding the gate. Source canonical writes and implicit maintenance remain serialized out. Revalidation retains the candidate owner lock through the selection commit; release it before managed clients try to open the selected candidate. No candidate writer may bypass that owner lock.
4. Persist exactly one new selection and its operation receipt using the selected protocol below. No canonical source mutation is part of activation. Once the persistence phase starts, cancellation cannot be reported as definitely before commit. On write/flush/reply failure, inspect durable evidence using the same operation ID.
5. Release locks and broadcast a selection-change hint. Dispose old application controllers, subscriptions, content leases and transfer clients; construct the new managed client, read its real workspace, and remount. If remount/open fails, show recovery with both namespaces retained. Do not silently roll back the selection or delete the candidate.

Managed clients attach their pinned `{archiveId, selectionRevision}` to worker initialization and every archive-bound call. The owner checks this fence **while holding the selection gate through the relevant effect**, not just when accepting a queued request. A stale context receives a conflict with current selection, preserves its unsent draft, and reconnects explicitly; it never retargets a mutation, chunk, operation-status lookup or canonical ID to a different archive.

The same gate applies to canonical commit, normalized-import publication, default-workspace creation, producer recovery, and any other implicit canonical write. Durable transfers/jobs and byte publication also need an explicit old-archive policy; the simplest first version rejects new stale-context work and allows only scoped read/status/release cleanup. Derived maintenance must not produce canonical writes after selection changes. BroadcastChannel messages and client-side checks improve responsiveness but are not the correctness barrier. Selection revision is an application concurrency fence, not a secret capability.

A single exclusive gate for effectful requests is the simplest first implementation; it adds selection reads to foreground work and can block tabs throughout full candidate revalidation. A shared gate for ordinary writes is a later optimization requiring a compatible selection-read/handle strategy. Progress/cancellation must still be delivered during bounded validation. Measure total write-freeze duration: bounded JavaScript memory does not imply short activation latency.

## Persistence alternatives to qualify

| Alternative | Commit and recovery | Costs and unresolved proof |
| --- | --- | --- |
| Two bounded checksummed OPFS slots | Highest valid selection revision, with equal-revision slots required to contain identical data. Write the inactive slot completely, check short writes, truncate, flush, close and reread before acknowledgment. Never overwrite the only usable copy. | Custom recovery, receipt retention and corruption policy. Every access must respect the gate and close file handles. No implied multi-file atomicity. |
| Small worker-owned SQLite selection catalog | One transaction updates the selection row and inserts an immutable operation receipt with unique operation ID and payload digest. Replay/status are ordinary indexed bounded queries. | Another pinned SQLite/SAH-pool database and owner lifecycle, additional OPFS files/quota, and startup/gate latency. Must prove journal recovery and ownership on each host. |

The SQLite alternative is worth prototyping first because the project already qualifies the same SQLite WASM/OPFS backend and needs durable idempotent receipts. It remains **proposed**, not automatically proven by canonical-database tests. Use a dedicated local namespace, schema/version ledger and owner Web Lock; do not place selection state in the archive being replaced or export it. A dedicated selection worker may hold its database ownership for a session, while the activation source owner holds the global effect gate across its bounded selection request. Ordinary callers must follow the same order; the selection service must not call back into a source queue while processing that request. Opening/closing the selection database under the gate per operation is a simpler alternative with potentially substantial SAH-pool overhead. Measure both before choosing.

The source database and selection catalog are **not one transaction**. Correctness comes from immutable candidate validation plus lock-serialized source checks followed by one local selection commit. If the source review is durable but selection did not commit, the old selection remains active. If selection committed but the source job was not marked afterward, its receipt establishes activation and the source bookkeeping can be reconciled later. No successful pointer commit may depend on a second canonical write to finish its atomicity.

For slots, a last-operation receipt alone is insufficient: after later switches overwrite both slots, a lost earlier reply becomes undecidable. Either retain immutable indexed per-operation receipts in a local catalog, or document historical `unknown_outcome`; never report absent evidence as an uncommitted action. A slot implementation with separate receipt files must durably reconcile the current head's receipt **before any later pointer replacement** can remove its evidence. That additional crash protocol needs its own tests, making slots less minimal than two files initially suggest.

Checksums detect corruption, not authenticity. A nonempty corrupt slot may represent a torn new write **or** damage to a previously acknowledged head. Selecting the remaining older slot silently as writable could undo an acknowledged replacement. Treat that ambiguity as degraded recovery: expose retained candidates and require review before writable selection repair. Both corrupt slots, equal-revision disagreement, unsupported format, invalid IDs and impossible revision transitions fail closed. Distinguish absent first-run files from corrupt existing files. Avoid automatic repair that overwrites the last readable evidence.

The File System standard exposes sync-handle `write`, `truncate` and `flush`, and exclusive file-handle ownership; it does not supply a cross-file transaction for two selection slots. Test actual process loss around each step rather than claiming crash atomicity from a checksum or successful API call alone. [File System standard](https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle)

## Retention, recovery and acceptance gates

The previous namespace is retained after success. Restore-job release must not delete ready/selected candidates, and future garbage collection must consult selection plus retained-archive references under the same gate. Namespace deletion is a separate explicit operation. A first activation receipt retains its immediate predecessor; a complete retained-archive catalog/listing and bounded receipt-retention policy remain follow-up decisions. No automatic receipt pruning is proposed here.

Imported streaming prefixes must remain exact until an explicit producer-loss reconciliation policy is applied with canonical operations. Old producers use archive-scoped locks and cannot be reassigned to the restored archive. Selection failure must not rewrite either archive's generation state to “complete.” Host credentials, selection receipts, live leases and derived indexes remain outside the portable archive.

Before exposing activation in either host, require actual production-client evidence for:

- Two-tab queued/in-flight writes, delayed followers and a missed broadcast: source writes linearize before activation or fail the selection fence afterward. Include bootstrap, imports and producer maintenance, not only `commit`.
- Switch-away/back with the same archive ID; source high-water different from count; changed source after review; candidate owner already held; tampered candidate bytes during the review-to-switch interval.
- Actual worker/browser-process termination at persistence boundaries; lost success reply; same-ID same-payload replay after restart and after a later activation; changed-payload conflicts; recovery inspection that never repeats a switch.
- Quota denial, short/failed writes and corrupt selection records: the old archive stays intact, ambiguity is surfaced, and no empty/default archive is silently substituted.
- Retained previous archive integrity and exact candidate contents, selected-archive reopen, released read/blob handles, bounded metadata, queue admission and measured freeze time on Chromium/WebKit and actual supported native WebViews.

No production archive activation acceptance has run for either persistence alternative; the isolated SQLite catalog proof exists and is linked below. Root integration may expose export and isolated restore progress while this decision remains Proposed; it must not present a completed candidate as already active.

## Production integration inventory — review only, 2026-09-08

The isolated [SQLite prototype and evidence](../../packages/storage/src/selection/README.md) now exist. They qualify a small selection transaction and cooperative fixture effects; they do not qualify the production integration below. This section proposes edits, not implemented behavior.

### Effect inventory and placement

The production owner is [worker/archive.ts](../../packages/storage/src/worker/archive.ts): `start` holds `quixi:archive:<archiveId>:owner` for the database lifetime; `enqueue`/`startDrain`/`drain` serialize foreground requests. The same `drain` runs idle cleanup, producer recovery and search after its foreground loop. Owner acquisition opens the database **before** `drain`, so wrapping only `execute` is insufficient. Cancellation bypasses the queue to signal active work and inspect outcomes; it must not reenter a selection lock held by that work.

| Path and exact entry | Current durable effect | Proposed fence |
| --- | --- | --- |
| [ArchiveDatabase.request](../../packages/storage/src/worker/archive-database.ts), `commit` | Blob prepublication/verification, `ProducerRepository.assertWritable`, `CanonicalRepository.commit`, postcommit stage consumption. All ordinary mutation kinds, including streamed output, edits and tombstones, converge here. | Guard the complete worker execution, including asynchronous preparation, through canonical commit. A narrower future fence needs a separate proof for blob-state changes during preparation. |
| Same dispatcher, `finalizeNormalizedImport` → [NormalizedImportRepository.finalizeNormalizedImport](../../packages/storage/src/worker/canonical/imports.ts) | Inserts canonical records/edges and `ImportRecord`/`PublishImport` sync operations in its own SQL transaction. It does not call `CanonicalRepository.commit`. | Guard this route explicitly; a guard attached only to `commit` misses publication. |
| Same dispatcher, `reconcileGenerationProducers` → [ProducerRepository.reconcile](../../packages/storage/src/worker/producers.ts) | Positively acquires archive-scoped producer locks and invokes `CanonicalRepository.recoverInterrupted`, which commits partial-generation completion and events. | Guard the explicit request through all recovered transactions. |
| `worker/archive.ts:drain`, `database.producers.reconcile(8)` | The same canonical recovery runs directly during idle maintenance, outside `execute`. | Separate guarded maintenance slice using the owner's pinned selection; stop scheduling when stale. Do not catch selection conflict as a transient producer failure and retry forever. |
| `start` → [ArchiveDatabase.open/constructor](../../packages/storage/src/worker/archive-database.ts) → [CanonicalRepository.migrate](../../packages/storage/src/worker/canonical/repository.ts) | Creates/opens the namespace and pool, writes ordered canonical schema/migration ledger, currently including schema 8. | After obtaining the archive owner lock, guard **before** directory/database creation, migration or constructor side effects. A stale queued owner must fail before changing disk. |
| Same constructor: `BlobCatalog.reconcileOwnerStart`, `new ArchiveRepository`, operation fences, search initialization | Marks unfinalized blob uploads interrupted; creates archive job tables/index and marks working jobs failed; installs identity triggers and derived schema. `BlobCatalog.initialize` itself only checks table readiness. | Include in the guarded startup. These are local recovery/schema writes, not additional canonical mutation routes. |
| `archiveWorkspace` → [ViewRepository.workspace](../../packages/storage/src/worker/views.ts) | `INSERT ... ON CONFLICT DO NOTHING` into `quixi_local_state` for `defaultWorkspaceId`. This is local identity bootstrap, not a canonical Workspace entity or sync operation. | Treat as effectful even though its public name sounds like a read. |
| Dispatcher import-work and normalized staging routes | `importRunBegin/SetState`, ID allocation, stage/seal/checkpoint/group finish, begin/stage/validate/cancel normalized import, `prepareImportBlobs` and transfer mappings write durable local staging/control records. | Guard all these active-archive operations; preserve IDs and unfinished work in their original namespace when stale. |
| Blob begin/finish/upload/read/discard and verification | [BlobCatalog](../../packages/storage/src/worker/blob-catalog.ts) writes transfer journals, verified epochs, UTF-8 evidence and quarantine state. In particular `readBlobTransfer` calls `openRead`, which can update/quarantine metadata. | Do not classify blob opening as a pure read. Default guarded dispatch covers it. Existing owner-local read/ack/handle-release cleanup needs a small explicit exception policy. |
| Archive begin/advance/finish/export/review/cancel/release routes | Source job/operation journals and temporary files; isolated snapshot/candidate databases can contain copied canonical rows without mutating source history. | Guard source job execution. Ordinary candidate progress cannot continue via a stale source context after activation. Ready-candidate deletion remains forbidden. |
| Idle `cleanupImportBlobs`, explicit/idle search rebuild/advance/repair | Local transfer cleanup, OPFS stage removal, search tables/triggers; search can also open blobs and update their verification metadata. | Guard each bounded idle slice. Derived work is not another source of canonical sync operations, but it is not disk-read-only. |
| `ArchiveDatabase.close` → `SearchRepository.close/release` | Search release deletes transient build rows; archive/blob close releases handles. | Quiesce search under the old selection fence before committing activation. Provide a handle-only stale shutdown path; closing must not require successful current-selection equality or leak handles when it fails. |

Exact source scans found canonical row/sync insertion in `CanonicalRepository` and normalized import publication; producer recovery reaches the former. Archive clean-copy/schema validation writes belong to isolated copies, not the active source. Future routes default to guarded execution until reviewed; do not maintain a fragile allowlist containing only today's canonical operation names.

### Mandatory access modes, including existing callers

Production writable access must cease being an optional client preference. Introduce a required private worker initialization union:

```ts
type ArchiveAccess =
  | {kind: 'active'; selection: ArchiveSelection}
  | {kind: 'retained-read'; archiveId: string; purpose: 'operation-recovery' | 'inspection'}
  | {kind: 'candidate-summary'; sourceArchiveId: string; jobId: QuixiId};
```

Before waiting for archive ownership, a bounded startup preflight may reject an already-stale selection or report an unrecognized owner cohort; it releases the selection gate before waiting and never substitutes for the guarded post-acquisition check. An old worker can otherwise retain the archive lock indefinitely, so initialization needs an actionable bounded failure rather than an endless loading state.

The active factory is asynchronous: read the host selection, construct a client pinned to that exact revision, and await the owner handshake before mounting archive workflows. Every call envelope, including forwarded BroadcastChannel calls and byte calls, carries the pinned selection. Recheck at dequeue/effect time and during owner startup. The current `ArchiveClientOptions.archiveId` alone must not authorize writable access; source-compatible raw calls without a fence either fail explicitly or use a separately named read-only API. Never silently resolve a stale queued mutation against whichever archive happens to be active when its worker finally starts.

Retained access is a narrow reader, not ordinary `ArchiveDatabase.open` with a boolean flag: no migration, workspace bootstrap, producer/job recovery, blob-verification writes, search initialization or write-capable dispatcher. Initially support bounded archived operation-status/record reads against compatible existing schema. If a hot journal or incompatible schema prevents truly read-only access, return recovery-required rather than silently running the ordinary constructor. Candidate summary can come from the source's retained job metadata without opening the candidate as a writable archive. Full candidate inspection, if later added, takes its owner lock per bounded read and must release it before activation.

Tests keep a distinct worker entrypoint and validated test-root prefixes for isolated writable archives. Do not expose `managed: false`, an arbitrary profile ID, or a test switch on the production worker protocol. Existing production-browser fixtures must migrate to managed sessions or the isolated test entrypoint. Existing proof-only `StorageProofClient` is already a separate route and must remain unable to address production namespaces.

An already-running **pre-fence worker binary** cannot be retroactively fenced by these new types. An old owner blocks the new owner lock, but an old follower could reacquire that lock after activation's source worker closes and resume unfenced writes. Holding a retired owner lock until tab close, sending a broadcast, changing the channel version, or observing locks once does not solve that lifecycle. Therefore deployment compatibility is a blocking acceptance gate: first deploy mandatory writer fencing with activation disabled; old contexts must be closed/restarted and unsupported cached binaries excluded before enabling replacement for a supported session cohort. Detectable legacy ownership/pending requests must block activation with an actionable reload/close message. A browser that cannot establish the required cohort must keep activation unavailable; native composition can enforce a full application/WebView restart. Coexistence with arbitrary old writer code would require a separate versioned-storage migration/isolation design, not an opt-in flag. This limitation must stay explicit until the old-worker fixture and host rollout protocol pass; cooperative Web Locks cannot certify unknown same-origin JavaScript.

Same-version active clients created before a switch are fully covered: their pinned revision becomes stale even if the selected archive later returns to the same ID. Mark them stale on a selection hint, reject new effects, preserve drafts and pending identities, and let dispatched requests resolve or report unknown outcome. Do not relabel every pending operation “not committed” merely because a selection event arrived.

### Proposed contracts and file changes

- New core `contracts/selection.ts`: serializable `ArchiveSelection`, full reviewed activation arguments/receipt/status, and a small `ArchiveSelectionClient` for host-local `read/status/subscribe/close`. Global receipt inspection must work even if the active archive database cannot open. Selection-operation status has its own domain; never treat an identically spelled canonical operation UUID in another archive as that receipt.
- Add archive-owner requests `readArchiveActivationContext` (matching selection plus actual source `max(sequence)`) and `activateRestoredArchive({operationId, expectedSelection, review})`. The latter hashes the **entire** normalized `ArchiveActivationReview`, including the complete candidate summary. Pair the existing `prepareArchiveActivation` result with the client's fixed selection; do not refresh only the selection revision behind the user's review.
- `archive-protocol.ts`: version the initialization/call envelopes, require access/fence fields at worker ingress and forwarded owner ingress, and define selection-change output. A mismatch uses `CONFLICT` with bounded current-selection details. Unreadable selection uses an explicit unavailable reason under a supported boundary error code, never a new empty default. The prototype's `UNAVAILABLE` is not currently in core `BoundaryError`; settle this mapping before wiring it.
- `client/archive.ts`: require a validated active selection for writable construction, preserve it for the client lifetime, and keep caller operation/transaction identities on unknown outcomes. Add the separate lightweight selection client and retained reader. Preserve existing queue/transfer admission. Neither constructor overloads nor direct imports may restore an unmanaged production writer.
- `worker/archive.ts`: use the startup guard before `ArchiveDatabase.open`; wrap normal `execute` and each maintenance slice once; special-route activation as described below. Foreground cancellations only signal active work and inspect already-safe outcomes; they must not synchronously wait for the active request's selection gate. Stop stale maintenance and close resources without a guard-reentry loop.
- `ArchiveDatabase`: expose a synchronous source high-water getter and a private activation barrier adapter; factor selected startup from retained inspection. Inject a shared initialized SQLite module into catalog/archive construction. The proof initially stalled when initializing a second module in the same worker; separate pools with one module passed. For existing selected namespaces, distinguish explicit first-run creation from missing/corrupt database files; do not call the current unconditional create path as recovery.
- Both host mains and shared app composition: open the managed session first, mount it with its actual archive/workspace, retain the old namespace on success, dispose controllers/readers and remount on verified selection change. A failed remount surfaces recovery rather than automatically selecting `default`.

### Activation composition without lock reentry

Do **not** call `selection.guard(() => selection.activate(...))`. Do not pass `archives.withActivationReview` as the prototype's `validateCandidate` hook: both implementations would acquire the same candidate owner lock, and the second `ifAvailable` acquisition would fail.

Propose a production private method `selection.activateReviewed(args, withReviewedCandidate)`. It owns only the global gate, persists/reconciles intent and checks replay before requiring an active source review. It supplies a nonexported, single-use `commitSelection()` callback. The existing `ArchiveRepository.withActivationReview` alone owns the candidate lock and invokes that callback after its exact persisted-token/source/candidate checks:

```ts
// Already executing in the selected source owner's foreground queue.
return selection.activateReviewed(args, async commitSelection => {
  await database.quiesceForActivation(); // private, no queue/gate reentry
  return database.archives.withActivationReview(
    args.review,
    signal,
    async () => commitSelection(), // one synchronous catalog SQL transaction
  );
});
```

`activateReviewed` handles existing committed receipt replay before the callback, so a lost reply can be recovered after the source is no longer selected; normal global receipt status does not open that source at all. The callback cannot escape or be reused, contains a final cancellation/head check, and updates selection plus receipt atomically without calling another public catalog method. Its receipt is authoritative even if source-job cleanup, notification or application remount later fails. Source review writes and selection writes remain separate lock-serialized transactions.

The existing owner loop has already awaited any idle slice before dequeuing activation; `quiesceForActivation` must not await its own `draining` promise. It can release the now-idle search resources under the old fence. Before review preparation, stop live generation work and let its canonical finalization finish; refuse final activation if any registered producer remains positively live. No producer is declared lost merely because selection or storage ownership changed.

### Plan boundary and missing production acceptance

Plan 09 enables one explicit **restore replacement** from a persisted ready job into a fresh validated candidate, retaining its predecessor. It does not add arbitrary profile selection, choosing any OPFS directory, switching browser profiles, switching workspace filters, or provider/model switching from plan 10. Reselecting a retained archive needs its own review/authorization and recovery contract; it must not abuse a released restore token. The prototype's switch-back scenario proves revision fencing only, not such a user feature.

Add production tests beyond the isolated fixture evidence: constructor/owner-start races before migrations; actual `commit`, many-part import publication and idle/explicit producer recovery; stale blob verification and cleanup; missing broadcasts; every direct-client/inspection/test mode; an actual pre-fence worker and the refused compatibility rollout; cancellation during full archive revalidation; no double candidate-lock acquisition; full-summary identity conflicts; restore activation with real persisted token/schema-8 candidate and source high-water/count gaps; lost commit reply plus failed UI remount; retained canonical outcome lookup after process restart; missing selected namespace/corrupt catalog without empty recreation; and actual web/native lifecycle qualification. Until those pass, keep activation unavailable and ADR 0012 Proposed.


### Isolated composition and legacy evidence

The extended [selection proof](../../packages/storage/src/selection/README.md) now exercises `activateReviewed` with exactly one externally owned candidate lock, synchronous single-use publication, callback expiry after return/throw, precommit cancellation (including an unrelated validator error), committed success despite postcommit cleanup/cancellation, and same-ID replay after later switches. The closure's lifetime ends in `finally`; a successful SQL receipt takes precedence over subsequent callback cleanup errors, while a precommit aborted signal keeps a cancellation outcome.

A separate real legacy-style worker intentionally omits selection checks. It reacquires the old owner lock after a managed switch and writes to that old SQLite fixture. This negative result demonstrates the rollout gap; it does not establish protection against pre-fence code. The unqualified-cohort test route refuses another activation without a pointer or intent write. It stays refused even with an empty current-source owner snapshot, rather than pretending that snapshot proves every older context closed. No qualified-cohort discovery or production activation was added.

### Qualified known-writer barrier: frozen production schema 8

The [frozen production worker proof](../../packages/storage/tests/selection/schema8/README.md)
narrows the preceding legacy gap for the actual current production implementation.
Unlike the direct-SQL negative fixture, this old worker always holds
`quixi:archive:<id>:owner` and calls `CanonicalRepository.migrate()` before any
canonical request or owner recovery. Its captured migration code rejects a
future ledger version rather than resetting or downgrading the archive.

An isolated test-only version-9 ledger marker now has actual Chromium and WebKit
evidence: an old active owner excludes the upgrader; a previously running old
waiter refuses after the committed marker; fresh old workers and complete browser
process restarts also refuse. Canonical records, sync operations and transaction
receipts remain exactly equal, with integrity `ok`, for source and candidate
namespaces. Explicit rollback and termination inside the marker transaction
instead recover schema 8, where old writers remain usable. The frozen bundle and
input hashes are retained independently of future production edits.

This supports a **conditional** rollout mechanism: mandatory newer canonical
schema for source/candidate, paired with a fenced new worker protocol. It is not
enough to add a schema row: old followers forward v1 calls without migration, so
new owners must reject those envelopes and must not serve their canonical writes
through a compatibility bridge. Already-open old owners must finish/release;
uncommitted upgrade intents are not barriers. Unknown earlier code and writers
without the same migration/owner-lock discipline remain outside the evidence.

No production migration 9 or activation was added. Candidate upgrades change
the reviewed schema/digest and require migration-aware restore validation and a
freshly bound final review, not reuse of a schema-8 summary. Selection and upgrade
transactions require explicit crash sequencing; an upgraded but unselected
archive is a recoverable state, never grounds for silent downgrade. Production
protocol/bootstrap, real restore activation and native acceptance remain required.
ADR status remains **Proposed**.
