# Document page indexing cost diagnosis

Plan14 baseline diagnosis and approved page-credit optimization acceptance.
The original baseline was captured before production edits; the comparison below
records the narrowly scoped implementation afterward.
The script creates disposable databases with the real pinned SQLite WASM,
canonical repository, extraction repository and search repository. It publishes
1,000 synthetic pages of 159 UTF-16 units and measures each existing
`advanceExtractionIndex()` admission. The original PDF blob is only fixture
provenance; this does **not** measure PDF.js, OPFS, browser messaging or disk I/O.
The fixture verifies the SQLite WASM artifact hash before opening its database.

Run:

```sh
npx tsc --noEmit -p packages/storage/tests/search-performance/tsconfig.json
node --experimental-transform-types packages/storage/tests/search-performance/diagnose.ts
```

`QUIXI_PERF_PAGES` may select 10–1000 pages. The default is 1000. The report records
production source fingerprints and exact `EXPLAIN QUERY PLAN` output. Its filename
is `results/baseline.json`; rerunning replaces that diagnostic capture.

## Captured result

The 2026-09-09T08:55:54.025Z capture took **28,958 ms in 1000 admissions**. The
instrumented SQL boundary covers search calls, including search visibility SQL;
extraction adapter calls through the separate fixture database are outside those
per-statement totals. Instrumentation overhead is included in wall time.

| Statement family | Calls | Total ms | Share of admission wall time |
| --- | ---: | ---: | ---: |
| Obsolete page references | 6005 | 15758 | 54.4% |
| Obsolete chunks | 6005 | 2447 | 8.4% |
| Visible chunk count | 3000 | 7914 | 27.3% |
| Queue selection | 2005 | 58 | 0.2% |
| Queue counts | 6000 | 55 | 0.2% |
| Other instrumented SQL | 107051 | 1486 | 5.1% |

Page 10 admission took 6.4 ms, page 100 took 8.5 ms, page 500 took 28.0 ms,
and page 1000 took 55.6 ms. There were two progress callbacks and three full
status calculations per admission. Page 1 took 22.1 ms including initial source
expansion. These are individual samples, not percentile estimates.

## Exact paths

- `SearchRepository.advanceExtractionIndex` delegates to `advance({maxChunks:4})`
  and returns its global status. The production `advanceExtractionPageIndex`
  dispatcher discards that value and reads the exact requested page's indexed
  head afterward.
- `advance` calls `progress` when activating a source and at slice completion.
  The production constructor supplies `onProgress`, so both calls evaluate
  `status()`. Its final returned `status()` evaluates it a third time.
- `status` counts visible chunks through full visibility predicates, including
  canonical metadata and optional published extraction joins. It also calls
  `obsolete()`.
- `obsolete` first scans healthy page references and tests each visible head. Its
  second query probes chunk/build/head relationships. `EXISTS` can stop early on
  obsolete data, but **must inspect every healthy candidate to establish absence**.
  The captured query plans show `SCAN er` and a covering `SCAN c`.
- `advance` additionally calls `obsolete` before choosing each source and again
  when its queue becomes empty. The ordinary one-page admission performs about
  six obsolete checks in total; initialization contributes five extra checks.

## Bounded change reviewed before implementation

1. Factor the existing work loop into an internal slice implementation. A private
   page-credit mode must suppress global status calculation, progress summary
   callbacks and archive-wide obsolete sweeps. It still performs the existing
   bounded outbox drain (32), expansion, byte/step budgets and at most four chunk
   writes, and preserves source-current checks before and within publication.
2. Make `advanceExtractionIndex` return `Promise<void>`. The production caller
   already ignores its summary. Keep the public `advanceSearchIndex`,
   `searchStatus` and search query response shapes and exact visibility/count
   behavior unchanged. Private tests that use page-credit return values to drain
   all background work should instead use ordinary `advance` or explicit status.
3. In the production page-credit dispatcher, retain extraction source validation
   and first ask `isExtractionPageIndexed(exactRef)`. Return credit immediately
   when true, including zero-chunk pages. Otherwise run one bounded slice and
   repeat the same exact indexed-head check. Do not infer readiness from page
   number, document count, an obsolete cached summary or another source's head.
4. Leave actual deletion to ordinary maintenance initially. Stale page heads must
   remain invisible through the existing SQL predicates even while cleanup is
   delayed. No canonical or extraction schema changes are needed for this first
   change, and no visibility/index-count cache is introduced.

### Remaining background cost

`archive-runtime.ts` invokes idle maintenance after the foreground queue drains;
`ArchiveDatabase.advanceSearch` calls full `search.status()` before deciding
whether indexing is needed. Ordinary `advance` then emits/returns more summaries.
On an interactive PDF workflow, the queue can drain between many page staging
requests. Removing foreground scans alone therefore does not establish a complete
end-to-end improvement.

