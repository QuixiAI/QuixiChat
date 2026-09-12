# Ordinary replay of the two storage changes

This capture compares the combined extraction/search changes with the public-PDF-cleanup baseline. It uses the **exact saved `dense-cleanup-production` runner, page harness and heap sampler**, with forced GC and SQL instrumentation absent. The current GC/SQL-capable files are preserved with hashes before replacement and restored only after the ordinary dense and separate near-cap image captures finish. Historical reports remain unchanged.

The expected captured source differences are only:

- `packages/storage/src/worker/extraction/index.ts`
- `packages/storage/src/worker/search/index.ts`

`compare-storage.mjs` rejects other differences and checks the same bounded numeric output, page, span, batch and worker-teardown fields used in the previous paired replay. It also verifies original source hashes/lengths and published page-number/text-length sequences. This is numerical output/provenance equivalence, not a full content/map byte-hash proof. Root's correctness suites supply the complementary content/receipt/recovery coverage.

```sh
QUIXI_PERF_CASES=dense-1,dense-10,dense-100,cancel-dense-100 QUIXI_PERF_REPORT=dense-storage-production node perf/documents/run.mjs
node perf/documents/compare-storage.mjs dense-cleanup-production dense-storage-production
```

The report records single measurements per case, actual OS load, separate worker-isolate sampled heap and qualified process-tree RSS. Timings are ordinary no-GC/no-SQL-observer harness measurements; they still include periodic CDP heap observation and synthetic foreground probes. They do not establish statistical effect size, hard memory bounds or isolated SQL/CPU costs. Regressions remain visible.

The near-cap image cases use the existing deterministic 31,115,264-byte original (SHA-256 `3fec2fa189a9b2ac5f932ca2faf41594f5cdac49822f1f8def49fa894b32c54f`), approximately 29.7 MiB against the 32 MiB source cap. Native text extraction need not decode the image. These cases establish only the exercised source transfer/hash/parser path, not raster decompression or a hard parser-memory bound. They are retained separately from the dense comparison:

```sh
QUIXI_PERF_CASES=image QUIXI_PERF_REPORT=image-storage-production node perf/documents/run.mjs
```

## Completed dense replay

These timings describe the recorded source snapshots. Subsequent recovery UI work
changed the capacity-error wording in `packages/documents/src/worker/index.ts`;
the successful dense/image paths do not enter that error branch. The capture is
not presented as a fingerprint of that later source revision.

[dense-storage-production.json](results/dense-storage-production.json) finished at 2026-09-09T11:10:17.976Z: all eight cases PASS with `sourceStable:true`. Its only captured source-hash differences from the cleanup baseline are the two extraction/search files listed above. All other source hashes, original fixtures, parser distribution, root lockfile and exact executed harness hashes match.

The comparator passes all eight numeric-equivalence checks. Completed dense pages remain 151,000 UTF-16 characters with 2,000 provenance spans and 38 staging batches; the 100-page cases produce 15.1 million characters/200,000 spans, with the same published page/text-length sequences and highest referenced item index 999. Both workers terminate and canonical/sync counts remain unchanged. No external requests, page errors or heap-observer errors are recorded.

| Engine | Pages | Cleanup baseline, seconds | Two storage changes, seconds | Observed total change | Foreground p95 before→after, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1 | 0.854 | 0.849 | −0.7% | 21.2→21.0 |
| Chromium | 10 | 9.908 | 9.784 | −1.3% | 55.4→48.2 |
| Chromium | 100 | 102.706 | 100.830 | −1.8% | 29.3→25.5 |
| WebKit | 1 | 1.034 | 0.826 | −20.1% | 26→22 |
| WebKit | 10 | 8.304 | 6.628 | −20.2% | 31→21 |
| WebKit | 100 | 93.890 | 81.555 | −13.1% | 36→30 |

These are single observed comparisons, not controlled effect-size estimates. One-minute OS load ranges from approximately 4.63 to 6.26 in the cleanup baseline and 4.86 to 6.03 in this replay. Measurement order, caches, GC and other OS work remain confounders. Foreground sample counts are only 1/2/11 respectively, so p95 is the maximum in these small samples.

