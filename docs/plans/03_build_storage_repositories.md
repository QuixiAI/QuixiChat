# 03 — Build canonical storage repositories and blobs

**Status:** Complete — all tasks and acceptance criteria have linked SQL/browser evidence, including bounded blob orphan detection; additional platform and release-scale qualification stays with plans 01 and 24

**Workstream:** A2 — durable product storage

**Depends on:** [01](./01_prove_universal_storage.md), [02](./02_define_canonical_history.md)

## Outcome

Provide durable, bounded storage operations for history, attachments, imports, routing, and synchronization metadata through the universal StorageClient.

## Product references

- [10. Storage Worker](../product.md#10-storage-worker)
- [11. OPFS layout](../product.md#11-opfs-layout)
- [12. Multi-tab ownership](../product.md#12-multi-tab-ownership)
- [13. Storage UX](../product.md#13-storage-ux)
- [14. Persistence status](../product.md#14-persistence-status)
- [15. Storage quota UX](../product.md#15-storage-quota-ux)
- [21. Raw provider preservation](../product.md#21-raw-provider-preservation)
- [27. Import transactions](../product.md#27-import-transactions)
- [96. Synchronization operations](../product.md#96-synchronization-operations)
- [97. Derived data and sync](../product.md#97-derived-data-and-sync)
- [111. Storage stress tests](../product.md#111-storage-stress-tests)

## Tasks

- [x] Create ordered migrations for the agreed canonical model, provenance, attachments, document metadata, routing state, and sync operations. Keep derived search structures separately rebuildable. Plan 10's routing evolution is now settled for aliases and ordered profiles: versions 1/2 remain readable, and version 3's explicit primary, ordered fallbacks, requirements and alias attribution fit the existing schema-8 `ThreadState.routingProfile` field via `SetRoutingProfile`. The separate bounded local alias registry fits the existing local-state table. No new DDL is needed; canonical atomicity, rollback/replay, close/reopen, clean-copy exclusion of local aliases, and browser-process persistence are proven in [alias acceptance](../validation/routing-aliases.md) and [ADR 0018](../decisions/0018-local-preferences-and-routing-presets.md). Existing migration/schema-upgrade evidence remains below.
- [x] Implement repository operations and paginated reads behind the worker. Serialize writes and make canonical mutations plus their sync operations atomic.
- [x] Implement generation lifecycle persistence, including streaming checkpoints and terminal statuses. Define recovery of interrupted generations without treating partial output as a completed answer.
- [x] Implement content-addressed blob ingestion and bounded reads using the OPFS layout. Define staging, hash verification, metadata publication, missing references, cancellation cleanup, and orphan detection. The [blob acceptance](../validation/blob-storage.md) and current blob/client regressions cover verified staging/publication, bounded reads, rollback, interruption and quota recovery. [Bounded inventory validation](../validation/blob-inventory.md) closes orphan detection: a worker-owned read-only reference/catalog/OPFS scan protects retained transfers/imports, distinguishes missing/uncatalogued/wrong-size/unreferenced bytes, pages findings, cancels and invalidates stale scans. Eleven worker and seven actual app groups per browser engine preserve canonical/catalog/transfer/file fingerprints; 28 client checks per engine, 37/31 blob checks and 63 native startup/routing checks pass. [ADR 0024](../decisions/0024-bounded-blob-inventory.md) records scope and bounds. Full Quixi Doctor audits and cleanup remain plan 23 work.
- [x] Provide transactional import commit operations with stable-identity checks so deduplication remains correct when jobs overlap or retry.
- [x] Expose storage usage, quota estimates, persistence-grant state, change notifications, and typed failure results. Preserve worker ownership across every repository operation.
- [x] Exercise migration upgrades and failures using fixtures. Define the recovery/export path before shipping a migration that cannot safely complete. Injected upgrade failures, altered ledgers and schema-7/8 upgrades are exercised in the [canonical SQL suite](../../packages/storage/tests/canonical/repository.test.ts) and the [frozen schema-8 browser proof](../../packages/storage/tests/selection/schema8/README.md); [ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md) defines and implements the recovery path: typed startup outcome, byte-level rescue export, read-only history, and rescue restore at this build's schema. The schema-8 rescue candidate upgrade is also implemented under plan 09; broader restore/release gates remain there.

## Deliverables and interfaces

- Private repositories, migrations, blob management, and coordination implementations in packages/storage.
- Usable StorageClient operations for history, imports, attachments, routing metadata, and sync-op inspection.

## Acceptance criteria

- [x] Reloading or restarting retains canonical content, active branches, provenance, and attachment references. [Production client acceptance](../validation/archive-client.md) covers browser-process restart of canonical transactions and verified blob publication; the [shared application](../validation/shared-app.md) reopens the same archive with branches and committed content after a fresh browser process; the [import panel evidence](../../packages/importers/docs/validation.md) resumes across restart with raw source and attachment references retained.
- [x] Injected transaction failures never leave half a logical canonical mutation or a missing corresponding sync operation. [ADR 0006](../decisions/0006-canonical-persistence.md) records the SQL acceptance tests with rollback of injected failures and allocation denial; the [quota diagnostic](../../tests/diagnostics/QUOTA.md) shows an actual browser quota failure leaving the failed record absent with matching operation count and integrity `ok` after reopen.
- [x] Large collections are paginated/streamed; blob ingestion and reads remain bounded by configured working-set limits. The SQL suite pages 50,000-message deletions and imports; the [blob acceptance](../validation/blob-storage.md) bounds transfers and outstanding reads; the [scale scenario](../validation/shared-app.md#scale) keeps every view within its page budget over 2,001 conversations and a 2,000-message thread in both engines.
- [x] Quota exhaustion, interrupted blob writes, and interrupted generations are recoverable and visible to callers. The [production client suite](../validation/archive-client.md) and [blob acceptance](../validation/blob-storage.md) observe an actual Chromium quota failure as `QUOTA_EXCEEDED`, remove failed staging and publish again after quota is restored; interrupted staging becomes an interrupted transfer across restart; [ADR 0008](../decisions/0008-generation-producer-coordination.md) covers interrupted generations and producer loss. The shared application now words these boundary codes as actionable outcomes. WebKit quota injection remains unavailable.

## Boundaries and sequencing

The private [blob byte layer](../../packages/storage/src/worker/blobs.ts) now has
[actual Chromium/WebKit worker evidence](../validation/blob-storage.md) for bounded
transfers, integrity, deduplication, restart and failure handling. The private
canonical repository and BlobCatalog now also pass browser tests for atomic
reference/sync commits, rollback, replay after staging cleanup and process restart.
[ADR 0006](../decisions/0006-canonical-persistence.md) records the private SQL
repository's acceptance tests, including 50,000-message deletion, paginated
parts/sync operations, source-identity uniqueness and confirmed-producer-loss
recovery. `npm run test:storage:canonical` reproduces the SQL tests and
`npm run test:storage:blobs` reproduces the browser integration.

The production client/worker now has [actual browser acceptance](../validation/archive-client.md)
for follower-tab transactions and binary transfers, bounded admission, lost
replies, owner takeover, process restart and operation reconciliation.
`npm run test:storage:client` reproduces this evidence and a 1,001-part normalized
import with blob-backed text, hidden staging, owner revalidation, atomic
publication, cancellation and process restart. The SQL suite additionally tests
an arbitrary-order 50,000-message import and a 2,000-part message, including
allocation-denial rollback and overlapping identity fences. Independent producer
coordination now also passes actual browser owner/producer termination and
process-restart tests; see [ADR 0008](../decisions/0008-generation-producer-coordination.md).
The current regressions include actual Chromium quota failure/recovery; WebKit
quota injection is unavailable. The final [inventory slice](../validation/blob-inventory.md)
completes this plan's remaining task. Broader platform/release qualification
remains with plans 01 and 24.

[ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md) defines the
recovery/export path for a migration this build cannot complete: a typed startup
outcome view (implemented in both host entries and proven in the built web app
with denied storage), a byte-level rescue export through a retained-style
reader, restore validation of rescue archives, and read-only history at a
compatible ledger prefix. Fixture-level upgrade and injected-failure evidence
already exists in the canonical SQL suite and the frozen schema-8 browser proof.
The rescue export worker and client now pass the
[retained browser proof](../../packages/storage/tests/retained/README.md#rescue-export):
byte-exact database and blob copies for a compatible archive and for one with a
future ledger row, every refusal, unchanged file hashes, and an explicit restore
refusal. The startup outcome view now offers that export through host staging and the
host save flow, proven end-to-end in Chromium with a real archive that could
not be opened. Rescue restore now passes at this build's schema in the retained browser
proof, including the live default archive with its local state, and the
outcome view browses a compatible archive's history read-only through the
retained reader. Since 2026-09-09 a genuine schema-8 rescue archive restores
through plan 09's candidate upgrade. The remaining routing-state field
evolution (plan 10) is now closed by the compatible version-3
primary/profile snapshot and local alias registry in [alias acceptance](../validation/routing-aliases.md); no new SQL migration was needed. The same proof fixed first-run
initialization: an interrupted first run no longer leaves a namespace that
every later start refuses, while a namespace holding data is never replaced.

Only the Storage Worker opens SQLite. Archive formats belong to plan 09; search behavior belongs to plan 07. Include sync operation capture now, while remote synchronization remains deferred.

[Back to the roadmap](./README.md)

## Context exclusion compatibility regression — 2026-09-10

[ADR 0019](../decisions/0019-reviewed-context-compaction.md) introduces schema 11
and archive protocol 3 for immutable reviewed attachment exclusions. The ledger
gate refuses old writers; the transport gate also isolates old followers.
[Acceptance](../validation/context-compaction.md) records canonical upgrade/replay,
exact policy/event/original-attachment portable roundtrip in Chromium/WebKit,
current activation/protocol and extraction/retained-recovery regressions.
The schema-8 restore fixture stays separate from the new policy fixture.
Native and cross-host release gates remain open; this completes no whole plan.

## Reviewed summary compatibility — 2026-09-10

[ADR 0020](../decisions/0020-reviewed-summary-proposals.md) adds schema 12 / archive
protocol 4 for typed SummaryProposal provenance and reviewed prefix policies.
[Acceptance](../validation/context-summaries.md) records source/revision/digest
validation, complete-text eligibility, required atomic apply/clear audit events,
replay/rollback/reopen, schema-10/11 upgrade and older-client refusal. The real
portable snapshot proof preserves a summary generation, proposal, verified frozen
input, edited reviewed text, exclusions, canonical edges and journal exactly in
both browser engines; its schema-8 fixture remains separate. Retained recovery,
activation and affected search/extraction regressions pass. Native/cross-host
and release-scale gates remain open; no whole plan is closed.


## Blob inventory completion — 2026-09-10

[Current validation](../validation/blob-inventory.md) closes the final open blob
orphan-detection task with real SQL/OPFS and production UI evidence. Temporary
scan bookkeeping stays file-backed with bounded work/cache and adds no persistent
schema or archive protocol. No cleanup or repair action is implied. Every task
and acceptance criterion above is now checked; the broader goal remains open.
