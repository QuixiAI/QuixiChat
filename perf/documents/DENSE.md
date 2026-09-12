# Dense native-text memory and persistence evidence

This diagnostic varies total extracted output while holding a dense page workload fixed. It uses the same production `persistPdfDocument`, managed worker-owned SQLite/OPFS client, PDF.js distribution, original blob upload, page publication and FTS credit path as the earlier performance runner. It does not establish a hard memory bound or complete Plan 14's memory acceptance.

`generate_dense_fixtures.py` creates deterministic PDFs using pinned ReportLab 5.0.1, pypdf 6.18.0, Pillow 12.3.0 and charset-normalizer 3.4.7. Sources are ignored generated files; `fixtures/dense-manifest.json` retains exact byte hashes, tool versions and pypdf verification. Each page has 1,000 positioned 150-character lines on a 2400×10000-point page, with no images. This synthetic geometry deliberately stresses text/map output rather than ordinary document appearance. Standard Helvetica is referenced, not embedded. Fixture content is CC0-1.0; dependency licenses are documented in the existing [document third-party manifest](../../packages/documents/third-party/manifest.json). This is not an OCR workload.

The 1/10/100-page sources are 9,801/89,848/890,653 bytes. Each contains 150,000 non-separator UTF-16 characters per page; pypdf reads 151,000 with separators. Production extraction must independently pass its item/page/output/resource validation. The runner verifies received source SHA/length against the manifest and requires 100–200k actual UTF-16 output per completed dense page. The source 32 MiB, page 10,000 items/262,144 UTF-16, run 256 MiB and archive 1 GiB logical admission limits remain the production limits. Logical admission is not a physical quota or parser allocation bound.

```sh
uv run --with reportlab==5.0.1 --with pypdf==6.18.0 --with pillow==12.3.0 --with charset-normalizer==3.4.7 python perf/documents/generate_dense_fixtures.py
npx tsc --noEmit -p perf/documents/tsconfig.json
QUIXI_TEST_BROWSERS=chromium QUIXI_PERF_CASES=dense-1,dense-10,dense-100,cancel-dense-100 QUIXI_PERF_REPORT=dense-chromium node perf/documents/run.mjs
QUIXI_TEST_BROWSERS=webkit QUIXI_PERF_CASES=dense-1,dense-10,dense-100,cancel-dense-100 QUIXI_PERF_REPORT=dense-webkit node perf/documents/run.mjs
```

The existing runner retains default five-case behavior. Dense cases are explicit selections. `QUIXI_PERF_HEAP=off` disables CDP sampling for an explicitly labeled observer control. Each case uses a fresh persistent profile and local port 0 origin; source upload is bounded and excluded from extraction timing. Each run has a 20-minute watchdog. Cancellation occurs after the first durable indexed page, requires an interrupted retained prefix, and checks both PDF workers terminated. Normal and cancellation cases check canonical/sync counts unchanged. Profiles are removed after browser shutdown. A crash stops that report, retains failure/source/build/RSS evidence and closes the context; it does not imply successful workflow cancellation/cleanup inside the crashed page.

## Heap observation method and limits

The official [Runtime.getHeapUsage documentation](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage) defines isolate-wide used/allocated JavaScript heap, embedder heap, and separate backing storage for array buffers/external strings. The tool is experimental. The runner retains the actual browser/CDP/V8 versions and raw returned fields. [Target.attachToTarget](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-attachToTarget) supports flattened sessions; [target discovery](https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setDiscoverTargets) supplies bounded target identities. These official sources were checked 2026-09-09.

Only local-origin page/worker targets are admitted (max 16). Names and built URLs distinguish the `quixi-pdf-parser` isolate, `quixi-document-extractor` isolate, unnamed archive worker, and main page. Archive attribution uses the fingerprinted built archive-worker URL; other unnamed workers stay labeled other. Isolate IDs are retained to expose accidental aliasing. The sampler uses documented flat CDP commands over a local browser WebSocket; it does not enable remote access outside loopback or change product code.

