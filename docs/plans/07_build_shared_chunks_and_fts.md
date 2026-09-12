# 07 — Build shared chunks and lexical search

**Status:** Lexical repository and shared UI navigation implemented and tested; release-scale and dependent capability qualification remain open

**Workstream:** A5/D2 foundation — always-available search

**Depends on:** [02](./02_define_canonical_history.md), [03](./03_build_storage_repositories.md)

## Outcome

Make all canonical text searchable with FTS5 and establish a shared, versioned SearchChunk pipeline for conversations and documents.

## Product references

- [3. Product pillars](../product.md#3-product-pillars)
- [42. Unified search architecture](../product.md#42-unified-search-architecture)
- [44. Search modes](../product.md#44-search-modes)
- [45. Search filters](../product.md#45-search-filters)
- [46. Search result UX](../product.md#46-search-result-ux)
- [47. SearchChunk](../product.md#47-searchchunk)
- [48. Message chunking](../product.md#48-message-chunking)
- [49. Document chunking](../product.md#49-document-chunking)
- [50. Chunking strategy](../product.md#50-chunking-strategy)
- [103. Track A — Product Core](../product.md#103-track-a--product-core)
- [116. Product-core success criteria](../product.md#116-product-core-success-criteria)

## Tasks

- [x] Implement SearchChunk production with stable source references, source positions, context prefixes, and chunking versions. Keep source text authoritative and generated chunks rebuildable.
- [x] Implement structural boundaries for headings, paragraphs, lists, code, sentences, and token splits. Keep the initial lexical path independent of model loading; make model-token-aware segmentation separately usable when added.
- [x] Maintain FTS records as text is committed or extracted and define consistent update/deletion/rebuild behavior. Preserve lexical availability while optional semantic backfill is absent or running.
- [x] Implement bounded search operations, early filters, deterministic ordering, snippets/highlighting, and navigation back to the correct thread/message or document location.
- [x] Implement Exact mode and lexical-only Best behavior. Expose semantic unavailability explicitly without returning an empty Best result simply because inference is disabled.
- [x] Create a small relevance corpus covering long messages, code, imported text, and duplicate-looking passages. Use it to detect truncation and source-mapping regressions.
- [x] Document chunk invalidation and reindex behavior after source edits or chunker upgrades, including the handoff to future embedding jobs.

## Deliverables and interfaces

- Shared chunking/query code in packages/search; FTS schema and SQL remain private to storage.
- Search result/filter contracts, chunk provenance, and lexical relevance fixtures.

## Acceptance criteria

- [x] Text beyond the first model-sized window of a long message is searchable and navigates to its source.
- [x] Native and imported text is searchable with semantic search disabled, rebuilding, or failing.
- [x] Updates and deletions remove stale results, and an FTS rebuild preserves canonical history.
- [x] Search operates with bounded pagination and applies filters consistently.

## Implementation evidence and open acceptance

- [ADR0007](../decisions/0007-shared-chunks-and-lexical-search.md) records the derived schema, visibility fences, resource bounds, repair and dependency gates.
- `npm test --workspace @quixi/search`: 25 passing tests against the shipped, hash-verified SQLite WASM and shared chunker. Cases cover long-tail/source accuracy, imported/native/code/document sources, registered synthetic PDF-page text, bounded pages, edit/tombstone/restart, cancellation/admission pressure, repeated partial-run cleanup, and canonical-safe derived repair. Synthetic page registration does not implement PDF extraction.
- `test-results/archive-client-browser.json`: root-run Chromium and Playwright WebKit integration verifies actual archive-worker/OPFS lexical search, idle maintenance/status notifications, foreground resource admission and missing-derived-table repair while canonical writes remain available.
- [x] Render results and verify click-through navigation in the shared UI. [Document UI acceptance](../../packages/app/src/features/documents/tests/browser/README.md) verifies exact current page references, highlighted text and stale-hit refusal in Chromium/WebKit; [shared app acceptance](../validation/shared-app.md) covers conversation navigation. The [bounded resolver proof](../../packages/storage/tests/search-navigation/README.md) additionally verifies Unicode/code positions, repair and source replacement.
- [Image metadata](../../packages/storage/tests/image-search/README.md) now includes independent filename chunks without changing description offsets. The [strict conversation resolver](../../packages/storage/tests/conversation-search-navigation/README.md) validates current chunk/source/ownership, and [seven UI groups per browser](../../packages/app/src/features/content/tests/search-browser/README.md) open an exact matching part beyond the first parts page while preserving drafts and refusing stale hits.
- [ ] Measure large-archive latency, disk amplification and relevance on the release corpus and each supported host. Current rank fixtures are correctness regressions, not a completed user relevance study. The [plan 08 scale scenario](../validation/shared-app.md#scale) records one observation: about 4,000 short seeded sources index in the background at roughly a dozen per second in both engines, and a quoted exact search then resolves and opens its hit in well under a second. Since 2026-09-12 the [search scale proof](../validation/search-scale.md) records 101,000 messages indexed in 369 s (Chromium) / 298 s (WebKit) — about 270–340 sources per second after [ADR 0038](../decisions/0038-indexing-throughput-at-scale.md) — with exact search at 18 ms and Best at 74–82 ms over that archive; disk amplification: a 30,000-message archive with its lexical index occupies 420–452 MB on OPFS against a 106 MB portable export ([archive-scale.md](../validation/archive-scale.md)). Relevance on a release corpus and the remaining supported hosts stay open.
- [x] Bound initial blob verification by resumable slices. [Incremental verification acceptance](../validation/incremental-search-verification.md) proves a 128 KiB admission budget, no chunking before complete digest verification, canonical/sync preservation, cancellation, shared foreground reads and restart from zero. Actual Chromium/WebKit production-client reads return between incomplete verification turns. This bounds byte work rather than individual filesystem-call latency.
- [ ] Complete dependent capability gates as those plans land: portability filter (10), document extraction (14, complete), semantic retrieval (21, implemented: Best fuses the lexical ranking with vec0 candidates and Semantic mode is served from the same chunks under [ADR 0034](../decisions/0034-semantic-indexing-and-hybrid-search.md); production chunking is now model-token aware with the frozen tokenizer and a 256-token budget, and the derived version names it). OCR (15) is deferred and does not gate the current goal. Unsupported requests (portability, OCR sources) still return explicit reasons.

## Boundaries and sequencing

RRF and vector retrieval are implemented in plan 21. Production semantic chunk-size tuning is benchmark-driven in plans 16–22; do not freeze a guessed token count here. Documents in plan 14 reuse this chunker.

[Back to the roadmap](./README.md)
