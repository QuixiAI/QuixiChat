# ADR 0029 — Incremental blob verification for lexical indexing

Date: 2026-09-10. Status: accepted; qualification is recorded in
[incremental verification](../validation/incremental-search-verification.md).

## Decision

Lexical indexing shares one 128 KiB admission budget between initial blob
verification and later source decoding. Opening a verification cursor reserves
the file without hashing it. Each advance hashes at most its explicit byte
allowance and returns to the storage owner; the cursor remains private to that
owner between turns. Existing chunk-count and queue-step bounds still apply.

The byte store keeps one shared file and hash state per digest. Pending readers
count toward the existing eight-transfer limit but cannot read bytes or create
ranges. Only a completed SHA-256 and unchanged length authorize normal reads.
The catalog rechecks metadata and marks current-owner verification only after
completion. These are private byte/catalog methods, not a new wire operation or
a new persistent schema.

A foreground full read can finish the same pending hash using the held file.
The next indexing turn observes completion without reopening an exclusive OPFS
handle. Indexing charges its whole requested verification allowance even if a
foreground reader has already completed the hash, so progress jumps cannot be
mistaken for unbounded maintenance work. Chunking begins only after verification;
the existing complete-source publication fence remains in place.

Cancellation releases its cursor without quarantining valid content or closing
other readers. Corrupt bytes invalidate all readers of that file and retire
sibling catalog cursors. Publication independently verifies a pending shared
file and does not repair it underneath a live hash. Closing the owner destroys
hash state and handles. After restart, the durable derived queue remains but
verification starts at zero; serialized hash internals are never durable trust.

Search progress reports the verified byte offset while verifying and the decoded
byte offset while chunking. Source identity/revision is rechecked across awaits
and between turns. Changes discard obsolete work; no unverified prefix is
published as searchable content. Canonical history and sync operations remain
unchanged by verification, cancellation, rebuild or restart.

## Limits

The budget bounds hashing and decoding work, not the wall-clock latency of an
individual filesystem call. General foreground blob reads still finish their
verification before returning a readable transfer. This increment does not
claim release-corpus relevance, cross-host performance qualification, or a
semantic index. Those remain separate plan-07/21/24 gates.
