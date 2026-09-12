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
