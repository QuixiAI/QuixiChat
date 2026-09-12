# ADR 0036 — Compressed candidate generation: int8 coarse retrieval with float32 rerank

Date: 2026-09-12. Status: accepted as plan 22's representation decision from
benchmark evidence and implemented in storage the same day (see
"Implementation"); browser-scale measurements follow in later slices.

## Question

Product §76–§81 rule out full float32 scans as the large-scale semantic path
(1M × 384 float32 = 1.46 GB) and require a benchmark-selected compressed
candidate representation — binary, int8 or a future ANN structure — followed
by an accurate rerank over a generous candidate set (200–1000). The design
explicitly does not assume Arctic XS tolerates binary quantization.

## Measurement

[perf/retrieval/compressed.mjs](../../perf/retrieval/compressed.mjs), recorded
in [compressed-report.json](../../perf/retrieval/compressed-report.json).
Real vectors: the plan 16 corpus (655 documents, 18 judged queries) through the
production chunker and the WASM SIMD encoder (658 chunks). Scale: 100k, 500k
and 1M pools where every vector beyond the real 658 is a deterministic
distractor drawn from the real distribution (`real-mixture-v1`: normalized
mixtures of two real vectors plus 0.15 σ Gaussian noise, seeded). Distractors
are unjudged and count as nonrelevant, so they can only lower judged metrics.
Single-threaded JavaScript typed-array scans in Node v22.23.1 on an Apple M5
Max, three repetitions per query; these are algorithmic quality results plus
relative CPU costs, not browser, WASM or sqlite-vec timings.

| Pool | Pipeline | Recall@5 | Recall@10 | MRR | Candidate overlap with exact top-100 / top-500 |
| --- | --- | --- | --- | --- | --- |
| all | float32 full scan (reference) | 0.8426 | 0.8981 | 0.8611 | 1 / 1 |
| all | int8 coarse (global scale) + float32 rerank, 200/500/1000 | 0.8426 | 0.8981 | 0.8611 | 0.975 / 0.992 (1M: 0.975 / 0.992) |
| all | int8 coarse (per-vector scale) + float32 rerank | 0.8426 | 0.8981 | 0.8611 | 0.977 / 0.993 |
| 1M | int8 full scan as the final ranking | 0.8426 | 0.8704 | 0.8611 | — |
| 100k → 1M | sign-bit binary coarse alone | 0.7315 | 0.79–0.81 | 0.82–0.83 | 0.377 / 0.352 → 0.223 / 0.142 |
| 1M | binary coarse 200 + float32 rerank | 0.8148 | 0.8704 | 0.8611 | — |
| 1M | binary coarse 500/1000 + float32 rerank | 0.8426 | 0.8981 | 0.8611 | — |

Index bytes at 1M: float32 1,464.8 MB; int8 366–370 MB; binary 45.8 MB.
Relative single-thread scan cost at 1M (median per query): float32 504 ms,
int8 557 ms (JavaScript gains nothing from narrower integers), binary 77 ms;
reranking 500 candidates in float32 costs about 0.26 ms.

## Decision

1. **Coarse representation: int8 with one global symmetric scale per index
   generation** (`q = round(x / s)`, `s = max|x| / 127` over the generation).
   Its candidate set agrees with the exact float top-500 at 99.2% across all
   sizes and reproduces every judged float metric after rerank. The global
   scale is what sqlite-vec's `int8[N]` column and `vec_distance_cosine`/`L2`
   on `vec_int8` values can consume directly; per-vector scales gained nothing
   measurable (0.977 vs 0.975 at top-100).
2. **Rerank: float32 over 500 candidates** (product §78 range). 200 already
   matches the float metrics for int8 coarse, so 500 is chosen as margin, not
   necessity; widen only with evidence from a larger judged corpus. The float32
   rerank source stays the existing `quixi_semantic_vec` float table for the
   candidate rows, so the exact vectors remain the correctness oracle and the
   int8 table is a derived, rebuildable projection.
3. **Binary is rejected for Arctic XS** as a sole coarse stage: its overlap with
   the exact neighbours falls with scale (14% at top-500 for 1M) and 200
   candidates already lose judged recall at 1M. This confirms product §79's
   caution rather than overturning it. Binary remains a candidate only as a
   pre-filter ahead of int8 if browser measurements show int8 scans too slow
   at 1M, and only with a candidate set far above 1000.
