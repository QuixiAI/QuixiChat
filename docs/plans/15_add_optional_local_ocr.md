# 15 — Add optional local OCR

**Status:** Deferred — excluded from the current implementation goal by the user's 2026-09-08 instruction.

**Workstream:** D4 — optional document extension

**Depends on:** [14](./14_extract_and_search_documents.md)

## Outcome

Offer an explicit local OCR workflow for scanned PDFs while preserving the same bounded extraction, chunking, and search behavior as normal document text.

## Product references

- [4. V1 semantic scope: text only](../product.md#4-v1-semantic-scope-text-only)
- [83. PDF implementation boundary](../product.md#83-pdf-implementation-boundary)
- [85. PDF memory rule](../product.md#85-pdf-memory-rule)
- [89. Backpressure](../product.md#89-backpressure)
- [90. Scanned PDFs](../product.md#90-scanned-pdfs)
- [91. Images](../product.md#91-images)
- [106. Track D — Documents](../product.md#106-track-d--documents)
- [114. PDF stress tests](../product.md#114-pdf-stress-tests)
- [118. Explicit v1 non-goals](../product.md#118-explicit-v1-non-goals)

## Tasks

- [ ] Evaluate and select a local OCR engine based on supported languages, browser/WebView execution, artifact size, licensing, accuracy, and bounded memory. Record the selection and required downloadable assets.
- [ ] Add scanned/low-text detection and the Run OCR / Skip choice. Do not automatically download or execute OCR for every attachment.
- [ ] Implement one-page bounded rasterization, local recognition, text normalization, and immediate page/image cleanup.
- [ ] Feed OCR text into the shared SearchChunk/FTS pipeline with page provenance and an explicit OCR source type. Keep source images/blobs independently preserved.
- [ ] Implement progress, cancellation, pause/resume where supported, model/language-asset errors, and downstream backpressure.
- [ ] Prevent duplicate searchable text when an extraction/OCR run is retried or when a document has mixed native-text and scanned pages.

## Deliverables and interfaces

- Optional OCR worker integration, asset manifest, and explicit user controls.
- Scanned/mixed PDF fixtures with recognized-text source mappings and memory measurements.

## Acceptance criteria

- [ ] Users can decline OCR and continue using the document and the rest of Quixi.
- [ ] Recognized text is searchable and navigates to its source page; the page image itself is not embedded.
- [ ] Cancellation and retries clean up raster resources and do not duplicate chunks.
- [ ] OCR remains local and bounded on the supported host matrix.

## Boundaries and sequencing

This is optional and does not gate normal PDF support or the first local-first release. Semantic indexing of recognized text uses plan 21 when enabled; OCR is not visual semantic search.

[Back to the roadmap](./README.md)
