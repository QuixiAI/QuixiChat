# Parser forced-GC diagnostic

This is a separate instrumented investigation of the parser-isolate growth seen in [the dense workload](DENSE.md). It is not a production performance measurement. The original no-GC reports and source snapshots remain unchanged.

```sh
QUIXI_TEST_BROWSERS=chromium QUIXI_PERF_GC=on QUIXI_PERF_CASES=dense-100 QUIXI_PERF_REPORT=dense-gc-baseline node perf/documents/run.mjs
```

The flag is accepted only for Chromium, heap observation enabled, and a single `dense-100` case. It uses the same hash-verified 890,653-byte source and genuine managed persistence pipeline. Production `persistPdfDocument` already awaits its `onProgress` callback. The harness pauses that callback after durable index credit for pages **1, 10, 50 and 100**, without changing production code or retaining page text/maps. It records only page, current/total UTF-16 counts, indexed page and elapsed time. Normal PDF worker teardown still occurs after completion.

At each pause the observer drains any admitted periodic samples, admits exactly one named PDF.js parser target, and records its target URL and isolate ID. It enables the experimental HeapProfiler domain, reads `Runtime.getHeapUsage`, invokes the documented [HeapProfiler.collectGarbage](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-collectGarbage), reads heap usage again, and confirms the isolate ID is unchanged. The producer resumes only after this sequence resolves. HeapProfiler is disabled afterward. No heap snapshot, object graph or document text is captured. The official protocol documentation was checked on 2026-09-09.

Periodic heap sampling is suspended during each explicit collection, and skipped ticks are counted. Each ordinary CDP request has a 2-second deadline; the collection command has a 10-second deadline. There are at most four explicit collections, duplicate/unexpected checkpoint pages are refused, and unavailable/ambiguous parser attribution fails the diagnostic. A failed collection propagates through the awaited workflow so ordinary cancellation/error teardown can run; it is never relabeled as a completed checkpoint. The case retains the existing 20-minute external watchdog and process-close cleanup.

The before/after fields are isolate-wide observations, including separate backing-storage and embedder fields. A lower post-GC value indicates that this collection reclaimed memory; a growing post-GC value supports further investigation of data surviving collection. Neither is an object-retainer proof, a leak diagnosis, a peak, or a hard allocation bound. The paused producer still owns its active document/page state. Instrumentation, domain enabling, collection and pause time are included in the diagnostic's timing fields, which must not be compared as production throughput against the no-GC series. WebKit is not claimed here.

Pinned-source inspection found a candidate retained cache: PDF.js `Font.charsToGlyphs` caches glyph arrays by whole input string in a per-font map. The dense fixture has unique positioned lines across pages. The production extractor already calls per-page cleanup and destroys the task/workers at completion; this diagnostic does not change those calls. The measurements can qualify the retention hypothesis before a separately measured cleanup change. They cannot identify an exact retaining object without additional evidence.

## Baseline result

[dense-gc-baseline.json](results/dense-gc-baseline.json) finished at 2026-09-09T10:21:13.096Z, PASS with `sourceStable:true`. All four checkpoints use the same parser target and isolate. The 100-page document completes with 15.1 million UTF-16 characters, unchanged canonical/sync counts, no external requests/page errors, and both PDF workers terminated. There are no CDP observer errors. Exact harness sources are retained as `dense-gc-baseline-*.txt`; the report includes source/build fingerprints.

| Indexed page | Extracted UTF-16 | Before GC used heap, MiB | After GC used heap, MiB | After GC backing storage, MiB | GC command, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 151,000 | 4.66 | 3.77 | 2.37 | 4.22 |
| 10 | 1,510,000 | 15.48 | 13.55 | 2.37 | 5.51 |
| 50 | 7,550,000 | 65.71 | 56.10 | 2.37 | 23.00 |
| 100 | 15,100,000 | 120.29 | 109.29 | 2.37 | 24.57 |

The after-GC used values are exactly 3,955,268 /14,209,660 /58,826,104 /114,602,928 bytes. Backing storage is exactly 2,485,905 bytes at each checkpoint. The final collection reclaims approximately 11 MiB, but most of the growth remains. These measurements demonstrate that garbage awaiting the requested collection alone does not explain the observed growth. They support investigation of retained parser data; they do not prove the exact font-cache retainer or an unbounded leak. The producer is paused, but its current document state remains live.

A paired cleanup experiment must use the same original bytes and checkpoint protocol, retain its own runtime hash, and keep the no-GC performance series separate. The baseline remains unmodified. Produce the bounded, hash-bound comparison with:

```sh
node perf/documents/summarize-gc.mjs dense-gc-baseline
```

[dense-gc-summary.json](results/dense-gc-summary.json) records exact byte measurements, input-report hashes and the analysis-tool hash. A separate post-fix report can be supplied as a second argument after it completes.



## Paired public-cleanup result

[dense-gc-cleanup.json](results/dense-gc-cleanup.json) finished at 2026-09-09T10:27:26.586Z, PASS with `sourceStable:true`, using the exact same GC harness and original PDF bytes as the baseline. The production change awaits public `pdf.cleanup()` after the page's text stream is fully drained and per-page cleanup completes, before publishing the page-end event. No PDF.js distribution patch was added for this experiment. Both runs keep the same pinned parser-distribution hash; their extractor-worker source hashes differ and are retained in the summary.