Sampling occurs every 500 ms, at most 2,400 retained samples per target with dropped counts and sampled high-water values. Each query has a 2-second deadline; overlapping ticks are skipped and counted. Worker startup is not paused; the first query waits 100 ms and may miss early allocations or short-lived workers. Sample reply latency is retained. The page's bounded numeric progress snapshot links elapsed times to current output/page/credit without retaining text/maps. Final publication retains page number, text length and elapsed request time. Per-isolate sample highs are **not summed** because they need not be simultaneous.

No GC is forced. Used heap samples can include unreachable objects awaiting GC. They are neither post-GC live heap nor exact peaks. Instrumentation itself changes scheduling/allocation;500 ms samples miss brief peaks and commands can wait behind busy execution. Backing storage is reported separately, with no claim that it includes every native/WASM/platform allocation. Source-size and total-output both grow in this fixture series. A plateau or growth in these samples alone cannot prove an archive-size-independent memory bound or establish causality.

WebKit has no equivalent CDP measurement here: heap is explicitly unavailable. Process-tree RSS excludes OS-managed/reparented processes by construction. The earlier macOS topology observation documented WebContent/GPU/Networking XPC processes outside that tree; this capture does not independently attribute their memory to each new case. Chromium descendant RSS includes multiple workers/processes and shared mappings; it is not parser heap or unique physical memory. The prior [RSS qualifications](README.md) still apply.

## Preserved observer qualification

[dense-small.json](results/dense-small.json) is a **failed** initial Chromium observer attempt: the renderer crashed before page output after CDP attached and evaluated JavaScript in newly starting PDF workers. It does not establish a PDF workload failure or OOM; sampled RSS did not show runaway growth. The exact failed harness sources are retained as `dense-small-*.txt`, and the report includes pre-run source/build fingerprints. That failed capture has no completed end-of-run source-stability claim.

[dense-control.json](results/dense-control.json) repeats one page with CDP disabled and succeeds. [dense-heap-retry.json](results/dense-heap-retry.json) uses target metadata instead of worker JavaScript evaluation, waits 100 ms before heap queries, and succeeds with all four separate isolate identities and no observer errors. This association justifies avoiding startup evaluation; it is not a diagnosed Chromium root cause. The one-page retry has only two parser samples and cannot qualify a peak memory bound.

## Completed production capture

[dense-production.json](results/dense-production.json) finished at 2026-09-09T10:12:44.485Z with all eight cases passed and `sourceStable:true`. The measurement host reported macOS 26.6.2, arm64 Apple M5 Max, 128 GiB RAM, Node 22.23.1; Chromium reported 153.0.8010.12 and V8 15.3.76.4. WebKit's actual user-agent is retained. One-minute load average was approximately 3.62 at start and 4.23 at end. Root browser/build work was paused during capture. These remain one repetition per case with instrumentation overhead, not comparative release benchmarks.

All completed dense pages contain **151,000 UTF-16 characters**, 2,000 staged provenance spans and 38 bounded stage calls. The highest referenced PDF text-item index is 999. The 100-page cases therefore persist 15.1 million characters, 200,000 spans and 3,800 FTS chunks. Each canonical/sync count remains unchanged; both tracked PDF workers terminate. No external requests or page errors occur. The original sources are admitted and still preserved; their compression means source bytes grow much less than output. This does not test image decompression or arbitrary font/layout complexity.

| Engine | Pages | Extracted UTF-16 | Total seconds | First indexed page, ms | Foreground p95 around publication, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1 | 151,000 | 0.824 | 813 | 19.7 |
| Chromium | 10 | 1,510,000 | 8.903 | 1,297 | 24.0 |
| Chromium | 100 | 15,100,000 | 100.486 | 1,033 | 26.7 |
| WebKit | 1 | 151,000 | 0.752 | 741 | 19 |
| WebKit | 10 | 1,510,000 | 5.901 | 765 | 18 |
| WebKit | 100 | 15,100,000 | 74.448 | 1,042 | 19 |

