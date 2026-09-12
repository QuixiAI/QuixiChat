# Quixi retrieval reference benchmark

This standalone harness supplies the baseline for [product section 82](../../docs/product.md#82-retrieval-benchmark)
and [plan 16](../../docs/plans/16_freeze_embedding_port_and_retrieval_benchmarks.md).
It distinguishes model numerical parity, judged retrieval quality, coarse
candidate overlap, and performance; none substitutes for the others.

## Corpus and identities

`build_corpus.py` deterministically writes **655 original synthetic documents,
18 user-like queries, and relevance judgments**, all redistributable under the
[CC0 dedication](LICENSE.txt). It contains no private history or third-party
passages. Topics include OPFS versus IndexedDB, Rust wrappers, credential storage,
PDF-like OAuth guidance, provider switching, branching, imports, archive restore,
FTS without embeddings, long PDFs, OCR, sync/recovery, bounded inference, caching,
code transactions, rank fusion, and streaming accessibility.

Each topic has two authored relevant passages and a similar nonrelevant passage.
The long assistant answer places an OPFS decision beyond the first 512 tokens.
Six hundred template distractors make candidate sizes 100 and 500 nontrivial.
This is an English-focused regression/smoke corpus with synthetic judgments, not
a sampled evaluation of real users or a basis for a broad quality claim. Expand
with independently reviewed, licensed, varied material before plan 21 selects
compression; never import private user history into benchmark fixtures.

`corpus-manifest.json` pins corpus, query, and judgment file hashes. The benchmark
also embeds the Arctic source lock and exact environment. Reference chunker
`reference-wordpiece-window-v1` cuts 256 content-token windows with 32-token
overlap, retaining source text offsets. It creates 659 chunks. The benchmark's
Python offsets are Unicode code-point coordinates; they must be converted when
integrating the production shared SearchChunk contract. Production chunking
parity and alternative chunker evaluation belong to the search integration plan.

## Run

Set up the [pinned offline environment](../../packages/quixi-embed/reference/README.md), then:

```sh
python3 perf/retrieval/build_corpus.py
python3 -m unittest discover -s perf/retrieval -p 'test_*.py'
packages/quixi-embed/build/reference-env/bin/python perf/retrieval/run.py \
  --output packages/quixi-embed/build/retrieval-report.json
```

`--skip-performance` omits the 15 inference timing configurations for a faster
quality-only rerun. Corpus embedding uses bounded batches of 16. The final
reference vector arrays fit in this small corpus; this is not the large-index
memory benchmark. The loader refuses changed source or corpus hashes.

## Metric definitions

Exact search ranks normalized FP32 query/document dot products descending.
Stable ties retain deterministic corpus order. Chunk hits collapse to the best
rank for each source document before applying source-level relevance judgments.
Grades 1 and 2 both count as relevant; grade 0 does not. Recall@k is relevant
source documents retrieved divided by all judged relevant source documents.
MRR is the reciprocal rank of the first relevant source document in the complete
ranking, or zero when absent. Macro-average each metric over all 18 queries.
Unjudged sources count as nonrelevant in this closed synthetic corpus.

The sign-bit example ranks Hamming distance over 384 sign bits (48 packed bytes),
then optionally reranks its first 500 chunks by exact FP32 similarity. Report
judged Recall@100/500 separately from **candidate overlap with exact FP32 top-k
chunks**. The latter has exact-neighbor count as its denominator and does not
measure human relevance. Metric unit tests cover multiple judgments, no hits,
chunk deduplication, invalid inputs, and known reciprocal ranks.

## Recorded baseline

[baseline.json](baseline.json) records the actual 2026-09-08 CPU run with PyTorch
2.6.0, Transformers 4.49.0, one Torch thread, and the pinned model/chunker/corpus.

| Metric | Exact FP32 | Sign-bit top 500 then FP32 |
| --- | --- | --- |
| Recall@5 | 0.842593 | 0.842593 |
| Recall@10 | 0.898148 | 0.898148 |
| MRR | 0.861111 | 0.861111 |
| Judged Recall@100 | 0.981481 | 0.981481 |
| Judged Recall@500 | 1.000000 | 1.000000 |

Binary candidate overlap with exact chunk neighbors is **0.523333 at 100** and
**0.840111 at 500**. Equal top-ten quality on this small corpus does not establish
that sign-bit compression is acceptable at production scale.

The recorded cold local model initialization was 91.55 ms; corpus embedding was
1,951.37 ms. These exclude network download and include already-cached local
files; they are not a browser cold-start claim. The complete timing distributions
and batch results are in the JSON. Peak process RSS was 2,317,320,192 bytes during
the run including the Python/framework/model and batch-32 length-512 workloads.
FP32 corpus vectors occupy 1,012,224 bytes; packed signs occupy 31,632 bytes.
Neither process RSS nor packed vector size measures GPU memory or a production
index's total footprint.

## Acceptance and subsequent measurements

Numerical parity uses the independent [golden comparator](../../packages/quixi-embed/reference/compare.py).
For a numerically accepted inference candidate, this frozen corpus requires no
aggregate drop in Recall@5, Recall@10, or MRR and investigation of every changed
top-ten ranking. Compression approval still requires plan 21's broader quality
and large-index evidence.

The recorded CPU batch baseline uses lengths 32/128/512, batches 1/4/8/16/32,
one warmup and three measured runs, explicitly preliminary on a development host without controlled ambient load. Scan timings use
seven repetitions per query. For production optimization decisions, use five
warmups and at least thirty samples, alternate baseline/candidate runs, and report
median/p95, chunks/s, tokens/s, cold load, memory peaks, device/browser identity,
GPU dispatch/readback and allocation bytes separately. Include mixed lengths and
all new dispatch boundaries, and identify cache hits separately. WASM SIMD,
WebGPU FP32/FP16, browser readback/dispatch, and million-scale index measurements
are **unmeasured**, not inferred from the offline CPU report.

## Production chunking parity — 2026-09-12

[production-chunker.mjs](production-chunker.mjs) reruns the exact-FP32 quality
measurement with the production pieces exactly as storage and the app use them:
`StructuralChunker` with the pinned Arctic offset tokenizer and the 256-token
budget (`quixi-structural-utf16-v1:4096:64:arctic-xs-offsets-1.0.2:d15cd90acf9df739:256`,
ADR 0034) and the WASM SIMD encoder from the versioned 1.0.2 distribution, in
Node v22.23.1 on macOS 26.6.2. [production-chunker.json](production-chunker.json)
records the run.

| Metric | Reference chunker + PyTorch (baseline) | Production chunker + WASM SIMD |
| --- | --- | --- |
| Chunks | 659 | 658 |
| Recall@5 | 0.842593 | 0.842593 |
| Recall@10 | 0.898148 | 0.898148 |
| MRR | 0.861111 | 0.861111 |
| Judged Recall@100 | 0.981481 | 0.981481 |
| Judged Recall@500 | 1.000000 | 1.000000 |

Seven queries change their top-ten ordering; each change moves only the
corpus's single multi-chunk document (`opfs-long`) among nonrelevant positions,
because the structural chunker cuts it at paragraph and sentence boundaries
without the reference 32-token overlap. Every judged relevant document keeps its
baseline rank. This closes plan 21's production-chunking parity measurement on
this corpus; it does not exercise the production context prefix (the corpus has
no titles) and remains a synthetic-corpus regression result, not a quality claim
about real archives. Corpus embedding took 31.9 s single-threaded on SIMD
(about 20 chunks/s) on a loaded development host.

```sh
node --experimental-transform-types perf/retrieval/production-chunker.mjs
```

## Compressed representation benchmark — 2026-09-12 (plan 22)

[compressed.mjs](compressed.mjs) scales the real production vectors to 100k,
500k and 1M pools with deterministic distractors from the real distribution
and measures product §81's pipelines; [compressed-report.json](compressed-report.json)
retains every number. Judged metrics use the same definitions as above;
"candidate overlap" is agreement with the exact float top-k chunks.

| Pipeline (1M pool) | Recall@5 | Recall@10 | MRR | Overlap @100 / @500 | Bytes |
| --- | --- | --- | --- | --- | --- |
| float32 full scan | 0.8426 | 0.8981 | 0.8611 | 1 / 1 | 1,465 MB |
| int8 (global scale) coarse + float32 rerank, 200–1000 | 0.8426 | 0.8981 | 0.8611 | 0.975 / 0.992 | 366 MB |
| int8 full scan as final ranking | 0.8426 | 0.8704 | 0.8611 | — | 366 MB |
| sign-bit coarse alone | 0.7315 | 0.8148 | 0.8249 | 0.223 / 0.142 | 46 MB |
| sign-bit coarse 200 + float32 rerank | 0.8148 | 0.8704 | 0.8611 | — | — |

int8 coarse retrieval keeps 97–99% of the exact neighbours at every size and
reproduces the float metrics after rerank; binary overlap falls from 0.38 to
0.22 (top-100) between 100k and 1M. [ADR 0036](../../docs/decisions/0036-compressed-vector-retrieval.md)
selects int8 coarse + float32 rerank over 500 candidates and rejects binary as
a sole coarse stage. Single-thread JavaScript scans at 1M: float 504 ms, int8
557 ms, binary 77 ms per query (Apple M5 Max); browser, WASM and sqlite-vec
costs are unmeasured here.

```sh
node --experimental-transform-types perf/retrieval/compressed.mjs            # 100k, 500k, 1M
node --experimental-transform-types perf/retrieval/compressed.mjs --sizes=100000
```

## sqlite-vec in the browser — 2026-09-12 (plan 22)

[browser-knn/run.mjs](browser-knn/run.mjs) serves the pinned SQLite WASM and a
dedicated worker ([browser-knn/worker.js](browser-knn/worker.js)) that builds
vec0 `float[384]` and `int8[384]` tables on the OPFS SAHPool VFS and measures
float KNN, int8 coarse KNN, coarse→float rerank, page-cache misses, SQLite
memory, cold reopen and queries interleaved with publication batches in
Chromium and WebKit; [sqlite-vec-knn.mjs](sqlite-vec-knn.mjs) is the Node
in-memory counterpart. Reports: `browser-knn-<size>[-chunk<n>].json`,
`sqlite-vec-knn-<size>.json`. Result (ADR 0036 amendment): the int8 scan is
CPU-slower than the float scan in this build and vec0 point lookups read whole
chunks, so the coarse stage is off by default.

```sh
npm run perf:knn:browser                                        # 100k, both engines
QUIXI_KNN_SIZES=100000,500000 npm run perf:knn:browser
QUIXI_KNN_FLOAT_CHUNK=16 QUIXI_TEST_BROWSERS=chromium npm run perf:knn:browser
npm run perf:knn:node -- --size=100000
```
