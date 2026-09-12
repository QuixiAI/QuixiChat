# ADR 0041: Reviewed cleanup of unreferenced stored files

**Status:** Accepted, 2026-09-12
**Plans:** [23](../plans/23_build_diagnostics_and_recovery.md)
**Product:** §101 Quixi Doctor (find orphan blobs), §21 Raw provider preservation
**Related:** [ADR 0024](./0024-bounded-blob-inventory.md) (bounded inventory), [ADR 0040](./0040-diagnostics-outcomes.md)

## Context

The blob inventory reports unreferenced stored files but plan 23 forbids
destructive cleanup that the user has not inspected: findings must be shown
first and deletion must require explicit selection. Nothing in Quixi deletes
canonical history; the only bytes without a canonical owner are these files.

## Decision

1. **Deletion is bound to a reviewed scan.** `deleteOrphanBlobs` takes the
   scan identity and up to thirty-two digests. Each digest must be an
   `orphan_blob` finding of that scan, the scan must still be `complete`
   (not stale, cancelled or replaced), and the scan's own reference scratch
   must still show zero references and zero protection for the digest. Any
   other digest is refused by name (`not_a_finding`, `referenced`,
   `protected`, `in_use`, `missing`, `stale`); refusals never abort the
   request, so the result names every outcome.
2. **Only the file and an unreferenced catalog row go.** The blob store
   removes the published file (refusing while a verified read holds it); a
   catalog row for the digest is removed only when the scan recorded no
   reference to it. No canonical row, sync operation, transfer row or import
   record is touched.
3. **The scan reads stale afterwards.** Deleting changes the file and
   catalog epochs; the result carries the stale status with a message
   naming the count, and the panel asks for a new scan before further
   cleanup. Later digests within the same request are still judged by the
   scan that was current when the request began.
4. **The interface separates selection, review and confirmation.** Each
   orphan finding carries a checkbox; a review step lists the selected
   digests with their total size and states that deletion is permanent;
   confirmation is a separate danger-styled button beside "Keep the files".
   A new or stale scan clears the selection.
5. **Verification-only catalog updates do not invalidate scans.** Background
   lexical indexing marks catalog rows verified after reading text blobs.
   The inventory's and the hash audit's staleness triggers now ignore
   catalog updates that change neither digest nor size, because findings
   depend only on those fields; the stale message names what changed.

## Consequences

- Cleanup cannot remove a file that any saved record, transfer or import
  still needs, even if the user selects it, because the worker re-checks at
  deletion time against the scan that produced the finding.
- A user who wants to remove many orphans runs several reviewed rounds of
  at most thirty-two files; this is deliberate.
- Physical orphans without a catalog row and registered orphans with one are
  both eligible; the result says whether a catalog row was removed.