4. **int8 is not the final ranking.** Used alone it drops Recall@10 from 0.898
   to 0.870 on this corpus (one query's rank flips), so §81's "int8 rerank"
   variants are not selected.

## Representation metadata and lifecycle

The int8 projection carries `{ representation, scale, generation }` in the
semantic namespace next to the model identity and is rebuilt from the float
vectors whenever the generation, model identity, representation or scale
changes; a foreign projection is discarded at open and never mixed with the
current one (product §71, plan 22 task 8). While a projection is incomplete,
queries use the exact float path and the status names the reason. Deleting the projection leaves the float
vectors, canonical text and FTS usable; deleting the semantic index deletes
both. Filtering follows the existing bounded-candidate path (ADR 0034): the
coarse KNN uses sqlite-vec partition/metadata columns where a filter maps to
one, otherwise a larger candidate bound, and RRF fuses the reranked list with
the lexical ranking unchanged.

## Implementation (same day)

`packages/storage/src/worker/search/semantic.ts`, semantic namespace version 2:

- **Fixed scale instead of a per-generation maximum.** The benchmark's global
  scale was `max|x| / 127` over the pool; a scale that depends on the data
  would force a projection rebuild whenever a new vector exceeds the old
  maximum, and a rebuild rescans every float row. The implemented
  representation is `int8-fixed-symmetric-v1` with `s = 0.4 / 127` and
  clamping to ±127: Arctic XS unit vectors have components far below 0.4
  (the 1M pool's maximum was below it), and the benchmark variant
  `int8FixedCoarse500_float32Rerank` reproduces every judged float metric
  with 0.973 / 0.993 candidate overlap at top-100 / top-500, within noise of
  the data-dependent scale. The scale is stored, so a future change is a
  representation change, not a silent drift.
- **Tables.** `quixi_semantic_int8 USING vec0(embedding int8[384])` written
  with `vec_int8(?)` (sqlite-vec refuses raw blobs on int8 columns), plus a
  singleton `quixi_semantic_projection(representation, scale, generation)`
  row. Publication writes the float row and its int8 projection in the same
  transaction; enrolment, re-enrolment with a different identity and deletion
  clear both.
- **Upgrade and repair.** A version-1 namespace is upgraded in place at open
  (float vectors kept, projection empty); bounded maintenance backfills the
  missing int8 rows from the float blobs and reports what remains. A
  projection row with another representation or scale is cleared at open and
  rebuilt the same way. The float table stays the correctness oracle.
- **Retrieval switch.** Below `SEMANTIC_COARSE_THRESHOLD` (20,000 vectors) or
  while the projection is incomplete, `candidates()` runs the exact float
  KNN as before. At or above it with a complete projection, it takes the top
  `max(k, 500)` int8 neighbours (`MATCH vec_int8(query)`) and reranks them by
  exact float32 L2 distance before the bounded-candidate / RRF path of ADR
  0034, which is unchanged. The threshold is a constructor option
  (`semanticCoarseThreshold`) so tests exercise the coarse path on tiny
  indexes and compare its ranking with the exact one.
- **Status.** `SemanticIndexStatus.projection` reports representation, scale,
  projected count, completeness, whether coarse retrieval is active and the
  threshold; the app's semantic panel shows it.

Pinned-SQLite measurement in Node ([sqlite-vec-knn.mjs](../../perf/retrieval/sqlite-vec-knn.mjs),
[sqlite-vec-knn-100000.json](../../perf/retrieval/sqlite-vec-knn-100000.json)),
100k pseudo-random vectors, brute-force vec0 scans, 20 queries: float KNN
top-64 median 20.9 ms; int8 coarse top-500 median 56.0 ms; coarse + float
rerank 76.2 ms; top-64 agreement with the exact ranking 1.0. In this build
sqlite-vec's int8 scan is *slower* than its float scan, so the projection's
benefit at 100k is memory and I/O (0.37 GB versus 1.46 GB at 1M), not CPU;
the browser measurements below decide whether a binary pre-filter or an ANN
structure is needed before the 1M gate. The 20,000 threshold is a first
setting, not a measured optimum.

## What remains before the semantic-scale gate

- Measure in the browser: sqlite-vec int8 KNN latency, OPFS reads and memory at
  100k/500k/1M in Chromium and WebKit, under foreground and backfill load
  (product §112), and the WASM overhead of query quantization.
- Re-run the hybrid benchmark with RRF and source filters over the selected
  representation, and the chunk-size sweep from product §50, on a larger
  independently judged corpus before any broad quality claim.
