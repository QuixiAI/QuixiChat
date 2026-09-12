# ADR 0037 — Best mode keeps all-term lexical matching; any-term fusion measured and rejected

Date: 2026-09-12. Status: accepted from benchmark evidence (plan 22 task 7).

## Question

Product §42–§44 define Best as reciprocal rank fusion of a BM25-ranked list
and a semantic list. The lexical list is built by `lexicalQuery`, which
quotes every user term as an FTS5 phrase and joins them with AND, so a
question-style query ("Where did we decide to use OPFS for the archive?")
matches only chunks containing every word. On the plan 16 corpus (whose 18
judged queries are all questions in the product §82 style) Exact returns
nothing for every query, and Best's lexical half is therefore empty: Best
degenerates to Semantic. Should Best rank lexical candidates over *any*
matching term instead, so fusion has something to fuse?

## Measurement

[perf/retrieval/hybrid.mjs](../../perf/retrieval/hybrid.mjs) runs the corpus
through the production storage repository (real lexical index, real vectors
from the WASM SIMD encoder, the product's search operation with cursor paging
to 500 hits). Two runs, identical except for the lexical join in Best:

| Query set (judged queries) | Pipeline | all-term (AND) Recall@5 / @10 / @100 / MRR | any-term (OR) Recall@5 / @10 / @100 / MRR |
| --- | --- | --- | --- |
| no filter (18) | Semantic | 0.8704 / 0.9259 / 0.9815 / 0.8611 | 0.8704 / 0.9259 / 0.9815 / 0.8611 |
| no filter (18) | Best | 0.8704 / 0.9259 / 0.9815 / 0.8611 | 0.7315 / 0.8426 / 1.0000 / 0.8611 |
| sourceTypes: message (16) | Best | 0.8854 / 0.9167 / 0.9792 / 0.9062 | 0.7604 / 0.8854 / 1.0000 / 0.9062 |
| threadIds: 32 threads (16) | Best | 0.8750 / 0.9688 / 1.0000 / 1.0000 | 0.9062 / 0.9688 / 1.0000 / 1.0000 |

Reports: [hybrid-report.json](../../perf/retrieval/hybrid-report.json)
(all-term, the shipped behaviour) and
[hybrid-report-any-term.json](../../perf/retrieval/hybrid-report-any-term.json).
Exact stays at 0 recall on these questions in both runs, by construction.

## Decision

1. **Best keeps all-term lexical matching.** Fusing an any-term BM25 list
   with equal RRF weight (k = 60) raised Recall@100 to 1.0 but lowered
   Recall@5 from 0.870 to 0.731 and Recall@10 from 0.926 to 0.843 on the
   unfiltered set: question words ("where", "did", "we") match most chunks,
   the lexical list becomes noise, and RRF promotes that noise into the top
   ranks. The narrow thread filter, where the lexical list is short, gained
   Recall@5 (0.875 → 0.906), which confirms the mechanism rather than the
   remedy. The product's default mode must not lose top-rank quality for
   question-style queries, so the lexical list stays precise: when every term
   matches, the lexical and semantic lists agree and RRF ranks the hit first
   (verified in the storage tests, "Exact + semantic match"); when not, Best
   is the semantic ranking.
2. `lexicalQuery` keeps a `match: "any"` option for benchmarks and future
   variants; no product mode uses it. Candidates for a later slice, to be
   measured on a larger judged corpus before any change: dropping terms with
   high document frequency from the any-term list, or weighting the lexical
   list below the semantic list in the fusion. Product §43's "k = 60 unless
   benchmark data strongly justifies another value" stands.
3. The Exact mode semantics (every term or phrase, operators literal) are
   unchanged.

## Also found by this benchmark

The semantic candidate query let SQLite choose the visible-chunk scan as the
outer loop and re-run the vec0 KNN once per chunk (1,028 ms per page on
2,000 vectors in Node; the coarse path 2,948 ms). The KNN is now a
materialized CTE joined first (28 ms and 107 ms respectively); see ADR 0036
"Implementation of amendment 2".
