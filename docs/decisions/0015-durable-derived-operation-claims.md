# 0015 — Preserve operation identity independently of repairable data

Status: accepted and implemented for local extraction; OCR and Cloud remain deferred.

## Requirement

[Plan 03](../plans/03_build_storage_repositories.md),
[plan 09](../plans/09_add_archives_and_open_export.md) and
[plan 14](../plans/14_extract_and_search_documents.md) require recoverable writes,
portable canonical history and rebuildable derived text/search. Product
[10](../product.md#10-storage-worker), [27](../product.md#27-import-transactions)
and [97](../product.md#97-derived-data-and-sync) keep those responsibilities in the
same Storage Worker without making derived data canonical.

An extraction receipt alone cannot reserve a UUID after its derived repository
is cleared or repaired. Reusing that UUID for canonical history, another local
journal or a new extraction would make a lost reply ambiguous.

## Decision

Canonical migration 10 adds an immutable local operation-claim registry. Its
bounded row holds the UUID, domain, complete request digest and a versioned hash
of those fields. Claim, extraction effect and original receipt commit in the
same actual SQLite transaction. The registry checks SQLite autocommit state;
external callbacks, separate transactions and request-time schema creation are
not substitutes for that atomicity.

Existing matching extraction receipts return before claiming. If a durable
claim exists but its receipt is unavailable, the outcome is `UNKNOWN_OUTCOME`;
the caller retains the original UUID and request. A changed request or another
domain fails `CONFLICT`. Read-only retained-history status follows the same rule
without migration, schema creation or repair.

Reciprocal SQL guards cover canonical sync, import controls and reservations,
blob controls, importer work and archive jobs. Stable canonical triggers never
reference extraction or search tables. Archive-specific guards are installed
only during owner setup after its private journal exists. Derived repair does
not remove local claims.

These rows are local protocol metadata. The existing logical snapshot whitelist
excludes them; a fresh schema-10 portable database contains an empty registry.
Restore validation rejects a nonempty registry even when its executable schema
is otherwise approved. Portable archives therefore cannot introduce unrelated
local operation reservations.

Public read/slice blob transfer IDs are their caller's request UUID. This makes
allocation cleanup possible when a creation reply is lost. A pinned PDF reader
releases those known IDs, keeps at most four 64 KiB ranges active and never
retargets or silently closes a shared client.

## Evidence and limits

[21 pinned-WASM checks](../../packages/storage/tests/operation-claims/README.md)
cover both journal insertion orders, immutable rows, real rollback/SQLite FULL,
9→10 migration, receipt loss, derived repair, clean snapshot copy and read-only
portable rejection. [Public browser acceptance](../../packages/storage/tests/extraction-browser/README.md)
covers actual managed clients, OPFS, lost replies, owner takeover and process
restart. [The PDF persistence proof](../../packages/documents/tests/persistence-browser/README.md)
composes the real parser, original-source lease, page journal and shared FTS.

This decision does not complete plan 14's UI, parser peak-memory or release-scale
gates. The durable registry is deliberately not garbage-collected with derived
receipts; physical growth and lifecycle qualification remain part of plan 24.
Known older writers reject schema 10 through the existing migration ledger;
older portable-format import remains a separate compatibility task.
