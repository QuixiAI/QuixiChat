# 0014 — Isolate PDF.js extraction and preserve source coordinates

Status: accepted; isolated parser, production PDF persistence/search and shared document UI implemented. Plan 14 layout, memory, scale and native-host qualification remain open.

## Product requirement

[Plan 14](../plans/14_extract_and_search_documents.md) and product [83](../product.md#83-pdf-implementation-boundary) delegate PDF internals to PDF.js. Product [85–89](../product.md#85-pdf-memory-rule) require bounded page processing and downstream backpressure. Product [49–50](../product.md#49-document-chunking) require the shared document/conversation chunker; extraction must work without inference. [114](../product.md#114-pdf-stress-tests) requires actual PDF stress evidence.

## Decision

Pin Mozilla's [PDF.js 6.3.289 release](https://github.com/mozilla/pdf.js/releases/tag/v6.3.289), Apache-2.0, build `1c8020a7d`; `pdfjs-dist` declares Node `>=22.13.0 || >=24`. The package lock pins distribution integrity. [The distribution verifier](../../packages/documents/tests/verify-distribution.mjs) checks exact display/parser SHA-256 hashes, all 182 registered local CMaps/fonts, and all 15 original fixture hashes.

The package-local [contract](../../packages/documents/src/contracts.ts) admits one extraction per realm and preserves attachment UUID/hash, extractor version, PDF page/text-item/UTF-16 spans and geometry. Generated separators are distinguishable from source text. Plain UTF-8 text additionally preserves exact original byte spans. PDF compressed byte offsets are deliberately absent. A bounded normalized event stream feeds the existing shared chunker through durable published pages; it does not establish a second chunk/token policy.

The display/conductor and parser run in two separately owned real workers connected by a MessagePort. The pinned runtime supports this port, although its generated declaration incorrectly infers a null-only port parameter; one documented type suppression is covered by actual browser execution. PDF.js provides [range transport](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFDataRangeTransport.html), [streamed page text and cleanup](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFPageProxy.html), and [worker lifetime controls](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib-PDFWorker.html). Pulling one event grants one output credit. Cancellation/watchdog/iterator return terminates both owned workers, including a deliberately stalled parser step.

Source metadata/options/readRange binding are captured before asynchronous verification. The initial SHA-256 pass reads at most 64 KiB at a time. The callback contract still requires immutable bytes throughout parsing: a hash pass is not a TOCTOU defense against a mutable source callback. The production storage integration supplies an already verified pinned blob lease. Neither original bytes nor application history are mutated by this proof.

Only compile-time registered local CMap/font URLs reach the conductor's private fetch reference, with omitted credentials and rejected redirects. Worker network globals and dynamic eval/Function globals are disabled. Worker HTTP responses carry CSP without JavaScript `unsafe-eval`. Extraction never calls rendering, embedded scripting/actions, annotations, XFA, or document-provided URL APIs. The [official initialization options](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) document custom range loading, disabling streaming/prefetch together, custom binary asset factories, and disabling worker fetch/WASM. `isEvalSupported` is absent from this pinned version; setting a removed option would not establish an execution boundary.

## Explicit limits and memory exception

### Page-local structural normalization

[`quixi-layout-2`](../../packages/documents/src/layout.ts) retains only the
current admitted page's text items and geometry. It groups horizontal baselines,
sorts each row, and tests 64 fixed gutter positions for repeated substantial
prose on both sides. A supported two-column region is read down the left column
then the right, with spanning rows separating regions. Short table cells remain
row-associated and receive generated tab separators. Baseline/font changes
preserve block breaks; local monospace positioning restores indentation without
inventing source characters. The input and generated separators share the
262,144-UTF-16 page cap. Gutter discovery is bounded by 64 times the admitted
item count; it performs no all-pairs page geometry comparison.

Every copied text piece retains its exact original PDF.js item index, substring
and transform. Reordered indices need not be monotonic. Whitespace reconstructed
from layout has a null source. Output remains one at-most-4,096-unit event per
consumer credit. This does not collect the full document or introduce a second
chunker. Changed normalizer identity starts a new derived run; an abandoned
older-version working run is interrupted under the exclusive producer lease,
and its published pages remain until replacement page one commits.

Mixed rotated/skewed or non-LTR text retains source order and produces an explicit
layout outcome. These cases are not claimed as reconstructed visual reading
order. Geometry heuristics are conservative and do not establish arbitrary
multi-column or international-layout support. [Independent browser acceptance](../../packages/documents/tests/layout-browser/README.md)
uses authored fixtures and a separate raw PDF.js worker to verify full source
coverage, exact item spans/geometry, column/block order, tables, code/list
indentation and rotated-text fallback. Both browser engines pass all five pages;
RTL requires a separately pinned font and language-specific oracle.

Persist the page assessment separately from scanned/text classification. The
[compatible schema2 upgrade](../../packages/storage/tests/extraction-layout/README.md)
adds a bounded metadata table only after verifying the exact v1 schema and ledger,
then commits DDL and the new ledger in one transaction. It preserves old page,
map, checkpoint and receipt bytes. Legacy publications return `layout:null`;
supplied assessments are included in a new page source-digest recipe, so deleted
or altered metadata cannot silently become a legacy outcome. Metadata consumes
the existing logical page/run budget and is reclaimed with obsolete pages.
Historical mutation retries never receive an invented optional field. The UI
shows the stored fallback notice on any bounded text window, including after
restart. Ten actual v1 compatibility/failure tests, browser page/navigation
acceptance and native process-restart checks support this change.

The subsequent [storage workflow](../../packages/documents/src/persist.ts) now
supplies a verified pinned original-source lease through public StorageClient
read/slice transfers. Parser events are coalesced into at most 4,096 UTF-16 units,
128 source spans and a 32 KiB request; text and map hashes advance incrementally.
Durable page publication precedes shared FTS indexing, and the producer waits for
that exact page's visible head before granting the next parser page. Resuming
checks published-page references and indexing credit one page at a time. A
per-archive/document Web Lock remains held through parser teardown, interruption
checkpoint and pin cleanup, even after cancellation. Operation claims and lost
reply handling follow [ADR 0015](0015-durable-derived-operation-claims.md).
[Actual browser evidence](../../packages/documents/tests/persistence-browser/README.md)
covers early FTS, concurrent chat, cancellation/resume and complete 100-page
persistence across process restart. These checks do not establish the parser's
peak-memory bound below or complete product document UI.

The proof caps original source length at 32 MiB, PDFs at 1,000 pages, each PDF page at 10,000 items/262,144 output UTF-16 units, and text batches at 4,096 UTF-16 units. There is one page in flight and one output credit. Source reads are at most four 64 KiB reads; each complete PDF range response is at most 1 MiB, with at most four admitted groups. The transport patch below splits larger groups sequentially. Supplemental assets have four read admissions and a 1 MiB limit each. A pending parser/read step has a maximum 30-second watchdog; idle downstream consumers do not trigger it.

### Measured range-transport correction

The [production performance baseline](../../perf/documents/README.md) exposed a
valid 31,115,264-byte image-heavy PDF that both browsers rejected: PDF.js grouped
adjacent missing chunks into a range larger than the conductor's 1 MiB budget.
Its pinned display transport retires a range reader after one complete response,
so sending partial `onDataRange` replies is not a valid fix. Upstream
[`ChunkedStreamManager.sendRequest`](https://raw.githubusercontent.com/mozilla/pdf.js/v6.3.289/src/core/chunked_stream.js)
also assembles every reply in that group before publishing it into its source buffer.

Apply a narrow [transport scheduling patch](../../packages/documents/tooling/pdfjs-range-patch.mjs)
at npm install: split a grouped request into sequential complete requests of at
most 1 MiB, preserving the upstream response assembly and chunk completion logic.
Check abort before each next request and propagate the original read failure.
Keep the existing conductor admission, source size and I/O bounds. No PDF object,
xref, font, encryption or compressed-stream decoding code changes. The extraction
output version stays unchanged because only source delivery scheduling changes;
the parser label and distribution digest identify the modified runtime.

Installation verifies upstream SHA-256
`f2870db902eaff8397442c912b69459980ac91f6f4b5ed827167b12cf7057930`
and patched SHA-256
`5de8099723be073084ade9e371597083efa230d74e199c7f5fc1fdd675cf2671`.
It is idempotent and refuses unknown bytes. The original Apache notice is retained
and a modification comment identifies the patch. Four transport checks execute
the installed methods for a near-cap byte-exact response, abort, failure and
installation integrity. Real browser image compatibility and total parser memory
remain separate qualification requirements; splitting transport does not remove
the upstream full-source allocation or bound decompression.

**Product 85's memory criterion is now evidenced for heap working sets, with one bounded exception.** The [multi-isolate forced-GC captures](../../perf/documents/GC.md#multi-isolate-and-thousand-page-captures) keep every parser, extractor, storage-worker and page isolate under about 5 MiB after collection across the dense 100-page and real 1,000-page fixtures in Chromium. The exception is the whole-source buffer described next, bounded by the 32 MiB import cap rather than by page working sets. The [exact pinned ChunkedStream source](https://raw.githubusercontent.com/mozilla/pdf.js/v6.3.289/src/core/chunked_stream.js) allocates `Uint8Array(length)` for the entire PDF. Range transport limits application I/O, not that parser buffer, caches, or an individual parser-internal text batch before validation. Compressed content can expand beyond source size before application output checks; a worker watchdog does not impose a hard memory limit. The 32 MiB cap is an explicit initial compatibility limit. Larger-source support requires measured parser behavior/changes or a separately reviewed strategy, not removal of this cap.

### Measured shared-parser cache cleanup

The [dense workload](../../perf/documents/DENSE.md) exposed parser-isolate growth
despite `PDFPageProxy.cleanup()` after every page. In the pinned source that
method clears display objects, while translated fonts and other parser caches
remain shared across pages. `Font.charsToGlyphs` caches whole input strings and
their glyph arrays, making it a plausible source of retained dense-page data.
An explicit [GC diagnostic](../../perf/documents/GC.md) found post-collection parser
heap growing from 3.77 MiB after page one to 109.29 MiB after page 100.

Await public [`PDFDocumentProxy.cleanup()`](https://mozilla.github.io/pdf.js/api/draft/api.js.html)
after each drained page text stream and page cleanup, before emitting `page-end`.
That API releases resources in both parser and display contexts. No rendering or
next-page extraction is active at this boundary. A cleanup failure prevents the
page-end checkpoint and goes through ordinary task/worker teardown. Failed page
parsing still uses the existing `finally` cleanup and task destruction.

The paired diagnostic, with the same source and observer, keeps post-GC parser
heap at 2.68/2.99/3.11/3.17 MiB after pages 1/10/50/100. This demonstrates cleanup
effectiveness for the measured workload. Cleanup clears several shared caches,
so the experiment does not identify a unique retaining object. It also does not
bound arbitrary compressed content, full-source allocation, or other hosts.
No forced GC runs in the product. Extraction/normalization identity is unchanged:
the parser, authored layout oracle, durable persistence, UI and native restart
checks pass with unchanged text/source behavior. Separately retained no-GC
measurements quantify cache-reloading costs without treating diagnostic timing
as production throughput.

The paired no-GC capture changes only the production worker source. All eight
cases preserve output/page/source-span/batch counts and complete normally. At
100 dense pages, Chromium sampled parser heap falls from 133.69 to 34.59 MiB;
these are sampled highs, not peaks or live-memory bounds. Elapsed time changes
from 100.486 to 102.706 seconds in Chromium and 74.448 to 93.890 seconds in
WebKit; foreground-read p95 changes from 26.7 to 29.3 ms and 19 to 36 ms.
Retain this measured tradeoff: release shared caches at every page boundary,
and investigate staging/index-credit and resource-reloading costs separately.
Single captures do not establish stable throughput regressions across hosts;
WebKit parser heap remains unavailable.

## Actual evidence

Run `npm test --workspace @quixi/documents` after `npm ci` and installation of the selected Playwright browsers. The runner builds production assets and serves real immutable PDF/text bytes with range responses. [The retained report](../../packages/documents/tests/results/extraction-browser.json) records 24 checks per engine on macOS arm64, exact parser/source hashes, selected engines, user agents, limits, timings, and process-tree RSS samples.

Both Chromium and Playwright WebKit extract 1/100/1,000-page PDFs, synthetic columns/table/code text, original item/layout mappings, a real image-only page, and strict UTF-8 including BOM and split multibyte/surrogate boundaries. Checks cover malformed/encrypted PDFs, invalid UTF-8, page-count/text-cap rejection, source limit/hash/type/UUID validation, downstream backpressure and one-job admission, cancellation, page-boundary resume, worker watchdog termination, source rejection cleanup, and asynchronous caller mutation of descriptor/options/reader. There are no external requests and no workers left active at completion. The action-bearing fixture is never evaluated or navigated.

Observed source reads stayed at 64 KiB with two in flight. RSS is sampled every 200 ms over the browser-server descendant process tree and per document; this includes shared pages, excludes reparented/OS-managed processes, and is not isolated parser heap accounting. These small synthetic PDFs and sequential browser samples do not prove near-cap/image-heavy memory safety or page-count-independent memory. Browser WebKit evidence is not installed Safari or Tauri evidence.

## Reviewed extraction recovery

Render interrupted-run guidance from the durable `failure` reason as well as the
transient operation alert. Opening another view or restarting clears transient
errors but must not erase why a PDF stopped. Known reasons map to bounded product
messages; unknown reasons receive a generic interrupted explanation. Parser,
password, source and capacity failures offer an explicit retry; cancellation and
confirmed producer loss retain Resume. Reopening never starts work, and password
failures explain that an unlocked copy is needed without promising password entry.
Sixteen actual browser groups per engine cover failure restart, explicit retry,
reviewed clear, over-limit admission and unchanged originals. This outcome evidence
does not close the separate parser-memory criterion.

`clearStoredPdfExtraction` captures the reviewed document/run/revision before any
await, uses the per-document producer lease, and delegates the fenced derived
mutation to the Storage Worker. The original attachment and canonical history are
preserved. The shared UI clears displayed references before dispatch, retains an
uncertain operation's exact ID/digest, and prevents page reads while a clear is
pending. Receipt recovery may confirm a committed result after cancellation;
same-ID replay reacquires producer exclusion and honors Stop before dispatch.
Archive selection changes forbid replay through the old facade and use retained
read-only receipt recovery. Clearing enables explicit extraction from page one;
it does not silently create replacement work or repair an unknown derived schema.

The [shared document acceptance](../../packages/app/src/features/documents/tests/browser/README.md)
records real confirmation/cancellation, original-byte equality, stale-hit refusal
and a fresh run's early FTS in both browser engines. Controlled helper/controller
tests add exact uncertain outcomes, stale review, producer contention, view
exclusion and cancellation during recovery. General archive diagnosis/repair
belongs to plan 23.

## Remaining gates

- Qualify the implemented immutable storage range leases, cancellation, checkpoints and source/version fences across the remaining supported native hosts and failure matrix.
- Broaden qualification of the implemented page-local heading/paragraph/list/code/column/table normalization and shared FTS mappings. Tokenizer-specific embedding limits remain separate.
- Extend the [implemented shared document UI](../../packages/app/src/features/documents/tests/browser/README.md) with varied-layout source navigation and complete accessibility/host acceptance. Progress, early lexical availability and explicit failure/resume are tested with real persistence and FTS.
- Qualify near-32-MiB files, image-heavy and varied international/font/layout PDFs, parser heap/cache behavior, release memory, and actual desktop worker/CSP/asset behavior. Larger sources remain rejected.
- Add a reviewed password UX only if desired; no passwords are currently accepted or retained. Low-text pages report `possible_scanned`; OCR remains plan 15.

CI integration is root-owned. The package test command requires no fixture-generation Python dependencies. Preserve `packages/documents/tests/results/extraction-browser.json`; `packages/documents/tests/dist/` is disposable build output. A single-engine CI report must retain its selected-engine metadata rather than implying cross-engine validation.

## Distribution and fixture licenses

The [retained provenance manifest](../../packages/documents/third-party/manifest.json) identifies the exact official npm tarball/integrity and every local CMap/font hash and license. Full upstream notices are retained under `packages/documents/third-party/` and copied to proof and production web/desktop build output. PDF.js JavaScript is Apache-2.0; Adobe CMaps and PDFium/Foxit fonts have separate redistribution notices. The bundled LiberationSans TTFs carry the upstream **GPL v2 with font exceptions** text. Parser licensing does not replace font licensing; production distribution/license and corresponding font-source requirements remain a release review gate.

Test-only fixture tools are ReportLab 5.0.1 (BSD notice), pypdf 6.18.0 (BSD-3-Clause), Pillow 12.3.0 (MIT-CMU), and charset-normalizer 3.4.7 (MIT), with exact retained notice hashes. No tool code ships in the browser extraction bundle. The generator emits only synthetic documents; the exact resulting PDF/text bytes are checked against their manifest. Encrypted fixture regeneration is intentionally followed by manifest/report refresh because encryption metadata may vary.

## Persistence/shared-FTS implementation

The [original package contract proposal](../../packages/documents/docs/persistence-contract-proposal.md) informed independent derived extraction tables, bounded text/map staging, atomic page/checkpoint publication, exact retry receipts, writer/source/version fences, and bounded navigation back to original PDF items. It proposes one bounded published page source for the existing shared chunker, with a durable FTS publication outbox and source-level dirtiness. It does not register arbitrary extraction events as separate search sources or invalidate all earlier pages whenever a later page completes.

The legacy private registration helper is insufficient for this path: its 65,536-character cap is below the extraction proof's page cap, its document-wide dirty revision would repeatedly hide earlier pages, and its table belongs to search repair. The proposed separate namespace preserves completed page text/maps/checkpoints across FTS rebuild without adding canonical/sync mutations. Initial admission waits for each page's lexical publication before advancing extraction, so early search is demonstrable and downstream failure applies backpressure.

The public extraction contracts, independent derived schema, production worker routes and shared search adapter now implement this path; [ADR 0015](0015-durable-derived-operation-claims.md) records durable operation identity. Real PDF workflow and shared UI proofs are separate from the earlier isolated parser report. The 32 MiB source cap and bounded retained-page/map budgets are enforced; parser peak memory and single-page finalization latency remain qualification gates.
