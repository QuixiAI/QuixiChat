# 23 — Build diagnostics and archive recovery tools

**Status:** In progress — bounded read-only blob inventory and shared Storage health UI are implemented; broader audits, diagnostic export and reviewed repair remain open

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

- [ ] Implement a diagnostics report covering SQLite integrity/schema, OPFS persistence, FTS5/sqlite-vec availability, attachment references, and storage ownership.
- [ ] Implement Quixi Doctor checks for blob hashes, missing/orphan blobs, branch invariants, import provenance, and atomic sync-op coverage. Missing/orphan detection and metadata/size mismatch findings are now implemented with protected transfer/import data, malformed-reference refusal and exact preservation evidence ([validation](../validation/blob-inventory.md), [ADR 0024](../decisions/0024-bounded-blob-inventory.md)). Full hash, branch, import-provenance and sync-coverage audits remain open.
- [ ] Expose rebuild FTS and derived semantic-index delete/rebuild as distinct actions. Keep canonical-content repair separate from safe derived-data recreation.
- [ ] Implement bounded scans with progress, cancellation, and resumable work where appropriate. Report findings before destructive cleanup and require explicit selection for deleting orphan blobs. The blob inventory now runs in capped worker slices, has bounded findings pages, progress/Stop and explicit new scans after stale inputs or owner loss; it preserves partial results without inventing a resumable OPFS iterator. The shared panel is keyboard and narrow-layout qualified in both engines. Other audit scans and explicitly reviewed cleanup remain open; no deletion operation is exposed ([validation](../validation/blob-inventory.md)).
- [ ] Use archive export/restore as the recovery foundation. Define what remains accessible when schema initialization, a migration, or a derived index fails. [ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md) records the schema-failure answer (exact bytes via rescue export; bounded read-only history at a compatible prefix); derived-index failure never blocks startup because search data is rebuildable.
- [ ] Add QuixiEmbed diagnostics when that runtime is installed: model hash, tokenizer/reference self-test, scalar/SIMD parity, and available WebGPU routes.
- [ ] Provide an exportable diagnostic report that excludes credentials and defaults to operational metadata rather than raw conversation text.
- [ ] Create corruption/fault fixtures and verify every repair/rebuild operation against canonical record and blob inventories.

## Deliverables and interfaces

- Diagnostics UI/API, Quixi Doctor operations, and bounded integrity/recovery tooling.
- Corruption fixtures and documented recovery procedures for supported failure classes.

## Acceptance criteria

- [ ] Detected corruption is distinguished from unsupported capability, missing data, and a rebuildable derived index.
- [ ] FTS/semantic rebuilds preserve canonical rows, provenance, branches, and attachment bytes.
- [ ] Users can inspect the scope of cleanup before any canonical/blob deletion occurs.
- [ ] Diagnostic exports contain no provider secrets or unsolicited history content.

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
