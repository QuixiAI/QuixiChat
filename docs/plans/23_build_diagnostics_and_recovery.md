# 23 — Build diagnostics and archive recovery tools

**Status:** In progress — the §100 diagnostics report with a fixed outcome vocabulary, the bounded read-only blob inventory, the shared Storage health UI, the distinct FTS/semantic repair actions, the inference self-test, the exportable report and the branch/provenance/sync Doctor audit are implemented; the blob-hash audit and reviewed cleanup remain open

**Workstream:** Product reliability — Quixi Doctor

**Depends on:** [03](./03_build_storage_repositories.md), [09](./09_add_archives_and_open_export.md)

## Outcome

Give users and developers inspectable storage health and narrowly targeted recovery actions that preserve the authoritative local archive.

## Product references

- [12. Multi-tab ownership](../product.md#12-multi-tab-ownership)
- [14. Persistence status](../product.md#14-persistence-status)
- [21. Raw provider preservation](../product.md#21-raw-provider-preservation)
- [26. Import provenance](../product.md#26-import-provenance)
- [96. Synchronization operations](../product.md#96-synchronization-operations)
- [98. Archive export](../product.md#98-archive-export)
- [99. Open export](../product.md#99-open-export)
- [100. Diagnostics](../product.md#100-diagnostics)
- [101. Quixi Doctor](../product.md#101-quixi-doctor)
- [111. Storage stress tests](../product.md#111-storage-stress-tests)

## Tasks

- [x] Implement a diagnostics report covering SQLite integrity/schema, OPFS persistence, FTS5/sqlite-vec availability, attachment references, and storage ownership. `diagnosticsReport` classifies every check as ok, corruption, unsupported, missing data, rebuildable, attention or unknown ([ADR 0040](../decisions/0040-diagnostics-outcomes.md), [validation](../validation/diagnostics.md): 12 Node classification tests on real SQLite WASM, 12 application checks per engine). The attachment-reference check is bounded (newest 4,096 records, 64 file probes) and defers to the storage scan; the report is operational metadata only.
- [ ] Implement Quixi Doctor checks for blob hashes, missing/orphan blobs, branch invariants, import provenance, and atomic sync-op coverage. Missing/orphan detection and metadata/size mismatch findings are implemented with protected transfer/import data, malformed-reference refusal and exact preservation evidence ([validation](../validation/blob-inventory.md), [ADR 0024](../decisions/0024-bounded-blob-inventory.md)). Since 2026-09-12 the Doctor audit (`beginDoctorAudit`…`cancelDoctorAudit`) validates branches (parent, cross-thread, self-reference, part counts and order, generation links, edit origins, selected leaf, context snapshot and chain, thread state), import provenance (import sources, provenance targets, raw objects, source identities) and sync coverage (every recorded operation's affected records) in one bounded, cancellable, stale-aware scan with sixteen finding kinds and managed identifiers only ([validation](../validation/diagnostics.md): 4 Node tests with planted damage, both engines in the storage-health proof). Only the blob-hash audit (reading every stored file's bytes) remains open.
- [x] Expose rebuild FTS and derived semantic-index delete/rebuild as distinct actions. Keep canonical-content repair separate from safe derived-data recreation. Storage health now offers Rebuild search index, Delete semantic index and Rebuild semantic index as three buttons under a statement of what they never change; the FTS rebuild repairs a failed derived index in both engines with canonical rows, operations, catalog, transfers and file bytes fingerprinted unchanged ([validation](../validation/diagnostics.md)). No canonical-content repair exists.
- [ ] Implement bounded scans with progress, cancellation, and resumable work where appropriate. Report findings before destructive cleanup and require explicit selection for deleting orphan blobs. The blob inventory and the Doctor audit run in capped worker slices (64 rows per advance), have bounded findings pages (32 items, 16 KiB), progress/Stop and explicit new scans after stale inputs or owner loss; they preserve partial results without inventing a resumable OPFS iterator. Both panels share one scan controller. Explicitly reviewed cleanup remains open; no deletion operation is exposed ([validation](../validation/blob-inventory.md), [diagnostics](../validation/diagnostics.md)).
- [ ] Use archive export/restore as the recovery foundation. Define what remains accessible when schema initialization, a migration, or a derived index fails. [ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md) records the schema-failure answer (exact bytes via rescue export; bounded read-only history at a compatible prefix); derived-index failure never blocks startup because search data is rebuildable.
- [x] Add QuixiEmbed diagnostics when that runtime is installed: model hash, tokenizer/reference self-test, scalar/SIMD parity, and available WebGPU routes. `EmbeddingService.selfTest()` re-hashes the model, runs three frozen golden cases through the tokenizer, the scalar and SIMD backends and the live WebGPU route, and probes WebGPU otherwise; Storage health runs it as "Run inference self-test" ([ADR 0040](../decisions/0040-diagnostics-outcomes.md) amendment 1, [validation](../validation/diagnostics.md): 7 Node classification tests, both engines in the semantic proof). It loads the runtime when needed and is absent on hosts without the model.
- [x] Provide an exportable diagnostic report that excludes credentials and defaults to operational metadata rather than raw conversation text. Storage health's "Save diagnostics report" writes the storage report and the inference self-test as one JSON file built from an allow-list of fields (long strings clipped, unknown fields dropped, absent sections named with a reason) through the host's verified `file_save` staging and save flow ([validation](../validation/diagnostics.md): 3 Node tests, both engines in the storage-health and semantic proofs). Credentials never reach the application (they stay behind the host secret boundary), so the file cannot carry them; conversation text is excluded by construction.
- [ ] Create corruption/fault fixtures and verify every repair/rebuild operation against canonical record and blob inventories.

## Deliverables and interfaces

- Diagnostics UI/API, Quixi Doctor operations, and bounded integrity/recovery tooling.
- Corruption fixtures and documented recovery procedures for supported failure classes.

## Acceptance criteria

- [x] Detected corruption is distinguished from unsupported capability, missing data, and a rebuildable derived index. One report on the fixture archive names SQLite corruption (unreferenced pages), missing data (a deleted file and a deleted catalog row) and, after a ledger fault, a rebuildable derived index, each on its own check; unsupported capabilities are classified from stated inputs because every host in the matrix has FTS5, sqlite-vec and the tokenizer ([validation](../validation/diagnostics.md)).
- [x] FTS/semantic rebuilds preserve canonical rows, provenance, branches, and attachment bytes. The FTS rebuild (repair path) and the semantic delete run in both engines with the canonical record table (which holds provenance and branches), sync and blob operations, catalog, transfers and every stored file byte fingerprinted equal to the baseline; the semantic rebuild's storage effect is the same delete followed by enrolment and re-embedding, exercised by the [semantic proof](../validation/semantic-search.md).
- [ ] Users can inspect the scope of cleanup before any canonical/blob deletion occurs.
- [x] Diagnostic exports contain no provider secrets or unsolicited history content. The saved file's bytes are checked in both engines against the fixture's private names, original content and filenames (storage-health proof) and against the seeded conversation text (semantic proof); the builder's allow-list drops any field outside the two reports and the Node test proves a planted secret-looking field and planted payload text never reach the bytes ([validation](../validation/diagnostics.md)).

## Diagnostics report and repair actions — 2026-09-12

The Storage health view gained a Diagnostics section: Run diagnostics asks
the storage owner for a `diagnosticsReport` covering the nine §100 storage
checks, each with a fixed outcome and a plain summary, and three repair
actions (Rebuild search index, Delete semantic index, Rebuild semantic
index). [ADR 0040](../decisions/0040-diagnostics-outcomes.md) fixes the
outcome vocabulary and the metadata-only content policy;
[diagnostics.md](../validation/diagnostics.md) records the Node and
two-engine evidence, including real corruption, missing-data and
derived-failure fixtures on the blob-inventory archive. The inference
self-test, the exportable report and the branch/provenance/sync-coverage
Doctor audit followed the same day. Still open: the blob-hash audit, fault
fixtures for every repair, and reviewed cleanup.

## Pending mutation recovery increment — 2026-09-10

The shared application now retains unknown-outcome recovery independently of
ordinary errors and navigation. The [pending-recovery proof](../validation/pending-recovery.md)
passes 60 groups per browser engine, 127 unit tests and `npm run check`.
The original immutable transaction is retried once for concurrent callers;
previous-archive reconciliation remains bound to its operation IDs. Newer
navigation and ordinary errors survive late completion, and post-acknowledgement
read failures do not revive an unknown write. This closes the specific live-session
navigation/search gap; the Doctor audits, derived-index rebuilds, diagnostic
export and broader recovery criteria above remain open. No reload-persistent
client pending-intent journal is claimed.

## Boundaries and sequencing

This can be implemented for core storage before semantic integration. Add inference-specific checks with plans 18–21; their absence must not prevent storage diagnosis. Recovery must not become a hidden alternative persistence backend.

[Back to the roadmap](./README.md)
