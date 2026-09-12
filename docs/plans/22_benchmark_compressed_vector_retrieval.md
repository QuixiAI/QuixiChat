# 22 — Benchmark and implement compressed vector retrieval

**Status:** In progress — representation benchmark run at 100k/500k/1M and the decision recorded ([ADR 0036](../decisions/0036-compressed-vector-retrieval.md): int8 coarse with global scale + float32 rerank over 500 candidates; binary rejected as a sole coarse stage); storage implementation and browser-scale measurements remain

**Workstream:** C7 — large-index semantic retrieval

**Depends on:** [16](./16_freeze_embedding_port_and_retrieval_benchmarks.md), [21](./21_integrate_semantic_and_hybrid_search.md)

## Outcome

Select and implement a measured compressed candidate-generation path that preserves useful retrieval quality at hundreds of thousands to a million vectors.

## Product references

- [43. Reciprocal Rank Fusion](../product.md#43-reciprocal-rank-fusion)
- [50. Chunking strategy](../product.md#50-chunking-strategy)
- [75. sqlite-vec integration](../product.md#75-sqlite-vec-integration)
- [76. Vector scale](../product.md#76-vector-scale)
- [77. Compressed coarse retrieval requirement](../product.md#77-compressed-coarse-retrieval-requirement)
- [78. Candidate-generation pipeline](../product.md#78-candidate-generation-pipeline)
- [79. Binary coarse option](../product.md#79-binary-coarse-option)
- [80. Int8 coarse option](../product.md#80-int8-coarse-option)
- [81. Accurate reranking](../product.md#81-accurate-reranking)
- [82. Retrieval benchmark](../product.md#82-retrieval-benchmark)
- [105. Track C — QuixiEmbed](../product.md#105-track-c--quixiembed)
- [112. Semantic-search stress tests](../product.md#112-semantic-search-stress-tests)
- [117. QuixiEmbed success criteria](../product.md#117-quixiembed-success-criteria)

## Tasks

- [x] Build reproducible 100k, 500k, and 1M-vector datasets from the benchmark corpus/generator, recording model, chunker, quantization, and representation identities. — `perf/retrieval/compressed.mjs` builds seeded pools (`real-mixture-v1`) around the 658 real production-chunker vectors and records model, chunker, generator and quantization identities in [compressed-report.json](../../perf/retrieval/compressed-report.json).
- [ ] Measure the float baseline and candidate-generation variants for binary and int8, including query conversion, filtering, storage reads, WASM overhead, and memory pressure. — Float, int8 (per-vector and global scale) and binary coarse are measured for quality, candidate overlap, index bytes and single-thread JavaScript scan cost at all three sizes. Pinned-SQLite (Node) KNN timings at 100k recorded in `sqlite-vec-knn-100000.json` (int8 scan slower than float in this build; rerank agreement 1.0). Open: filtering, storage reads, WASM overhead and memory pressure in the browser (sqlite-vec int8 KNN in Chromium/WebKit).
- [x] Compare float and int8 reranking after compressed retrieval across generous candidate counts, starting with the spec’s 200–1000 range and widening only with evidence. — 200/500/1000 measured for binary→float, binary→int8 and int8→float; int8 coarse + float rerank matches float at 200 already; int8 as final ranking loses Recall@10; 500 chosen as margin (ADR 0036).
- [ ] Measure Recall@5/10, MRR, coarse Recall@100/500, full-query latency, disk/OPFS reads, index size, and browser stability under foreground and backfill load.
- [x] Write the representation decision from benchmark results. Do not assume Arctic XS tolerates binary quantization or impose a float full-scan production path at large scale. — [ADR 0036](../decisions/0036-compressed-vector-retrieval.md): binary overlap with exact neighbours falls to 0.22/0.14 (top-100/500) at 1M and loses judged recall at 200 candidates, so it is rejected as a sole coarse stage; int8 global-scale coarse + float32 rerank is selected.
- [x] Implement the selected storage representation, versioned index build/rebuild path, candidate generation, and accurate rerank inside the established storage/search boundaries. — Semantic namespace v2 in `packages/storage/src/worker/search/semantic.ts`: `quixi_semantic_int8` vec0 projection (`int8-fixed-symmetric-v1`, stored scale), in-place v1 upgrade with maintenance backfill, foreign-representation discard, coarse (k ≥ 500) → exact float32 rerank above 20,000 vectors, `status.projection`; unit tests compare the coarse ranking with the exact one on a lowered threshold; browser proof in both engines (ADR 0036 "Implementation").
- [ ] Re-run the complete hybrid benchmark with RRF and source filters; investigate chunk-size effects using the candidate sizes from the spec.
- [x] Retain raw reports and rollback/rebuild guidance so a future representation change cannot silently mix vector formats. — Raw reports: `compressed-report.json`, `sqlite-vec-knn-100000.json`; the stored `(representation, scale, generation)` row makes a mismatch discard-and-rebuild at open (tested), and ADR 0036 records the rebuild path and the exact float table as the oracle.

## Deliverables and interfaces

- Benchmark-backed coarse/rerank selection, representation metadata, and production retrieval implementation.
- Repeatable large-index measurements with relevance and resource-usage reports.

## Acceptance criteria

- [ ] The chosen path meets the retrieval gates established in plan 16 and records its latency/memory tradeoffs.
- [ ] Million-vector testing uses a compressed candidate representation instead of relying on repeated full float scans.
- [ ] Filtering and RRF preserve correctness across the selected representation and its rebuild lifecycle.
- [x] Changing or deleting the derived representation leaves canonical text and FTS usable. — tested: representation mismatch clears only the projection; semantic deletion keeps lexical hits.

## Boundaries and sequencing

If binary recall fails, evaluate int8 rather than lowering the quality bar silently. If neither candidate meets the gates, record a semantic-scale release blocker and benchmark the next representation; core releases remain independent.

[Back to the roadmap](./README.md)
