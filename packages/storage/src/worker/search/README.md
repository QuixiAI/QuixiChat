# Published PDF sources in shared lexical search

Construct `SearchRepository(db, blobs, { publishedSources: extraction.publishedSources })`
using the same owner database and serial queue for both repositories. The adapter
is optional; existing canonical and legacy extraction sources remain supported.
See the [persistence proposal](../../../../documents/docs/persistence-contract-proposal.md)
and product [PDF memory rules](../../../../../docs/product.md#85-pdf-memory-rule).

The private integration methods are:

- `drainExtractionPublications(limit = 32): number`: consume at most 32 durable
  notifications. Search scope/queue writes and extraction ACKs share one SQLite
  transaction. `page` dirties only `e:<pageAttemptId>`; `replace` or `clear` dirties
  that document once per notification. An unsuccessful transaction preserves both
  outbox and prior search scopes. SQLite's original error survives automatic rollback.
- `advanceExtractionIndex(signal?): Promise<void>`: one bounded
  indexing slice capped at four shared chunk writes and one bounded outbox batch.
  It does not calculate global summaries or run archive-wide obsolete scans;
  the caller checks exact page credit separately. Ordinary `advance` retains
  cleanup/progress summaries; `status` polls at most one pending event to wake
  maintenance. See the [measured comparison](../../../tests/search-performance/README.md).
- `isExtractionPageIndexed(ref): boolean`: the page-specific producer credit
  barrier. It requires the complete current page reference and a visible head in
  the active search epoch. Empty/scanned pages can have a complete head with zero
  chunks. Overall index readiness alone does not grant this credit.

A published page is one verified text source of at most 262,144 UTF-16 units.
All staging fragments pass through the same `StructuralChunker` state; source
positions remain page-local UTF-16 offsets, including Unicode and embedded NUL.
Search does not copy source maps or own extraction checkpoints. PDF sources never
use the legacy 65,536-unit `registerExtractedText` event path. Canonical text/blob
sources continue using their existing bounded readers.

`quixi_search_page_refs` records the page/run identity associated with each FTS
head. Both held work and visible-head queries fence page/run, source digest,
publication revision and exact canonical attachment ID/SHA/byte length. These
checks apply before outbox drain and during rebuild. Search cursors also bind the
independent extraction revision, so delayed outbox writes cannot conceal a changed
result set. New page publication leaves
prior page heads usable; replacement immediately hides the previous run. Stale
heads and references are removed in bounded cleanup slices. Global/document
expansion fetches at most 32 canonical keys and 32 published page keys, merges at
most 64 metadata rows and queues the first 32; it never materializes a document,
all its maps or all its chunks in JavaScript.

Extraction schema readiness is checked separately. SQL mentioning extraction
objects is constructed only after exact schema/ledger verification; unavailable
objects produce a predicate that excludes `e:` sources and has no extraction-table
joins. Canonical/conversation search and rebuild remain usable. A text digest error
while loading a page quarantines that document's extracted search heads, while its
independent retained extraction records remain available for explicit recovery.
Metadata fences do not claim continuous hashing of every already-indexed text/map
byte; page text is verified when loaded, and map reads retain the extraction
repository's own digest checks.

Search repair drops only `quixi_search_*`. It preserves `quixi_extract_*` pages,
maps, runs, checkpoints and operation receipts. No canonical trigger references
an extraction table. The new search-owned reference table changes the derived
schema checksum; an older derived index uses the existing explicit search repair
path, without a canonical migration. If adapter publication reads fail, extraction
sources are suppressed for that repository instance; reopening after explicit
extraction repair obtains fresh readiness. Search neither repairs extraction
records nor treats absent/corrupt extraction as permission to recreate originals.

[Acceptance](../../../tests/extraction-search/README.md) covers the real pinned
SQLite WASM repositories. Public dispatcher, original-source lease, PDF worker
backpressure and browser/app integration belong to the owner composition.

## Exact document search navigation

`resolveDocumentHit({chunkId, documentId})` implements the public
`resolveDocumentSearchHit` contract. A lowercase SHA-256 chunk ID and UUID document
ID select at most two candidates through `quixi_search_chunk_lookup(epoch,chunk_id)`;
only one current active-epoch/head match is accepted. The resolver reconstructs the
shared structural/code-classification ID from bounded metadata, validates the
canonical attachment and checks the exact published page reference/current source.
It never loads a page's text, maps or original blob. Published `e:` results return
that pageRef with the exact ChunkPosition; plain `d:` results return null pageRef
for attachment overview. Legacy `x:` registrations have no durable page/map
identity and are refused by this exact resolver.

Clear, changed replacement or source identity changes invalidate old hits before
outbox drain. An unchanged deterministic chunk may legitimately resolve after a
rebuild. Missing/unavailable extraction schema suppresses extracted lookup without
SQL joins to its tables; other source search remains usable. The new lookup index
changes only the derived schema checksum and uses the existing explicit search
repair path for an older index. [Navigation acceptance](../../../tests/search-navigation/README.md)
records the pinned-WASM evidence; public routing and UI composition are separate.

## Image filename sources

Product §91 filename search uses a separate `f:<Image part ID>` source, alongside
the unchanged `p:` description source. The filename source reads canonical
attachment metadata, never pixels, and remains available when bytes are missing.
Its message/part IDs identify the containing image; its position path is
`['attachment', attachmentId, 'filename']` and its UTF-16 offsets address that exact
filename field. They must not be applied to `data.description`.

Image writes enqueue both bounded source identities; attachment metadata changes
invalidate them through the existing global revision fence. New trigger statements
change only the repairable search schema checksum. See the
[actual SQLite acceptance and navigation limits](../../../tests/image-search/README.md).

## Exact conversation navigation

`resolveConversationHit({chunkId,threadId,messageId,partId})` backs public
`resolveConversationSearchHit`. It locates an exact active-epoch chunk/head through
the existing chunk index, validates its hash and ownership, and independently
checks its bounded canonical source, including tombstones and the current filename
digest. It returns the authoritative position rather than trusting captured offsets
or equal filename length. There are currently no null-part conversation metadata
sources; such requests refuse without falling back to another part. This path has
no extraction-table or blob-reading dependency. See the
[pinned SQLite evidence](../../../tests/conversation-search-navigation/README.md).
