# @quixi/documents

Local text/PDF extraction and a production PDF storage workflow for [plan 14](../../docs/plans/14_extract_and_search_documents.md), using PDF.js **6.3.289**. The isolated parser accepts immutable sources; the public storage workflow persists page checkpoints and feeds shared FTS. The shared app owns canonical PDF import and document UI. Plan 14 remains in progress.

`extractDocument(source, options)` returns a pull-driven async iterator. The caller supplies an immutable source with a canonical attachment UUID, SHA-256, byte length, supported MIME type, and `readRange(offset, length, signal)`. Metadata, options, and the bound reader are captured when iteration starts, before any asynchronous operation. A source hash prepass verifies the original bytes with 64 KiB reads. **The reader must continue serving that same immutable byte snapshot during parsing.** Verification alone cannot prevent a mutable callback from changing bytes afterward. Production integration must use a pinned verified storage lease, not a mutable native file or changing URL.

Events preserve the original attachment/hash/extractor version. PDF text includes its 1-based page, original PDF.js text-item index, UTF-16 item span, and layout coordinates. PDF compressed-stream byte offsets are not invented. Generated separators and inferred indentation have `source: null`. Text/Markdown accepts strict UTF-8, preserves the BOM, and reports exact byte and UTF-16 spans, including across read and surrogate boundaries.

`quixi-layout-2` collects at most one admitted page, sorts horizontal rows,
recognizes a repeated gutter between substantial prose columns, preserves block
breaks and monospace indentation, and separates table cells. Source spans retain
their actual item indices even when reading order changes. Mixed rotated/skewed
or non-LTR text uses source order and exposes an explicit `page-end.layout`
outcome. This conservative heuristic does not establish arbitrary multi-column,
RTL or publication-perfect reconstruction. The [independent layout oracle](./tests/layout-browser/README.md)
checks actual PDF.js output against authored expectations and raw source items.

A `page-end` is the only safe page checkpoint boundary; discard unfinished current-page output on failure. `startPage` resumes from a caller-owned committed boundary only when the source hash and extractor version still match. The isolated iterator neither persists nor validates an external checkpoint; the storage workflow below validates and owns durable resume state. Text resume starts at its document boundary. `PASSWORD_REQUIRED`, `PARSE_FAILED`, `CAPACITY`, `INTEGRITY`, `SOURCE_FAILED`, `CANCELLED`, and `TIMEOUT` are explicit. Password entry/retention and OCR are absent; low useful PDF text produces `possible_scanned`.

Before each PDF `page-end`, the worker awaits public document cleanup as well as
page cleanup, after the text stream is fully drained. This releases shared parser
caches between pages. The [paired dense diagnostic](../../perf/documents/GC.md)
reduced 100-page post-GC parser heap from 109.29 to 3.17 MiB; GC is diagnostic-only
and never runs in the product. This measured correction does not establish a hard
parser allocation limit or qualify all PDFs/hosts.

## Bounds and worker lifetime

- One admitted job per JavaScript realm, with one conductor and one real PDF parser worker. The caller owns and terminates both on cancellation, timeout, iterator return, and completion. A 30-second maximum watchdog covers each pending parser step/read; downstream idle time consumes no parser credit.
- Source: **32 MiB maximum**; PDFs: **1,000 pages**, **10,000 items/page**, **262,144 normalized UTF-16 units/page**. Plain text streams under the source limit without the PDF page cap.
- Each `next()` grants one output event; text events contain at most **4,096 UTF-16 units**, without splitting surrogate pairs. No semantic tokenizer or embedding token policy is invented; model-specific token limits belong to the shared chunker/inference integration.
- At most four source reads of **64 KiB**. The pinned transport patch splits large PDF.js range groups into sequential complete responses of at most **1 MiB**. At most four groups are admitted; the conductor still refuses oversized responses or excess concurrency. Supplemental assets have four admissions and a **1 MiB** limit each.
- PDF.js `streamTextContent` can allocate its own batch/item before application bounds are checked. More importantly, the pinned parser's `ChunkedStream` allocates a **full-source-length buffer even with range loading**. Source/page caps bound this proof's admitted inputs; they do not establish archive-size-independent parser memory or the product's final memory requirement. Compressed content can expand into larger intermediate allocations before output checks; the watchdog is an elapsed-work limit, not a hard memory limit.

Only pinned local CMaps/fonts from the exact build-time registry can be fetched. Parser network APIs and both workers' dynamic eval/Function globals are disabled. No document URL, embedded action, scripting, annotation renderer, XFA renderer, image rendering, or WASM decoder is invoked. Serve worker scripts with a CSP excluding JavaScript `unsafe-eval`; the proof applies that header to worker responses as well as the page. Vite worker output must use `format: 'es'`, and proof assets are emitted as files (`assetsInlineLimit: 0`). No CDN or runtime parser download is used.

