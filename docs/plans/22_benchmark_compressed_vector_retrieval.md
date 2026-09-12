# 22 — Benchmark and implement compressed vector retrieval

**Status:** Complete (2026-09-12) — representation benchmark at 100k/500k/1M, three measured decisions ([ADR 0036](../decisions/0036-compressed-vector-retrieval.md): resident sign-bit coarse stage with a 5,000-candidate float32 rerank above 100,000 vectors), the storage implementation with its rebuild lifecycle, browser measurements at 100k–1M in both engines, the hybrid/filter rerun, and the 101,000-message application proof ([ADR 0038](../decisions/0038-indexing-throughput-at-scale.md)). Non-blocking follow-ups (cold resident load, per-round publication cost) are recorded in ADR 0038.

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
- [x] Measure the float baseline and candidate-generation variants for binary and int8, including query conversion, filtering, storage reads, WASM overhead, and memory pressure. — Float, int8 (per-vector and global scale) and binary coarse are measured for quality, candidate overlap, index bytes and single-thread JavaScript scan cost at all three sizes. Browser (Chromium + WebKit, OPFS, pinned sqlite-vec WASM) at 100k and 500k: float KNN, int8 coarse, coarse→rerank latency, page-cache misses (OPFS reads), SQLite memory high-water, query quantization cost, cold reopen and a `chunk_size=16` rerank variant — `perf/retrieval/browser-knn/` and `browser-knn-*.json` (ADR 0036 "Browser measurement"). Sign-bit pre-filter measured for quality (`binaryWide<k>_float32Rerank`, 2k–20k candidates, all sizes) and browser latency (sqlite-vec `bit[384]` KNN and a resident in-worker Hamming scan with float rerank, 100k/500k/1M, both engines; `browser-knn-1000000-chunk16.json`: 81/79 ms against a 468/473 ms float scan) — ADR 0036 amendment 2 and "The 1M browser measurement". Filtering over the selected representation: `hybrid.mjs` (coarse forced, thread filter) and the 101k application proof (thread filter under the coarse stage).
- [x] Compare float and int8 reranking after compressed retrieval across generous candidate counts, starting with the spec’s 200–1000 range and widening only with evidence. — 200/500/1000 measured for binary→float, binary→int8 and int8→float; int8 coarse + float rerank matches float at 200 already; int8 as final ranking loses Recall@10; 500 chosen as margin (ADR 0036).
- [x] Measure Recall@5/10, MRR, coarse Recall@100/500, full-query latency, disk/OPFS reads, index size, and browser stability under foreground and backfill load. — Recall/MRR/coarse overlap: `compressed-report.json`; latency, OPFS pages read, index bytes and foreground queries interleaved with 1,000-row publication batches at 100k/500k in both engines: `browser-knn-*.json` (no errors, no eviction, memory high-water ≤ 29 MB). 1M in the browser: `browser-knn-1000000-chunk16.json` (both engines, 2.0 GB OPFS, no errors, backfill interleaving). End-to-end product query path (RRF + filters) measured in Node on the 658-chunk corpus: `hybrid-report.json` (semantic 69 ms, coarse forced 95 ms, thread-filtered 6 ms per 500-hit query), and in Chromium/WebKit through the Storage Worker at 30,000 messages ([search-scale.md](../validation/search-scale.md): semantic 485/451 ms, correctness held). The 101k run exposed O(n²) lexical indexing and status costs, fixed across eight steps in [ADR 0038](../decisions/0038-indexing-throughput-at-scale.md); the 101,000-message proof now passes end to end in both engines with the coarse stage active (semantic 72/78 ms median, all planted topics first). Open: 1M in the browser.
- [x] Write the representation decision from benchmark results (amended twice by measurement: coarse stage = resident sign-bit index + float32 rerank of 5,000 candidates, ADR 0036 amendment 2). Do not assume Arctic XS tolerates binary quantization or impose a float full-scan production path at large scale. — [ADR 0036](../decisions/0036-compressed-vector-retrieval.md): binary overlap with exact neighbours falls to 0.22/0.14 (top-100/500) at 1M and loses judged recall at 200 candidates, so it is rejected as a sole coarse stage; int8 global-scale coarse + float32 rerank is selected.
- [x] Implement the selected storage representation, versioned index build/rebuild path, candidate generation, and accurate rerank inside the established storage/search boundaries. — Semantic namespace v3 in `packages/storage/src/worker/search/semantic.ts` (ADR 0036 "Implementation of amendment 2"): `quixi_semantic_bits` sign-bit projection (48 B/vector) written with each vector, float vec0 table at `chunk_size=16` with in-place rebuild of legacy namespaces, v2 int8 projection dropped on upgrade, maintenance backfill, foreign-representation discard, resident index loaded lazily and appended on publish, Hamming top-5,000 → exact float32 rerank at or above 100,000 vectors, `status.projection` (representation, bytes, candidates, resident bytes); unit tests compare the coarse ranking with the exact one on a lowered threshold and cover both upgrade paths; browser proof in both engines.
- [x] Re-run the complete hybrid benchmark with RRF and source filters; investigate chunk-size effects using the candidate sizes from the spec. — `perf/retrieval/hybrid.mjs` runs the plan 16 corpus through the production storage repository (real lexical index, SIMD encoder vectors, the product search operation paged by cursor) in Exact/Semantic/Best with no filter, source-type filters and a 32-thread filter, plus the coarse stage forced on; the §50 sweep (128–448 tokens) gives identical metrics because the corpus's 655 single-passage documents produce ≤ 6 multi-chunk documents at any budget. Findings: [ADR 0037](../decisions/0037-best-mode-lexical-matching.md) (any-term lexical fusion measured and rejected; Best keeps all-term matching) and the per-chunk KNN re-execution fixed in storage (ADR 0036). Reports: `hybrid-report.json`, `hybrid-report-any-term.json`.
- [x] Retain raw reports and rollback/rebuild guidance so a future representation change cannot silently mix vector formats. — Raw reports: `compressed-report.json`, `sqlite-vec-knn-100000.json`; the stored `(representation, scale, generation)` row makes a mismatch discard-and-rebuild at open (tested), and ADR 0036 records the rebuild path and the exact float table as the oracle.

