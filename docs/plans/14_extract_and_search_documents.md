# 14 — Extract and search document text

**Status:** Complete — every task and acceptance criterion carries browser or macOS evidence, including bounded per-isolate memory across dense and thousand-page documents; release-scale, additional host and WebKit-heap qualification proceed under plan 24, and OCR remains deferred plan 15

**Workstream:** D1/D2 — bounded document processing

**Depends on:** [03](./03_build_storage_repositories.md), [07](./07_build_shared_chunks_and_fts.md)

## Outcome

Import and search text-bearing PDF attachments using PDF.js and the same SearchChunk/FTS pipeline as conversations, with bounded working memory.

## Product references

- [4. V1 semantic scope: text only](../product.md#4-v1-semantic-scope-text-only)
- [47. SearchChunk](../product.md#47-searchchunk)
- [49. Document chunking](../product.md#49-document-chunking)
- [50. Chunking strategy](../product.md#50-chunking-strategy)
- [83. PDF implementation boundary](../product.md#83-pdf-implementation-boundary)
- [84. PDF UX](../product.md#84-pdf-ux)
- [85. PDF memory rule](../product.md#85-pdf-memory-rule)
- [86. PDF pipeline](../product.md#86-pdf-pipeline)
- [87. PDF concurrency](../product.md#87-pdf-concurrency)
- [88. Structural normalization](../product.md#88-structural-normalization)
- [89. Backpressure](../product.md#89-backpressure)
- [91. Images](../product.md#91-images)
- [106. Track D — Documents](../product.md#106-track-d--documents)
- [114. PDF stress tests](../product.md#114-pdf-stress-tests)

## Tasks

- [x] Pin PDF.js and integrate its worker, parser, and asset requirements with web and Tauri builds. Keep PDF format internals delegated to PDF.js.
- [x] Implement bounded/range reads from attachment storage, one-page extraction, explicit page cleanup, cancellation, and progress reporting.
- [x] Normalize extracted layout into useful headings, paragraphs, lists, code, approximate tables, and page/source references without building a publication-quality Markdown renderer.
- [x] Feed normalized text into the shared chunker and commit searchable text promptly. Bound pending chunks and pause extraction when storage or downstream indexing falls behind.
- [x] Persist extraction status/checkpoints and define resume behavior after cancellation, crash, or parser failure. Handle malformed and encrypted documents with explicit user-facing outcomes.
- [x] Keep image attachments first-class and index available filenames, captions, descriptions, surrounding text, and metadata without generating image vectors.
- [x] Build document progress and result navigation, including page locations and separate lexical/semantic availability. Detect low-text/scanned PDFs and offer the optional OCR path only when implemented.
- [x] Create a varied PDF fixture set and measure memory versus page count, extraction throughput, cancellation, and time until FTS becomes useful. Measurements expose a remaining parser-memory acceptance gap below.

## Current evidence

The [isolated extraction package](../../packages/documents/README.md) pins PDF.js
6.3.289 and passes 24 actual browser checks per Chromium/WebKit, including
1/100/1,000-page PDFs, strict UTF-8/source spans, cancellation, page resume,
watchdogs, malformed/encrypted/scanned outcomes and immutable descriptor handling.
[ADR 0014](../decisions/0014-local-document-extraction.md) records the contract,
asset/license provenance and limitations. The 32 MiB source cap and page/output
bounds do not establish a bounded parser peak: PDF.js allocates a full-source
buffer and can allocate intermediate data before application checks. No storage,
shared-chunker/FTS, product UI or desktop integration is claimed by that isolated proof.

The subsequent [production persistence proof](../../packages/documents/tests/persistence-browser/README.md)
uses the actual PDF.js workers and managed StorageClient/SQLite WASM/OPFS path.
A real 100-page PDF publishes searchable page one before the remainder is pulled;
an awaited progress pause permits concurrent canonical chat writes. Cancellation
retains published page text/maps and exact original bytes, and resume starts at
page two. The complete 100-page extraction and a one-page document survive full
browser restart in Chromium and WebKit. The subsequent
[document UI acceptance](../../packages/app/src/features/documents/tests/browser/README.md)
exercises the production web host and shared app: PDF import, original-byte integrity,
early page-one search click-through, highlighted extracted text, stop/resume, page
navigation, full browser restart, and stale-result refusal. Encrypted, scanned
and malformed PDFs produce explicit outcomes. This displays bounded extracted page text; it is
not a visual PDF page renderer or a complete layout/memory qualification.

The UI controller retains exact uncertain import/extraction operations and blocks
replacement until their outcome is known. After an archive switch, explicit
recovery reads the original archive's receipts without replaying writes into the
selected archive. [Retained extraction acceptance](../../packages/storage/tests/retained-extraction/README.md)
checks exact claim/digest matching, missing/corrupt receipts, read-only behavior
and older schema absence. Controlled app tests cover navigation/progress races,
draining pending reads and matching recovery callbacks. Page-level low-text classification now survives bounded reads and browser restart,
including a scanned page with a real one-character footer. The shared recovery
controls now review and clear the exact derived run/revision, preserving the
original PDF and refusing a stale review. Explicit extraction then begins a new
run from page one. Thirteen actual browser UI groups per engine cover review
cancellation, confirmed clear, original-byte equality, stale-hit refusal and
new-run early search; 38 controlled app tests and eight clear-helper tests cover
exact uncertain operations, producer exclusion during clear/replay, archive changes,
pending-clear view exclusion and cancellation.
The subsequent sixteen-group browser acceptance also retains interruption guidance
after full restart. Encrypted, malformed, 1,001-page and over-budget text-page cases
keep their exact run/producer identity on reopen, retry only on explicit action,
refuse unpublished page navigation, and allow reviewed clear with byte-exact originals.
An oversized file selection fails before canonical document creation, and supported
imports remain usable afterward. Password entry and OCR are not claimed.
General damaged-archive diagnostics/repair remain in [plan 23](./23_build_diagnostics_and_recovery.md).
Broader layout qualification remains open.

The [production PDF performance harness](../../perf/documents/README.md) now
measures 1/100/1,000-page extraction, early FTS, concurrent foreground reads,
cancellation and a 31,115,264-byte image-heavy PDF. Its preserved baseline found
oversized PDF.js range requests and repeated global search scans. The
[page-credit correction](../../packages/storage/tests/search-performance/README.md)
removes those scans from explicit page credit while retaining exact source/head
fences and public status; its isolated SQLite measurement improved from 28.96 s
to 2.68 s for 1,000 pages. A SHA-gated PDF.js transport patch splits large range
groups into sequential complete responses within the existing 1 MiB limit.
The post-fix capture passes all ten browser cases, including the image-heavy PDF.
Observed 1,000-page totals are 54.9 s in Chromium and 30.7 s in WebKit; the report
retains load differences and smaller-case/foreground-tail regressions, so this is
diagnostic evidence rather than a controlled performance guarantee. Browser process
RSS is qualified evidence, not a parser heap bound; WebKit XPC processes fall
outside the descendant sample. These corrections do not close the memory gate.

The [dense native-text measurement](../../perf/documents/DENSE.md) passes eight
production cases across Chromium/WebKit, including 100 pages with 15.1 million
UTF-16 units, indexed-page cancellation and unchanged canonical/original identity.
It separates parser, extractor, storage and page isolates in Chromium. Parser
sampled heap grows from a 21.7 MiB high at ten pages to 133.7 MiB at 100; sampling
without forced GC does not distinguish retained caches from garbage awaiting
collection. WebKit parser heap remains unavailable. The 100-page elapsed times
are 100.486/74.448 seconds; stage/index credit dominate page final publication.
The subsequent [paired GC diagnostic](../../perf/documents/GC.md) confirmed
post-collection growth from 3.77 to 109.29 MiB across 1–100 pages. Awaiting public
document cleanup between drained pages now keeps the corresponding values at
2.68–3.17 MiB. Parser/layout, persistence, UI and actual macOS restart checks pass
with this change. It clears the observed shared-cache retention pattern. The subsequent
[multi-isolate captures](../../perf/documents/GC.md#multi-isolate-and-thousand-page-captures)
extend the diagnostic to the extractor, storage worker and page isolates and
to the real 1,000-page fixture: after collection, no isolate exceeds about
5 MiB at any checkpoint, dense parser growth is 0.49 MiB over 100 pages and
thousand-page parser growth 1.24 MiB over 1,000 pages. That closes the memory
criterion for Chromium; WebKit heaps and native memory stay unobserved.
The paired ordinary eight-case capture also passes with only the worker source
changed and matching numeric output/page/source-span/batch counts. Chromium's
100-page sampled parser heap high falls from 133.69 to 34.59 MiB. Elapsed time
increases by 2.2% in Chromium and 26.1% in WebKit in these single captures;
foreground-read p95 also increases. Those costs remain explicit performance
follow-up, alongside the unavailable WebKit parser-heap attribution.

Two subsequent storage optimizations preserve the existing operation and publication
fences. [Dense page-credit validation](../../packages/storage/tests/search-performance/README.md)
reuses a successful immutable source check only within one synchronous work segment;
every await/admission invalidates it, and publication independently rechecks the source.
Ten synthetic dense pages retain 380 chunks while reducing full checks from 1,120
to 230 and measured SQL calls from 14,628 to 4,838. Five focused credit tests and
the existing search/extraction/navigation regressions pass.
[Canonical staging serialization reuse](../../packages/storage/tests/extraction-performance/README.md)
retains exact pre-change request digests and receipt replay, including frozen v1
receipts and immutable argument snapshots. Its 3,800-operation Node capture changes
from 2.859 to 2.757 seconds with unchanged SQL counts; 56 compatibility and repository
checks pass. These are instrumented Node measurements, not browser speed guarantees.
The combined production changes also pass parser, persistence, document UI and
native restart checks.

The [actual Chromium/OPFS SQL diagnostic](../../perf/documents/sql/README.md) passes
one- and ten-page dense cases with unchanged output and stable source fingerprints.
Across 380 staging calls, archive COMMIT averages 3.22 ms (33.3% of the entire
guarded operation), selection-catalog SQL 0.283 ms and archive schema reads 0.126 ms.
The remaining guarded time includes locks, database/VFS lifecycle and JavaScript;
it is not isolated serialization CPU. This prioritizes durable write/commit and
maintenance/lifecycle investigation over speculative schema-check caching.
It changes no transaction boundaries or per-operation receipt semantics. The
[ordinary browser replay](../../perf/documents/STORAGE.md) subsequently passes all
eight dense and both near-cap image cases. Only the two storage sources differ
from the cleanup baseline; the exact executed harness and originals match. Dense
100-page totals change from 102.706 to 100.830 seconds in Chromium and 93.890 to
81.555 seconds in WebKit. Phase regressions, load differences and increased sampled
backing storage remain explicit; these single captures do not establish a stable
speedup. The 31,115,264-byte image-heavy source completes extraction in 18.686/12.111
seconds, preserving its original and native text. It does not decode image pixels
or establish a parser allocation bound.

The [bundled native proof](../../tests/hosts/document-proof/README.md) passes on
macOS 26.6.2 / WebKit 21624.5.1.11.3 with unchanged production CSP: actual local
workers/fonts, 1/100 pages, early FTS, cancellation/resume, original-byte checks
and a fresh-process restart. Its first hidden-window attempt timed out and is
preserved; the subsequent visible-window proof passed. This is functional macOS
qualification, not a promise for every native host or a parser memory bound.

`quixi-layout-2` now normalizes one bounded page at a time. An
[independent browser oracle](../../packages/documents/tests/layout-browser/README.md)
checks genuine interleaved columns, row-associated table cells, code/list
indentation, page boundaries and exact source item ranges/geometry. Both engines
pass five authored pages; rotated/non-LTR layouts retain source order with an
explicit parser outcome. The shared document UI passes sixteen check groups per browser,
including exact page2 column navigation, table/code preservation, and the durable
source-order warning after full restart. Native layout2/schema2 validation passes
19 write checks, 13 restart checks and cleanup, preserving exact page publication
identities, layout metadata and all six original PDF hashes. Ten
[compatible metadata upgrade checks](../../packages/storage/tests/extraction-layout/README.md)
preserve actual v1 pages/checkpoints/receipts, verify transactional DDL rollback,
refuse unknown schemas and bind supplied layout metadata into publication identity.
RTL font/language qualification remains open.

[Image filename search](../../packages/storage/tests/image-search/README.md) adds
separate filename chunks without changing description offsets or identities.
Missing image bytes retain available metadata. The
[strict conversation resolver](../../packages/storage/tests/conversation-search-navigation/README.md)
rejects stale source digests and hidden/wrong-owner parts. Seven
[shared UI checks per browser](../../packages/app/src/features/content/tests/search-browser/README.md)
open the exact matching part even beyond the first bounded parts page, keep
filename highlights separate from descriptions and preserve unsent drafts.

[Shared search acceptance](../../packages/storage/src/worker/search/README.md)
covers continuous Unicode/NUL page sources, page-specific FTS credit, atomic
publication outbox handling, exact source-current fences and independent repair.
[Public storage acceptance](../../packages/storage/tests/extraction-browser/README.md)
adds lost replies, global operation status, owner takeover and restart. Migration
10's [durable local claims](../decisions/0015-durable-derived-operation-claims.md)
preserve operation identity through derived repair. Plain UTF-8 extraction remains
an isolated parser capability; its byte-span persistence path still needs integration.

## Deliverables and interfaces

- Document extraction worker and structural normalizer in packages/documents.
- Searchable document/source mappings, resumable extraction state, and PDF fixtures/measurements.

## Acceptance criteria

- [x] PDF text is searchable before the entire file finishes processing and without enabling embeddings.
- [x] Peak memory follows bounded page/chunk working sets rather than total document text size. The [multi-isolate forced-GC captures](../../perf/documents/GC.md#multi-isolate-and-thousand-page-captures) hold every isolate's post-collection heap in the low megabytes across a hundredfold growth in extracted text and a thousandfold growth in page count in Chromium; the whole-source PDF.js buffer stays bounded by the 32 MiB import cap. WebKit isolate heaps and native host memory are not observable here and browser-tree RSS is not a heap bound.
- [x] Page/result navigation remains correct for multi-column text and imperfect structure recovery.
- [x] Large, malformed, encrypted, and image-heavy PDFs produce recoverable, explicit outcomes. Actual browser UI restart/retry/clear and large/image-heavy public-workflow evidence is recorded above; parser memory remains a separate open criterion.

## Boundaries and sequencing

Start with one page in flight and a small bounded downstream queue; increase concurrency only from measurements. OCR is plan 15 and semantic document integration is plan 21. Do not implement PDF object parsing or image embeddings.

[Back to the roadmap](./README.md)