## Reproduce

From the repository root after `npm ci` and installation of the repository-pinned Playwright browsers:

```sh
npm test --workspace @quixi/documents
```

The root npm `postinstall` applies the [SHA-gated range transport patch](./tooling/pdfjs-range-patch.mjs).
It accepts only the pinned upstream parser or the exact already-patched artifact;
dependency drift fails installation. If lifecycle scripts were disabled, explicitly
run `npm run postinstall` before building. The distribution verifier checks the
patched hash; the range tests cover byte continuity, cancellation and read failure.
PDF object decoding and output normalization are unchanged by this transport patch.

Node must satisfy PDF.js's declared `>=22.13.0 || >=24` engine. The runner defaults to Chromium and WebKit; `QUIXI_TEST_BROWSERS=chromium`, `webkit`, or `chromium,webkit` explicitly selects engines. Invalid/empty/duplicate values fail before building. It builds production worker assets, serves synthetic immutable range fixtures on `127.0.0.1:4294`, and records actual browser execution in [tests/results/extraction-browser.json](./tests/results/extraction-browser.json).

CI needs `npm ci`, `npx playwright install --with-deps chromium webkit` (or the selected engine), a free port 4294, and the normal system `ps` command for process-tree RSS sampling. Checked-in actual PDF/text fixtures require no Python at test time. To regenerate them intentionally, use the pinned test-only command in [tests/generate_fixtures.py](./tests/generate_fixtures.py); the manifest and retained report must then be refreshed together.

See [ADR 0014](../../docs/decisions/0014-local-document-extraction.md) for evidence and the remaining review gates.

## Third-party provenance

[third-party/manifest.json](./third-party/manifest.json) records the exact PDF.js npm tarball/integrity, all 182 asset SHA-256 hashes and their license files, and retained notices/hashes for fixture-generation tools. PDF.js JavaScript is Apache-2.0. Adobe CMaps and PDFium/Foxit fonts carry their own redistribution notices. The bundled LiberationSans fonts carry **GPL v2 with the exceptions in the upstream license**, not the parser's Apache license. Their full unmodified notices are retained in [third-party/](./third-party/) and copied into proof and production web/desktop builds. Production packaging must preserve these notices and review the actual font license/source-distribution requirements before release; this proof does not relicense the fonts.

The synthetic generator pins ReportLab 5.0.1 (BSD notice), pypdf 6.18.0 (BSD-3-Clause), Pillow 12.3.0 (MIT-CMU), and charset-normalizer 3.4.7 (MIT). Their notices are retained; these Python packages are test-only and absent from the browser bundle. The original fixture hashes are in `tests/fixtures/manifest.json`. ReportLab uses invariant output; encrypted pypdf output can change on intentional regeneration, so the resulting exact bytes and refreshed evidence manifest are the reproducibility record.

## Production PDF storage workflow

`@quixi/documents/storage` exports `persistPdfDocument`, `clearStoredPdfExtraction`, `openStoredPdfSource` and
the per-document producer lease. The workflow uses an injected, archive-pinned
StorageClient; it owns no SQLite connection. It preserves bounded page maps and
original attachment bytes, coalesces small parser events into storage batches,
and waits for each page's shared FTS head before pulling another page.

The [actual browser proof](tests/persistence-browser/README.md) covers real PDF.js
parsing, early search, concurrent chat, cancellation/resume, producer exclusion,
exact lost-reply recovery and process restart in Chromium and WebKit.
`npm run test:documents:persistence:browser` runs that suite from the repository
root. `npm run test:documents:storage` checks the source adapter with 15 controlled
client/lease tests; those tests alone do not establish OPFS behavior.

The PDF workflow retains exact pending write identities when both a reply and its
receipt are unavailable. Callers must preserve `PendingExtractionOperationError`
and reconcile that operation rather than silently issue a different write.
`clearStoredPdfExtraction` captures a reviewed document ID, run ID and document
revision, acquires the same exclusive producer lease, and clears only derived
text/search publication through a fenced Storage Worker mutation. Original PDF
bytes and canonical history remain intact. It retains exact uncertain operation
identity through cancellation and cleanup failures, and never closes the borrowed
client. The shared UI reviews this action before dispatch; subsequent extraction
is explicit and begins a new run from page one. The eight controlled helper tests
run with `npm run test:documents:clear`.
The [shared document UI](../app/src/features/documents/tests/browser/README.md) now imports originals, displays extraction progress and opens exact page references from search results. It shows bounded extracted text, not a visual PDF rendering. Plain-text byte-span persistence, varied-layout accuracy and parser peak-memory/release-scale qualification remain tracked in plan 14.

`npm run test:documents:mutation` checks exact retry identity through unknown replies, cancellation and later refusal. Once any dispatch is uncertain, a not-found status alone cannot erase that uncertainty; a later failure retains the original operation until its exact result is confirmed.
