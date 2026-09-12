# Exact conversation search navigation

The public `resolveConversationSearchHit` operation takes
`{chunkId, threadId, messageId, partId}` and returns those canonical IDs plus the
validated current `ChunkPosition`. `partId` is nullable in the request shape for
explicit handling of metadata-only hits, but the current index emits only
part-backed conversation sources. A null-part request therefore refuses with
`CONFLICT`; it never guesses the first part.

The worker uses the existing `(epoch, chunk_id)` index with a two-row ambiguity
bound, exact active head/run matching, ownership predicates and visibility
revisions. It reconstructs the stored chunk hash from bounded digest, version,
context and position metadata, including code classification. It independently
resolves the selected canonical part and its bounded metadata, checks hidden
thread/branch ancestry in SQL, and compares the authoritative text/blob digest,
context and position path. It does not load whole histories, original blobs,
image pixels, chunk text, PDF pages or optional extraction tables.

For image filename hits, `sectionPath` is exactly
`['attachment', attachmentId, 'filename']`, and offsets address the canonical
filename. Descriptions retain `['data','description']`; structured canonical JSON
retains its existing path. Equal string length cannot validate an old hit:
a same-length renamed filename has a different digest and is refused. Exact
unchanged chunks may legitimately resolve again after a deterministic rebuild.

The UI must use this operation before reading/focusing the exact part and must
compare its returned binding with the selected hit. It must not reconstruct
chunk identities, apply filename offsets to descriptions or search for another
part after refusal. Exact app navigation/browser acceptance is owned separately.
This package supplies the public route and its private SQLite acceptance.

```sh
npx tsc --noEmit -p packages/storage/tests/conversation-search-navigation/tsconfig.json
node packages/storage/tests/conversation-search-navigation/run.mjs
```

Seven real pinned-SQLite/FTS tests cover:

- Unicode/NUL filename and description positions, exact public-envelope
  validation, indexed lookup, no navigation writes and no extraction-table joins.
- Equal-length filename rename rejection before and after reindexing.
- Independent canonical digest validation with deliberately suppressed dirty
  triggers and an otherwise still-visible obsolete filename head.
- Ownership mismatch, malformed IDs, null-part refusal and corrupt positions.
- Tombstone refusal even when test-only trigger suppression preserves old heads.
- Deterministic rebuild, explicit derived repair/clear, and missing extraction
  schema while conversation navigation remains usable.
- Code-classified text and structured JSON source addressing.

The fixtures verify the pinned SQLite WASM hash and use real repositories. Image
records are metadata fixtures; no image decoding, OPFS or browser claim is made.
Deliberately suppressed triggers occur only in corruption tests. Ordinary canonical
operations still maintain their normal visibility revisions. No schema migration
or new index is needed by this resolver.