## Deliverables and interfaces

- Benchmark-backed coarse/rerank selection, representation metadata, and production retrieval implementation.
- Repeatable large-index measurements with relevance and resource-usage reports.

## Acceptance criteria

- [x] The chosen path meets the retrieval gates established in plan 16 and records its latency/memory tradeoffs. — sign-bit coarse (5,000) + float32 rerank reproduces the plan 16 baseline (Recall@5 0.8426, Recall@10 0.8981, MRR 0.8611) at 100k/500k/1M (`compressed-report.json`, `binaryWide5000_float32Rerank`); latency and memory at 100k–1M in both engines and through the application at 101k are in ADR 0036 and ADR 0038.
- [x] Million-vector testing uses a compressed candidate representation instead of relying on repeated full float scans. — at 1M the resident sign-bit stage answers in 81/79 ms against the 468/473 ms float scan in Chromium/WebKit; the production threshold (100,000) puts every larger index on that path, proven through the application at 101k.
- [x] Filtering and RRF preserve correctness across the selected representation and its rebuild lifecycle. — `hybrid.mjs` (RRF and source/thread filters with the coarse stage forced: identical judged metrics), the storage tests (coarse ranking equals exact, upgrade/backfill/mismatch rebuilds, filters), and the 101k application proof (Best as "Exact + semantic match" and the thread filter under the coarse stage, after a cold reopen).
- [x] Changing or deleting the derived representation leaves canonical text and FTS usable. — tested: representation mismatch clears only the projection; semantic deletion keeps lexical hits.

## Boundaries and sequencing

If binary recall fails, evaluate int8 rather than lowering the quality bar silently. If neither candidate meets the gates, record a semantic-scale release blocker and benchmark the next representation; core releases remain independent.

[Back to the roadmap](./README.md)
