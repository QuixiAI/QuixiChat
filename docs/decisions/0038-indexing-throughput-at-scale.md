# ADR 0038 — Lexical indexing and status costs at 100k messages: what was O(n²), what is fixed, what remains

Date: 2026-09-12. Status: accepted; the first four fixes are implemented, the
remaining costs are the next storage slice.

## Trigger

The plan 22 browser scale proof
([packages/app/tests/browser/semantic-scale.mjs](../../packages/app/tests/browser/semantic-scale.mjs))
seeds messages through the production Storage Worker, indexes them with the
production lexical path, publishes synthetic vectors through the real
claim→publish protocol and measures the semantic query path. Its first run at
101,000 messages did not finish lexical indexing in 30 minutes in Chromium.
A Node probe reproduced it: 10,000 messages took 404 s (40 ms each), with
the cost per slice growing as the index grew.

## Causes found (Node probes on the pinned SQLite WASM, 10k messages)

1. **Queue pick sorted the whole queue on every step.** `ORDER BY CASE scope
   WHEN 'source' THEN 0 ELSE 1 END, epoch, scope, id LIMIT 1` cannot use the
   primary key: 1.5 ms per step at 19k queue rows, linear in the queue, up to
   64 steps per slice.
2. **The obsolete-row scan ran on every step.** `obsolete()` walks every chunk
   (anti-join against builds and heads) and every page ref before each new
   source is picked: 0.46 ms at 800 chunks, growing linearly; at 100k chunks
   about 60 ms per step.
3. **Progress reported a full status after every source.** `status()` counts
   visible chunks with five correlated scope lookups per head (2 µs per chunk
   in Node: 15 ms at 7k chunks, 200 ms at 100k), and `onProgress` is always
   attached in the worker, so the browser paid it per message: 380 s for 10k
   messages in Chromium against 75 s in Node.
4. **Thread-scope expansion scanned every part.** The join was driven from
   `parts` by collection instead of from the thread's messages: 7 ms per
   thread at 10k parts, linear in the archive.

## Fixes (this slice)

- Ledger version 2 of the derived search schema adds two indexes on
  `quixi_search_queue` (`failed,scope,epoch,id` and `failed,epoch,scope,id`);
  existing archives gain them in place at open (`quixi_search_schema` row 2),
  and the pick is two index seeks (sources first, then the scopes that expand
  into sources) with the same order as before.
- `obsolete()` is gated by a flag set only where rows can become obsolete
  (replaced heads or builds, released runs, page-ref writes, rebuilds and
  epoch switches, cleanup, document/global scope expansion); a negative scan
  clears it.
- Progress is reported once at the end of a slice, not per source.
- Thread expansion is driven from the thread's messages (`quixi_thread_records`)
  to their parts (`quixi_part_order`).

Node, 10k messages: 404 s → 75 s (7.5 ms per message). The storage suite
(43 tests) and the application browser proofs pass unchanged.

## Fix 5 (same day): a trigger-maintained `stale` flag on heads

`quixi_search_heads` gains `stale INTEGER NOT NULL DEFAULT 0` with indexes on
`(epoch, stale)`, `message_id` and `source_key`; the dirty triggers (and the
code path that dirties extraction scopes) flag the heads a canonical change
makes invisible with one indexed UPDATE per scope kind, and a published head
resets the flag. `VISIBLE_HEAD` is now `h.stale=0`: every visibility
predicate — the counts in `status()` and in the semantic status returned by
each vector publication, the lexical and semantic query joins, the
obsolete-row scan and cleanup — is a column test instead of five correlated
scope lookups per head. The derived schema checksum changes, so a namespace
recorded under the previous build's checksum (kept as
`SEARCH_SCHEMA_LEGACY_CHECKSUM`, verified equal to the committed value) is
upgraded in place at open: triggers replaced, column and indexes added, the
flag computed once from the scope revisions, ledger row 1 rewritten. No
derived data is rebuilt. A repository test stages the legacy shape, changes
a title under the legacy triggers, reopens, and checks the flag, the
triggers, visibility and re-indexing; the frozen schema-8 archive proof,
the extraction-search, search-navigation, archive, selection and canonical
suites and the application browser proof pass over the upgrade.