A follow-up may need a bounded maintenance hint (indexed queue/outbox existence,
active work and rebuild state), plus resumable GC cursors that inspect at most a
fixed number of candidate heads/chunks per slice. Exact public status remains an
explicit read. A deletion `LIMIT` alone does not bound inspection of healthy
rows; the cursor must bound the **candidate scan**, retain source-current
predicates, progress through all tables and revisit candidates after invalidation.
Continuous ingestion must not starve cleanup indefinitely. This requires separate
correctness acceptance rather than simply memoizing `obsolete()` forever.

## Acceptance before production handoff

- Real pinned-WASM page credit performs no global chunk count or unbounded
  obsolete existence scan as the prior-page population grows.
- Maximum four chunk writes and bounded 32-publication drain remain measured.
- Existing long-page, zero-chunk-page, replacement, source-SHA, delayed outbox,
  stale held source and repair acceptance stays green.
- Exact already-indexed resume grants credit without unrelated archive work.
- Public status and ordinary maintenance still report failures/rebuilds and
  eventually reclaim obsolete chunks/maps without hiding unrelated valid pages.
- Repeat the actual production 1000-page Chromium/WebKit profile to separate
  foreground gains from remaining idle maintenance costs. The Node numbers here
  are a diagnosis, not a browser performance prediction.

## Approved page-credit implementation and comparison

After the browser baseline window closed, the private page-credit slice and exact
already-indexed dispatcher shortcut described above were implemented. Ordinary
`advance()` still performs cleanup and progress reporting; explicit status still
counts visible chunks. Existing private drain helpers now use ordinary advance
because they intentionally drain the whole derived index.

The same 1,000-page fixture captured the optimized path at
`results/optimized.json`: **2,677 ms**, compared with the original **28,958 ms**
(10.8× lower admission wall time). All 6,005 obsolete-reference scans, 6,005
obsolete-chunk scans and 3,000 visible-chunk counts disappeared from the credit
lane. Page 1,000 took 2.49 ms rather than 55.60 ms. There were zero global progress
summary callbacks. These remain Node SQLite measurements, not browser speed claims.

```sh
QUIXI_PERF_CAPTURE=optimized node --experimental-transform-types packages/storage/tests/search-performance/diagnose.ts
node --experimental-transform-types --test packages/storage/tests/search-performance/page-credit.test.ts
```

`QUIXI_PERF_CAPTURE` accepts only `baseline` or `optimized` and defaults to
`baseline`; it selects the report filename without changing the fixture. The
baseline retains the captured source fingerprints from before the optimization
and before that output-filename option was added. Do not overwrite it when
capturing the optimized path.

Focused acceptance covers 100 progressively published pages with zero prohibited
scan statements, exact public status counts/progress, long and empty pages,
four-chunk write admissions, replacement and clear while a source is held, and
ordinary maintenance eventually reclaiming obsolete chunks. The production runtime
idle-maintenance cost described above remains unchanged and must be separated in
the next browser profile.

## Dense-page validation cost

`dense-credit.ts` supplies ten pages of 151,000 UTF-16 units, 2,000 source/separator
spans and 38 staging batches per page through the real extraction repository,
then measures page-specific search credit using shipped SQLite WASM. Text matches
the synthetic dense PDF workload; source geometry is synthetic and no PDF parser
is invoked. Publication/fixture construction are outside the timing. Instrumented
SQL includes both search and extraction-source reads, with nested-call suppression.
The fixture's simplified claim adapter is outside the measured indexing work.

[The baseline](results/dense-credit-baseline.json) performs 1,120 full page-source
checks and 14,628 SQL calls to publish 380 chunks in 100 admissions. A page's
identity, layout digest and canonical source were checked repeatedly between
synchronous chunk writes although this worker owns the only SQLite writer.

The document-credit path now reuses a successful check only within one
synchronous segment and one work object. Every admission starts fresh, and every
await invalidates the cached check. Public ordinary indexing is unchanged.
Publication still validates immediately before and inside its transaction;
the caller's exact page-credit query also remains independent.

[The optimized capture](results/dense-credit-optimized.json) performs 230 full
checks and 4,838 SQL calls, with the same 380 chunks and unchanged canonical/sync
fingerprint. Total instrumented admission time changes from 351.2 to 305.3 ms in
these single Node runs; this is not a browser/OPFS throughput claim. Exact
[baseline](results/dense-credit-baseline-search-index.ts.txt) and
[optimized](results/dense-credit-optimized-search-index.ts.txt) search source
snapshots are retained and hash-checked against the reports. The separately
measured [staging serialization change](../extraction-performance/README.md)
does not participate in these captures.

Five page-credit regression tests cover bounded source checks/chunk writes,
clearing a held source between admissions, independent publication validation,
large/empty pages, exact status and eventual cleanup. Reproduce with a new capture
label to preserve the retained baseline and optimized reports:

```sh
QUIXI_CREDIT_CAPTURE=local node --experimental-transform-types packages/storage/tests/search-performance/dense-credit.ts
node --experimental-transform-types --test packages/storage/tests/search-performance/page-credit.test.ts
```