The 100-page first indexed page appears at 1.008 s Chromium and 1.121 s WebKit. Cancellation after the first committed/indexed dense page drains in 9.5 ms / 7 ms, compared with 14.3 ms / 12 ms in the cleanup baseline. This preserves exactly one page; it does not qualify cancellation latency inside every expensive parser operation.

### Residual costs and regressions

Chromium 100-page staging/credit/final-publication totals are 53.921/18.415/1.889s. WebKit totals 38.906/9.498/1.280s. Final-publication p95 is 23.9 ms / 24 ms. Browser staging and index admission remain substantial even where the private repository optimizations reduced their targeted work; the separate [SQL diagnostic](sql/README.md) shows meaningful commit and unisolated lifecycle/maintenance costs.

Not every phase improved. Chromium 10-page staging increases from 4.526 s to 4.682 s (~3.4%); one-page staging increases from 348.8 ms to 356.7 ms (~2.3%). Chromium 100-page index-credit time increases from 18.367 s to 18.415 s (~0.3%), and its 10-page final-publication p95 changes from 48.0 ms to 48.2 ms. These small measured regressions are preserved alongside lower overall totals. Raw before/after request distributions and phase metrics remain available, without declaring a stable regression or broad speedup.

The 100-page Chromium parser sampled used-heap high is 33,750,696 bytes (~32.19 MiB), versus 36,270,508 bytes (~34.59 MiB) in the cleanup baseline. Parser backing-storage sampled high increases from 9,193,902 bytes (~8.77 MiB) to 9,832,030 bytes (~9.38 MiB). Archive and extraction-worker sampled used highs also rise slightly (approximately 29.24→29.58 MiB and 24.09→25.18 MiB). These unsynchronized, no-GC sample highs remain variable observations, not live-heap or hard-bound measurements. WebKit parser memory attribution is still unavailable; no new claim follows from its descendant RSS.

[dense-storage-comparison.json](results/dense-storage-comparison.json) retains all eight before/after cases, source/report/tool hashes, exact expected source-difference paths, numeric-equivalence checks, regressions and load records. Executed harness snapshots use the `dense-storage-production-*.txt` prefix.

## Separate near-cap source result

[image-storage-production.json](results/image-storage-production.json) finished at 2026-09-09T11:11:45.600Z: both engines PASS with `sourceStable:true`. Its entire captured source map is identical to the dense replay's source map. It is separate source-size qualification, not part of the dense optimization comparison.

| Engine | Setup/upload, seconds | Extraction, seconds | First indexed page, seconds | Stored pages | Extracted UTF-16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 6.283 | 18.686 | 18.673 | 1 | 66 |
| WebKit | 3.611 | 12.111 | 12.102 | 1 | 66 |

Both use the same 31,115,264-byte original/hash stated above. Source setup and returned source chunks stay at most 65,536 bytes; reported source transfer bytes total 62,230,528 bytes per case. This counter is not a measure of all physical filesystem IO. Setup is excluded from extraction timing. The one-page native text is published and indexed, both parser workers terminate, canonical/sync counts remain unchanged, and no external requests/page errors occur. Full-source PDF.js allocation remains possible; image pixels are not rendered or claimed decoded.

Chromium's process-tree sampled RSS high is 819,200 KiB (800 MiB), which includes multiple workers/processes and shared mappings. WebKit's 115,200 KiB descendant sample lacks parser-inclusive attribution and cannot establish a comparative memory bound. No isolated heap observer is enabled for the image case in this frozen ordinary harness. Source-size admission success does not imply image-decompression safety or support for arbitrary near-cap PDFs.

The preservation manifest `results/storage-replay-harness-preservation.json` hashes the GC/SQL-capable files saved before both replays. Restore occurred after both reports were terminal and source-stable, with byte equality checked against the installed historical harness before replacement. Current diagnostic files match their preserved hashes; no newer edits were overwritten. The image report has its own `image-storage-production-*.txt` harness/generator snapshots. Earlier controls, failed captures and baselines remain unchanged.