Node, 10k messages: 75 s → 58 s; `status()` at 10k chunks 15 ms → 3.8 ms; a
101-record commit with 10k heads costs 57 ms (the trigger UPDATEs seek by
index). Browser scale proof at 10,000 messages, before → after:

| Phase | Chromium | WebKit |
| --- | --- | --- |
| lexical indexing | 380 s → {h['chromium']['phases']['lexical']['ms']/1000:.0f} s | — → {h['webkit']['phases']['lexical']['ms']/1000:.0f} s |
| publish 10,000 vectors | 23 s → {h['chromium']['phases']['publishBelowThreshold']['ms']/1000:.1f} s | — → {h['webkit']['phases']['publishBelowThreshold']['ms']/1000:.1f} s |
| semantic query median | 122 ms → {q('chromium','semanticMedianMs'):.0f} ms | — → {q('webkit','semanticMedianMs'):.0f} ms |

What remains is the per-message transaction floor: Chromium's slices settle
at about 130 ms for 16 messages (four queue steps and three fsynced
transactions per message on its OPFS; WebKit's commit is roughly ten times
cheaper), and the semantic query still assembles hits through several
statements. Those are the next two items of the decision below.

## Measured after fixes 1–4 (browser scale proof, 30,000 messages)

[semantic-scale-browser.json](../../packages/app/tests/browser/results/semantic-scale-browser.json),
Chromium  / WebKit on macOS 26.6.2, Apple M5 Max.

| Phase | Chromium | WebKit |
| --- | --- | --- |
| seed 30,000 messages (240 commits of ≤125 mutations) | 30 s | 21 s |
| lexical indexing (3,300 slices of ≤128 chunks) | 1187 s | 728 s |
| publish 30,000 vectors (469 claim→publish rounds of 64) | 496 s | 459 s |
| semantic query, 20 hits, exact float KNN (median / max of 10) | 485 / 934 ms | 451 / 850 ms |
| Best (lexical + semantic, fused) | 484 ms | 446 ms |
| Exact (BM25) | 69 ms | 64 ms |
| semantic with a 32-thread filter | 264 ms | 240 ms |

Correctness held: all ten planted topics were the top semantic hit, Best
returned the planted message as "Exact + semantic match", and the thread
filter kept the planted hit. Product §112's foreground budget (5 s) is met at
30k, but the numbers show three remaining costs that make 100k–1M impractical:

1. **Per-message transaction floor.** A slice indexes 16 messages in 230 ms
   (Chromium) / 90 ms (WebKit) before any growth: four queue steps and about
   three fsynced transactions per message (`synchronous=FULL`, DELETE
   journal). 101k messages would need about 24 minutes in Chromium for the
   commits alone.
2. **Visible-chunk counts are O(n) with a large constant.** `status()` still
   runs once per slice (13 ms more per 1,000 chunks per slice in Chromium),
   and the semantic status inside every `publishSemanticVectors` result
   walks the visible chunks twice: publishing 30k vectors took 8 minutes at
   60 vectors per second, against 1,000+ per second for the inserts alone.
   The same predicate is evaluated at the start of every search.
3. **The product semantic query costs 450–485 ms at 30k**, ten times the
   bare vec0 KNN of the same size measured in `perf/retrieval/browser-knn`:
   the status read, the candidate join and hit assembly need a profile.

## Decision and next slice

Keep the fixes above and continue in storage with, in this order, each
measured by the same proof:

1. ~~A `stale` flag on `quixi_search_heads`~~ — done (fix 5 above), with the
   in-place upgrade.
2. Several sources per transaction in a slice (bounded by `maxChunks`), so
   the fsync cost is paid per slice rather than per message, and the
   message-scope expansion no longer re-enqueues a source whose head is
   already current.
3. A profile of `search()` at 30k+ (status read, KNN join, hit assembly) with
   the fix for whatever dominates.

Only after those does the 101k proof (and the 1M browser run of ADR 0036)
become a bounded exercise.
