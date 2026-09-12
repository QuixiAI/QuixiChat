# 0007 — Shared chunks and a recoverable lexical index

Status: accepted for the lexical foundation; subsequent UI/document evidence is linked in plan 07, while release-scale and dependent capability gates remain open.

## Product contract

This implements the shared source model in [SearchChunk](../product.md#47-searchchunk), [message chunking](../product.md#48-message-chunking), [document chunking](../product.md#49-document-chunking), and [chunking strategy](../product.md#50-chunking-strategy). [Exact and Best](../product.md#44-search-modes) work without inference. [Filters](../product.md#45-search-filters) and [result navigation](../product.md#46-search-result-ux) consume canonical identities and source positions.

## Ownership and source accuracy

`packages/search/src/chunker.ts` is the single structural chunker for conversation parts, UTF-8 document bodies, and registered extracted page text. It accepts bounded fragments, prefers heading/paragraph/list/code/sentence boundaries, and uses overlap only for forced splits. The default 4096 UTF-16 unit window and 64-unit overlap are lexical memory bounds, not a frozen semantic token policy. The optional tokenizer supplies offsets over the complete window without loading inference weights. Its version and token budget participate in the chunking version.

Chunk identity includes source kind, source/part ID, content digest, chunker policy, source offsets, page, section path, and context prefix. Identical passages on different PDF pages therefore retain distinct navigation identities. Positions address UTF-16 units in authoritative text; JSON projections explicitly identify their canonical JSON path. Text and source bytes remain canonical; every search table is disposable derived state.

Text/Note bodies, supported summaries/descriptions, structured canonical JSON, and tool output enter this pipeline. Raw provider artifacts remain provenance rather than ordinary search text. Document bodies currently support UTF-8 text, JSON and XML. The private extracted-text registration hook fences page text by current attachment digest and bounds a registration at 65536 UTF-16 units. It proves shared chunking of extracted text, not PDF parsing or extraction quality; those belong to plan14. OCR belongs to plan15.

## Private SQLite layout and visibility

Only `packages/storage/src/worker/search/` knows the derived SQL. `quixi_search_schema` tracks its checksum separately from canonical migrations. Constant-work canonical-record triggers advance source/message/thread/document/global revision scopes and enqueue dirty scope IDs. Scope expansion proceeds in batches of 32 source IDs. Updating a generation's usage/status or a message's part count does not invalidate its already committed text parts.

Chunks are written under a private build run and become queryable only when a complete source head is published against unchanged scope revisions. A title/tag edit, append, attachment/provenance change or tombstone makes the previous head invisible immediately. A held source detects revision changes before publication and restarts. Owner loss restarts incomplete work; no partial source becomes a visible head.

Ordinary rebuild creates a new epoch while the previous valid epoch remains searchable. Successful completion swaps epochs; obsolete rows are removed in bounded maintenance. A failed rebuild preserves the previous epoch and exposes the failed source/reason. Explicit retry can requeue repaired sources. Abandoned runs are cleaned before another attempt begins, preventing repeated foreground interruptions from accumulating unbounded partial chunks.

FTS5 uses external content with paired insert/delete triggers. Ranking orders SQLite BM25 ascending, then row ID, and returns the negated score to clients. SQLite documents these score and external-content maintenance rules in its [FTS5 reference](https://www.sqlite.org/fts5.html#the_bm25_function) and [external-content guidance](https://www.sqlite.org/fts5.html#external_content_tables).

## Bounded work and foreground priority

The archive owner serializes search with foreground canonical access and admits short idle maintenance slices. Since 2026-09-09 a drain that processed foreground calls schedules maintenance, including the next indexing slice, on a 50 ms idle timer instead of running it inline; a view load that issues many sequential bounded reads no longer pays one slice per read. In the plan 08 scale scenario this took opening a 2,000-message conversation during background indexing from about 2.3 s to about 0.2 s, and paging older messages from about 2.3 s to under 0.15 s, while indexing throughput stayed at roughly a dozen short sources per second. Each slice writes at most `maxChunks` (1–128), shares at most 128 KiB of work between initial verification and subsequent source-byte decoding, and performs at most 64 orchestration steps. A source retains one verified blob reader; acknowledged child ranges are at most 64 KiB. The shared blob catalog supplies byte integrity and range leases.

[ADR 0029](0029-incremental-search-blob-verification.md) supersedes the original whole-file `openRead` indexing admission. Initial verification now retains an owner-local hash cursor and advances at most 128 KiB per admission, reporting its verified offset through `activeSource.phase = verifying`. No bytes reach chunking before the complete digest matches. The cap bounds byte work, not the wall-clock latency of individual filesystem calls. Blob admission pressure (`OVERLOADED`) and cancellation leave work retryable, without recording permanent source failure. Foreground byte admission aborts/awaits background work, then calls `yieldResources()`; this releases the held reader and leaves the source queued. Frequent interruptions may delay completion, but partial disk usage stays bounded by cleanup before retry.

## Query behavior and recovery

Queries accept at most 4096 characters and 64 terms/quoted phrases. FTS operators and column selectors are treated as literal user text. Exact uses lexical matching; Best reports `best_lexical`. Provider/model, date, source kind, tags, thread/document ID, normalized media type, origin and code-presence filters are applied before paging. Portability, OCR-source and Semantic requests return explicit dependency reasons for plans10, 15 and21.

Pages enforce the caller's JSON byte budget and return at most 64 hits per call. Cursors bind query/filter identity, epoch and index revision; stale cursors require restarting pagination. Excerpts retain source-relative Unicode-safe offsets, highlights and a bounded 512-unit window. The FTS-only projection replaces embedded NUL with one space because measured SQLite highlighting drops/truncates NUL-containing text. Original chunk payload and excerpt text remain unchanged, with the same UTF-16 offsets.

If derived initialization fails, known dirty triggers are disabled so missing search tables cannot prevent canonical writes. `repairDerived()` transactionally replaces only the reserved `quixi_search_*` namespace, recreates triggers and queues a fresh index. Canonical records, operation history and blobs are untouched. It also discards derived extraction cache; future extraction orchestration must repopulate that cache from retained attachments. Ordinary epoch rebuild preserves extraction registrations. Whole-database corruption is outside this derived repair contract.

## Evidence and remaining gates

`npm test --workspace @quixi/search` passes 25 tests: five chunker cases and twenty repository cases on the SHA-256-verified shipped SQLite WASM. Coverage includes long-tail retrieval, exact source positions, filters, bounded pages, held-source edits/tombstones, rebuild and retry, restart, verification cancellation, eight repeated resource-yield cycles, Unicode/NUL highlighting, and missing-table isolation/repair. Node blob fixtures model leases; they do not claim actual OPFS host support.

The root integration run in `test-results/archive-client-browser.json` passes Chromium and Playwright WebKit with the real archive worker/OPFS, automatic idle indexing/status notifications, foreground range admission, derived-table corruption followed by canonical writes and repair, and canonical/sync preservation. These are browser-engine results, not proof for every Tauri runtime.

Plan07 has qualified shared UI navigation, document extraction (plan14) and incremental verification. Remaining gates are release-corpus relevance, large-archive latency/space measurements, supported-host release validation, portability filtering (plan10) and vector fusion (plan21). OCR (plan15) is deferred. No inference or separate document chunk policy is introduced here.