Foreground sample counts are 1/2/11 respectively, so the reported p95 is the maximum in these small samples. The 100-page cancellation cases stop after one indexed 151,000-character page and drain in 11.4 ms Chromium / 8 ms WebKit, retain that exact committed prefix, and terminate both workers. This does not measure interruption during an arbitrarily expensive PDF operation.

At 100 pages, Chromium spends 53.965s in 3,800 `stagePageText` requests,18.704s in 400 page-index-credit requests, and1.841s in 100 final-publication requests. WebKit totals 35.600s /8.291s /1.111s respectively. These are awaited public request durations, not isolated SQL CPU. Final-publication p95 is 22.7 ms / 16 ms. Total time grows faster than page count from 10 to 100 (11.29× Chromium,12.62× WebKit), warranting profiling of stage admission/journal/index costs as the derived run grows. Atomic final publication itself is a comparatively small fraction here.

The separate post-extraction observation finds 3,800 indexed chunks and zero pending sources in both100-page cases. Ten foreground reads have p95=4.3ms /4ms; two `searchStatus` calls take 24.0/26.1ms Chromium and 21/18ms WebKit. That bounded read window is outside extraction timing and does not isolate background maintenance CPU.

### Observed Chromium isolate growth

Values below are **sampled used-heap highs in MiB**, without forced GC; they are not summed. Parser sample counts are 2/19/201 for 1/10/100 pages. All captured isolates have distinct IDs, and the final observer records no target/query errors.

| Pages | PDF.js parser | Extraction worker | Archive storage worker | Main page | Parser backing-storage sampled high, MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 4.29 | 2.28 | 13.38 | 6.70 | 2.03 |
| 10 | 21.68 | 11.94 | 27.69 | 27.04 | 5.41 |
| 100 | 133.69 | 24.54 | 30.09 | 28.79 | 6.61 |

The 100-page parser trace moves from approximately 4.9MiB near startup to 20.6MiB at 10 s,73.2MiB at 40 s,100.0MiB at 70 s and123.6MiB near 100 s. Other worker/page traces repeatedly fall during normal execution and have much lower sampled highs. Chromium descendant RSS reaches 1,047,184 KiB (~1,023 MiB), from 463,232KiB before extraction; it includes the whole observed process tree and shared mappings. WebKit's ~112 MiB descendant figure has no independently identified parser/content-process ownership in this capture and is **not** comparable parser-inclusive memory evidence. The previously observed XPC attribution limitation remains open.

This evidence prioritizes **parser memory retention/GC diagnosis** before an output-size-independent memory claim. The existing production extractor already calls `page.cleanup()` in its per-page `finally`, followed by task/worker destruction at run end. A next controlled diagnostic should distinguish reachable PDF.js page caches from uncollected garbage (for example, explicitly labeled paused-after-page/forced-GC samples in a separate report), then measure any verified cleanup change against these preserved bytes. Merely adding another unmeasured cleanup call would not resolve this evidence. No leak or hard bound is established by current samples.

The second concrete follow-up is profiling the 3,800 bounded staging operations and 400 credit requests on this fixed dense workload, while preserving page atomicity, early indexing, source maps and foreground priority. A future optimization must retain original baseline/rejection reports and compare exact fixture/runtime versions. WebKit parser-inclusive memory attribution and worst-case parser allocation remain open.

Reproduce the bounded analysis (including report and analysis-tool hashes):

```sh
node perf/documents/summarize-dense.mjs dense-small dense-control dense-heap-retry dense-production
```

[dense-summary.json](results/dense-summary.json) retains numeric comparisons and per-isolate first/last/high samples. Exact final harness sources are saved as `dense-production-*.txt`; control snapshots remain separate. Source/build fingerprints in the report identify the measured runtime even after subsequent product work. The generated PDFs remain ignored, and previous short-page/image reports are unchanged.



The subsequent [separate forced-GC diagnostic](GC.md) tests whether parser growth survives collection; its paused/GC timings are not merged into this no-GC production series.


## No-GC replay after public document cleanup

