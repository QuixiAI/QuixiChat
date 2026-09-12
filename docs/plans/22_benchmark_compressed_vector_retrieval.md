# 22 — Benchmark and implement compressed vector retrieval

**Status:** Planned

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

- [ ] Build reproducible 100k, 500k, and 1M-vector datasets from the benchmark corpus/generator, recording model, chunker, quantization, and representation identities.
- [ ] Measure the float baseline and candidate-generation variants for binary and int8, including query conversion, filtering, storage reads, WASM overhead, and memory pressure.
- [ ] Compare float and int8 reranking after compressed retrieval across generous candidate counts, starting with the spec’s 200–1000 range and widening only with evidence.
- [ ] Measure Recall@5/10, MRR, coarse Recall@100/500, full-query latency, disk/OPFS reads, index size, and browser stability under foreground and backfill load.
- [ ] Write the representation decision from benchmark results. Do not assume Arctic XS tolerates binary quantization or impose a float full-scan production path at large scale.
- [ ] Implement the selected storage representation, versioned index build/rebuild path, candidate generation, and accurate rerank inside the established storage/search boundaries.
- [ ] Re-run the complete hybrid benchmark with RRF and source filters; investigate chunk-size effects using the candidate sizes from the spec.
- [ ] Retain raw reports and rollback/rebuild guidance so a future representation change cannot silently mix vector formats.

## Deliverables and interfaces

- Benchmark-backed coarse/rerank selection, representation metadata, and production retrieval implementation.
- Repeatable large-index measurements with relevance and resource-usage reports.

## Acceptance criteria

- [ ] The chosen path meets the retrieval gates established in plan 16 and records its latency/memory tradeoffs.
- [ ] Million-vector testing uses a compressed candidate representation instead of relying on repeated full float scans.
- [ ] Filtering and RRF preserve correctness across the selected representation and its rebuild lifecycle.
- [ ] Changing or deleting the derived representation leaves canonical text and FTS usable.

## Boundaries and sequencing

If binary recall fails, evaluate int8 rather than lowering the quality bar silently. If neither candidate meets the gates, record a semantic-scale release blocker and benchmark the next representation; core releases remain independent.

[Back to the roadmap](./README.md)