| Indexed page | Baseline after-GC used heap, MiB | Public document cleanup after-GC used heap, MiB | Cleanup after-GC backing storage, MiB |
| --- | ---: | ---: | ---: |
| 1 | 3.77 | 2.68 | 2.12 |
| 10 | 13.55 | 2.99 | 2.12 |
| 50 | 56.10 | 3.11 | 2.12 |
| 100 | 109.29 | 3.17 | 2.12 |

Cleanup after-GC used values are exactly 2,807,264 /3,135,304 /3,261,000 /3,319,580 bytes. Backing storage remains 2,224,065 bytes at each checkpoint. The 100-page used value is about 97.1% lower than the baseline at the same checkpoint. There is still approximately 0.49 MiB growth between pages 1 and 100, so this is not a claim of constant memory or a general hard bound.

This paired experiment demonstrates that public document cleanup removes most of the retained growth for these admitted dense-text bytes. The official [PDFDocumentProxy.cleanup API](https://mozilla.github.io/pdf.js/api/draft/api.js.html) releases document resources in the main and worker contexts. It clears multiple caches; the result is consistent with shared-cache retention but **does not uniquely identify the per-font string cache as the sole retainer**. No heap object graph was captured. Production source already kept page-level cleanup and final task destruction, and the new document cleanup is tested separately for correctness by the root's parser/layout/persistence/native suites.

All 100 pages complete with 15.1 million UTF-16 characters, unchanged canonical/sync counts and both PDF workers terminated. The four collections and target/isolate checks pass without observer errors. Collection commands take approximately 3.9/17.2/4.2/4.6 ms. The reported 96.5 s total includes pauses and GC and is **not a production throughput comparison**. Exact post-fix GC harness snapshots are retained as `dense-gc-cleanup-*.txt`.

```sh
node perf/documents/summarize-gc.mjs dense-gc-baseline dense-gc-cleanup
```

A separate no-GC eight-case replay uses the exact saved pre-GC `dense-production` harness, keeping the dormant new GC callback out of that performance comparison. It has its own report and source-stability check. After that replay, the current GC-capable harness is restored from verified saved bytes; both historical harness versions remain reviewable.

## Multi-isolate and thousand-page captures

The diagnostic now collects every identified live isolate at each checkpoint, not only the parser, and accepts the real 1,000-page fixture with checkpoints at indexed pages 1, 100, 500 and 1,000. Both captures use the current production sources with `sourceStable:true`; Chromium is launched with a local remote-debugging port for any forced-GC case.

```sh
QUIXI_TEST_BROWSERS=chromium QUIXI_PERF_GC=on QUIXI_PERF_CASES=dense-100 QUIXI_PERF_REPORT=dense-gc-isolates node perf/documents/run.mjs
QUIXI_TEST_BROWSERS=chromium QUIXI_PERF_GC=on QUIXI_PERF_CASES=1000 QUIXI_PERF_REPORT=gc-pages-1000 node perf/documents/run.mjs
QUIXI_GC_SUMMARY=gc-isolates-summary node perf/documents/summarize-gc.mjs dense-gc-isolates gc-pages-1000
```

[dense-gc-isolates.json](results/dense-gc-isolates.json) (dense 100 pages, 15.1 million UTF-16 characters, 93.7 s including pauses) after-GC used heap in MiB:

| Indexed page | Extracted UTF-16 | PDF.js parser | Document extractor | Storage worker | Page |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 151,000 | 2.68 | 1.36 | 2.65 | 1.73 |
| 10 | 1,510,000 | 2.99 | 1.05 | 2.96 | 1.80 |
| 50 | 7,550,000 | 3.11 | 1.08 | 3.04 | 1.86 |
| 100 | 15,100,000 | 3.17 | 1.13 | 3.05 | 1.90 |

[gc-pages-1000.json](results/gc-pages-1000.json) (the real 1,000-page fixture, 161,893 UTF-16 characters, 36.1 s including pauses):

| Indexed page | Extracted UTF-16 | PDF.js parser | Document extractor | Storage worker | Page |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 160 | 3.59 | 0.99 | 2.49 | 1.68 |
| 100 | 16,092 | 4.14 | 1.15 | 2.85 | 1.79 |
| 500 | 80,892 | 4.44 | 1.35 | 2.98 | 1.86 |
| 1,000 | 161,893 | 4.83 | 1.62 | 3.03 | 1.93 |

[gc-isolates-summary.json](results/gc-isolates-summary.json) binds both reports by hash and records the exact byte values. Across a hundredfold growth in extracted text and a thousandfold growth in page count, every isolate's post-collection heap stays in the low megabytes: the dense parser grows by about 0.49 MiB from page 1 to 100 and the thousand-page parser by about 1.24 MiB from page 1 to 1,000, roughly 1.3 KiB per page, while the extractor, storage worker and page isolates move by less than a megabyte. This supports the plan 14 criterion that working memory follows bounded page/chunk working sets rather than document size. It is not a hard bound: browser-tree RSS peaks (833,072 and 910,096 KiB) include the whole sampled browser process tree, WebKit exposes no isolate heaps, no native host was measured, and the PDF.js whole-source buffer noted in [ADR 0014](../../docs/decisions/0014-local-document-extraction.md) remains bounded only by the 32 MiB import cap.
