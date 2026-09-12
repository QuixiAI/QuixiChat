# Search at scale: 30,000 messages through the production Storage Worker

Date: 2026-09-12. Plans: [22](../plans/22_benchmark_compressed_vector_retrieval.md),
[08](../plans/08_build_chat_and_library_ui.md) (responsiveness), [21](../plans/21_integrate_semantic_and_hybrid_search.md).
Decisions: [ADR 0038](../decisions/0038-indexing-throughput-at-scale.md), [ADR 0036](../decisions/0036-compressed-vector-retrieval.md).
Retained record: [semantic-scale-browser.json](../../packages/app/tests/browser/results/semantic-scale-browser.json).

```sh
npm run test:app:semantic-scale:browser                                   # default 1,010 × 100 = 101,000 messages
QUIXI_SEMANTIC_SCALE_THREADS=300 QUIXI_SEMANTIC_SCALE_PER_THREAD=100 npm run test:app:semantic-scale:browser
```

## What the proof does

The application harness page (`?embedding=missing`, so the app's own indexer
cannot start a runtime) seeds threads and messages through the Storage
Worker in bounded commits, drives the production lexical indexer with
`advanceSearchIndex`, enrols a synthetic model identity, and publishes
deterministic synthetic unit vectors through `claimSemanticChunks` /
`publishSemanticVectors`; ten messages carry planted topic directions so the
expected top hit of each semantic query is known. It then times the product
`searchArchive` operation in Semantic, Best and Exact modes, with and without
a 32-thread filter, below the coarse threshold (exact float KNN), and — when
the size reaches 100,000 — above it (resident sign-bit stage) and after a cold
reopen. Vectors are synthetic by design: the embedding worker is qualified
separately and would take hours on CPU at this size.

## Result (300 × 100 = 30,000 messages)

| | Chromium  | WebKit |
| --- | --- | --- |
| status | passed | passed |
| seed | 30 s | 21 s |
| lexical indexing | 1187 s (3300 slices) | 728 s (3300 slices) |
| publish 30,000 vectors | 496 s | 459 s |
| semantic query median / max | 485 / 934 ms | 451 / 850 ms |
| Best / Exact / thread-filtered semantic | 484 / 69 / 264 ms | 446 / 64 / 240 ms |
| planted topics found first | 10 of 10 | 10 of 10 |

Checks per engine: 1. The 101,000-message default did not finish lexical
indexing within 30 minutes before the ADR 0038 fixes and is projected at
about an hour after them (per-message transaction floor plus O(n) status
counts); it stays the target once ADR 0038's next slice lands. The coarse
stage (≥ 100,000 vectors) is therefore proven in storage tests and the
`perf/retrieval/browser-knn` harness, not yet through the application at
scale.

## Result after the batched-slice fix (100 × 100 = 10,000 messages, retained record)

| | Chromium | WebKit |
| --- | --- | --- |
| lexical indexing | 58 s (788 slices) | 47 s |
| publish 10,000 vectors | 12.7 s | 10.2 s |
| semantic query median / max | 95 / 122 ms | 85 / 111 ms |
| Best / Exact / thread-filtered | 101 / 6 / 104 ms | 86 / 7 / 97 ms |
| planted topics found first | 10 of 10 | 10 of 10 |

## Result after the stale-flag fix (100 × 100 = 10,000 messages, superseded)

| | Chromium | WebKit |
| --- | --- | --- |
| lexical indexing | 211 s (1100 slices; 380 s before) | 70 s |
| publish 10,000 vectors | 10.8 s (23 s before) | 9.2 s |
| semantic query median / max | 86 / 111 ms (122 before) | 80 / 103 ms |
| Best / Exact / thread-filtered | 92 / 5 / 95 ms | 80 / 5 / 87 ms |
| planted topics found first | 10 of 10 | 10 of 10 |

The retained record holds the latest 10k run; earlier tables are kept from
their runs' logs.

## The 101,000-message run (Chromium, 2026-09-12, after ADR 0038 fixes 1–7)

| Phase | Chromium |
| --- | --- |
| seed 101,000 messages | 137 s |
| lexical indexing (6,300 slices) | 661 s |
| publish 101,000 vectors | stopped after 60 minutes, incomplete |

The run was stopped in its vector publication phase; the claim scan and the
semantic status counts are O(n) per round (ADR 0038, "The 101,000-message
run"). Its partial report was not retained because the harness saves phase
timings only at completion; the numbers come from the run log. The retained
record stays the 10k run above.

## Limits

Single runs under development load on one machine; synthetic vectors and
short single-part messages; Playwright engines rather than shipped browsers.