[dense-cleanup-production.json](results/dense-cleanup-production.json) finished at 2026-09-09T10:31:52.229Z: all eight cases pass with `sourceStable:true`. Compared with `dense-production.json`, the **only captured source-hash difference** is `packages/documents/src/worker/index.ts`. The original no-GC runner, page harness and heap sampler were temporarily restored from verified baseline snapshots for this replay. Fixture hashes, parser distribution, core/storage source and all captured harness hashes match. The GC-capable harness was restored afterward only after verifying no intervening edits; both executed versions are retained as report-named source snapshots.

`compare-dense.mjs` checks equality of the bounded numeric output/page/map/batch fields, all published page numbers/text lengths, original byte lengths/hashes, indexed-through page, canonical/sync counts and terminated-worker counts. All eight cases match. The 100-page documents still have 15,100,000 UTF-16 characters, 200,000 staged spans, 3,800 stage batches, 151,000 characters and 2,000 spans per page, and highest referenced item index 999. This is numeric equivalence, not a full text/map byte-hash comparison; the separate correctness suites cover content/provenance behavior.

| Engine | Pages | Before total, seconds | Cleanup total, seconds | Observed change | Before→cleanup foreground p95, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chromium | 1 | 0.824 | 0.854 | +3.7% | 19.7→21.2 |
| Chromium | 10 | 8.903 | 9.908 | +11.3% | 24.0→55.4 |
| Chromium | 100 | 100.486 | 102.706 | +2.2% | 26.7→29.3 |
| WebKit | 1 | 0.752 | 1.034 | +37.5% | 19→26 |
| WebKit | 10 | 5.901 | 8.304 | +40.7% | 18→31 |
| WebKit | 100 | 74.448 | 93.890 | +26.1% | 19→36 |

The memory fix does **not** establish a throughput improvement. These regressions are retained, including the 10-page Chromium foreground tail (only two probes). The 100-page post-cleanup first indexed page appears at 1.104 s Chromium / 1.136 s WebKit; cancellation after the first indexed dense page drains in 14.3 ms / 12 ms (previously 11.4/8 ms). Worker cleanup, retained committed prefix and unchanged canonical history still pass.

At 100 pages, post-cleanup staging/credit/final-publication totals are 55.336/18.367/1.927s Chromium and 45.305/11.511/1.484s WebKit. Final-publication p95 becomes 26.2 ms / 28 ms, compared with 22.7/16 ms. All values include ordinary observer/request scheduling. Single repetitions do not isolate direct cleanup cost: recorded one-minute OS load changes from approximately 3.62–4.23 during the baseline to 4.63–6.26 during the replay. Some pre-extraction foreground reads also slow down (WebKit 10-page baseline median 3 ms versus 7 ms in the replay). This confounder does not erase the measured regression; repeated controlled samples would be needed to attribute its magnitude.

Without forced GC, the 100-page **parser sampled used-heap high** decreases from 140,187,808 bytes (133.69 MiB) to 36,270,508 bytes (34.59 MiB). That is a different quantity from the 3.17 MiB paused after-GC observation. Parser backing-storage sampled high increases from 6.61 MiB to 8.77 MiB. Ordinary main-page/storage/extractor used-heap highs are approximately 28.43/29.24/24.09 MiB. Chromium process-tree RSS sampled high changes from 1,047,184 KiB (~1,023 MiB) to 993,504 KiB (~970 MiB), with shared/native/platform attribution limitations unchanged. WebKit parser heap and parser-inclusive RSS remain unqualified.

The combined evidence supports retaining the cleanup fix for the measured shared-resource retention defect while separately investigating dense staging/index cost and repeating the observed WebKit timing regression under controlled load. It does not close worst-case PDF allocation, supported-host memory attribution, or complete Plan14 acceptance.

```sh
node perf/documents/compare-dense.mjs dense-production dense-cleanup-production
```

[dense-cleanup-comparison.json](results/dense-cleanup-comparison.json) includes exact input/report/tool hashes, sole source-difference path, all numeric-equivalence checks, original-source hashes, memory fields and before/after timings. Prior production/control/failed reports remain unchanged.
