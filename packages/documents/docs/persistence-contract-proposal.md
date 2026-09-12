# Proposed PDF extraction persistence and shared FTS contract

Status: **proposal for root review; no storage/core/app implementation**. The completed extraction proof and its retained browser evidence are unchanged.

## Scope and existing evidence

Implement a qualified PDF vertical slice under the existing 32 MiB/1,000-page parser admission limits. The canonical `Document`, `Attachment`, and immutable original blob must already exist. Extracted page text, source maps, checkpoints, receipts, and search indexes are derived data; they introduce no canonical mutations or sync operations. Plain-text documents already use the existing `d:` blob source in SearchRepository. Preserve that streaming path; do not force a 32 MiB text file into one PDF-sized page or invent arbitrary text-event sources.

Product [85–89](../../../docs/product.md#85-pdf-memory-rule) require one page, shared chunks, and bounded backpressure; [49–50](../../../docs/product.md#49-document-chunking) prohibit a separate document chunking policy. The semantic workspace probe was attempted first and returned `Transport closed`; exact current source reads established the following:

- `SearchRepository.registerExtractedText` currently accepts one inline string of at most 65,536 UTF-16 units, then calls `dirty('document', documentId)`.
- `loadSource` exposes each registered `x:` row as a distinct chunker source. Registering every 4,096-character extraction event would break matches and Markdown structure spanning events.
- A document scope revision invalidates every page head. Publishing each new page through the existing helper would repeatedly hide and reindex completed pages.
- Search rebuild/repair owns `quixi_search_*`, including today's registration table. Durable extraction checkpoints/maps therefore need an independent derived namespace.

## Chosen first storage shape

Use independent, versioned `quixi_extract_*` tables in the existing storage-owner SQLite database, with an exact derived schema/checksum ledger. No new SQLite connection, canonical migration, canonical trigger, canonical blob entry, or native database is required. Canonical export continues to exclude this namespace.

Persist bounded staging text batches and source-map batches. At page end, assemble **only the current page**, at most 262,144 UTF-16 units, into one published inline page text row. The search source loader reads this bounded page once and passes successive fragments through the **same StructuralChunker instance** until that page ends. This is the smallest integration with the existing inline `Source.text` path. It avoids a new derived file/catalog lifetime protocol; a verified derived-text-blob option can be reviewed later if measurements justify it.

A page is a real semantic boundary. Event boundaries are transport boundaries only. Matches and Markdown syntax can span any number of extraction/staging events within the shared chunker's normal window and overlap policy. This does not promise phrase matching across distinct shared chunks or PDF pages.

Proposed tables:

| Table | Purpose and bounded keys |
| --- | --- |
| `quixi_extract_schema` | Exact private schema version/checksum. |
| `quixi_extract_runs` | Run UUID, immutable identity/version fingerprint, writer epoch, state, page count, contiguous completed checkpoint, visible-run generation, byte counters. |
| `quixi_extract_documents` | One selected visible run per canonical document, plus publication revision. |
| `quixi_extract_pages` | Page-attempt UUID, run/page number, state, sequence/counters, published text/hash/map hash/source digest, publication revision. Unique published `(run,page)`. |
| `quixi_extract_text_batches` | `(pageAttemptId, sequence)`, bounded text and cumulative UTF-16 offsets. Only current/abandoned staging or cleanup backlog. |
| `quixi_extract_map_batches` | `(pageAttemptId, sequence)`, bounded serialized maps and indexed output range. Published rows remain immutable. |
| `quixi_extract_operations` | Global operation UUID, request kind/digest, scope, compact original receipt. No raw source or duplicate staged text in receipts. |
| `quixi_extract_publications` | Durable monotonic outbox for source dirtiness/run-switch indexing; page publication survives unavailable search schema. |

A page's map rows and text become readable together by changing its parent state to `published` in one transaction. Do not move or copy all maps at publication. Remove now-redundant staging text later in bounded maintenance slices; map rows remain associated with their published page. No `GROUP_CONCAT`/whole-document text, whole-map array, whole-document Markdown, or all-chunk collection is permitted.

## Package-level route proposal

The names below are proposed StorageClient operations, **not exports or implemented methods**. All IDs are canonical UUIDs; hashes are lowercase SHA-256. `operationId` is allocated before dispatch and reused after an unknown outcome. Versions are host-registered supported identifiers, at most 128 characters each.

```ts
type ExtractionIdentity = {
  documentId: UUID;
  attachmentId: UUID;
  attachmentSha256: SHA256;
  attachmentByteLength: number;
  extractorVersion: string;
  normalizerVersion: string;
};
type RunWrite = { operationId: UUID; runId: UUID; writerEpoch: number };
type PageWrite = RunWrite & { pageAttemptId: UUID };

beginDocumentExtraction({ operationId, identity: ExtractionIdentity }): RunStatus;
// runId = operationId. Original document/attachment must be current and available.

resumeDocumentExtraction({ operationId, runId, expectedWriterEpoch }): RunStatus;
// Explicit CAS claim: increments writer epoch and abandons only unfinished page work.

beginExtractionPage(RunWrite & { page: number; documentPageCount: number }): PageStatus;
// pageAttemptId = operationId; page must equal contiguousCompletedPage + 1.

stagePageText(PageWrite & {
  sequence: number; expectedUTF16Offset: number;
  text: string; spans: PageSourceSpan[];
}): { pageAttemptId; sequence; committedUTF16Offset; committedMapCount };

publishExtractionPage(PageWrite & {
  lastSequence: number; expectedUTF16Length: number;
  expectedTextSha256: SHA256; expectedMapSha256: SHA256;
  itemCount: number; classification: 'text' | 'possible_scanned';
}): { pageRef: PublishedPageRef; checkpoint: Checkpoint; publicationRevision: number };

completeDocumentExtraction(RunWrite): RunStatus;
interruptDocumentExtraction(RunWrite & {
  reason: 'user_cancelled' | 'parser_failed' | 'password_required' |
          'source_unavailable' | 'capacity' | 'confirmed_producer_loss';
}): RunStatus;

getDocumentExtraction({ documentId }): RunStatus | null;
getExtractionOperation({ operationId }):
  { status: 'not_found' } | { status: 'committed'; requestDigest; result: Receipt };

resolveDocumentSearchHit({ chunkId; expectedSearchRevision }): PublishedPageRef;
readExtractedPageText({ pageRef; startUTF16; maxUTF16 /* <= 16384 */ }): TextSlice;
readExtractedPageMap({ pageRef; startUTF16; endUTF16;
  page: { maxItems /* <= 128 */; maxBytes /* <= 65536 */; cursor } }): MapPage;

clearDocumentExtraction({ operationId; documentId; expectedVisibleRunId }): ClearReceipt;
```

`PublishedPageRef` binds document/run/page-attempt IDs, page number, original attachment hash, extractor/normalizer versions, derived source digest, and publication revision. `Checkpoint` binds the complete extraction identity and the last **contiguous committed page**. `RunStatus` returns bounded metadata: state, writer epoch, page count or null before the first parsed page header, current page/sequence counters, checkpoint, logical retained bytes, publication revision, indexed-through-page progress, and one bounded typed failure. It never returns all page IDs or page content.

Each page declares the parsed document page count. The first accepted page freezes that count; later pages must agree. Empty/low-text pages still have explicit begin/publish operations; `lastSequence = -1` identifies no text batches. Complete requires every declared page to have a published contiguous checkpoint. The existing extractor's `page-end` must have occurred before the producer requests publication; the storage API validates structure and fences, not the semantic truth of arbitrary caller-generated PDF text.

## Write validation, atomicity and retries

1. **Begin:** resolve the canonical document and its exact attachment, availability/hash/length/media type; accept PDF and registered extractor/normalizer versions. Bind archive namespace implicitly through StorageClient. The immutable storage read lease must hold the original verified bytes for the producer's lifetime; a hash prepass alone is insufficient for mutable callbacks.
2. **Stage:** validate the immutable run identity again, writer epoch, current page attempt, exact next sequence, exact cumulative offset, well-formed UTF-16, envelope byte budget, map coverage and cumulative page limits. A stage transaction inserts bounded text/maps, advances counters, and records its receipt. ACK only after commit. The producer retains at most one unacknowledged stage payload; the next extraction output credit waits when its bounded coalescer cannot accept another event.
3. **Map validation:** offsets are half-open and page-local in the proposed staging format. They cover each output code unit exactly, in order, including generated spans with `source: null`. PDF source spans retain original item index/UTF-16 range and finite geometry; copied source/output span lengths match in the first identity-plus-separators normalizer. Do not invent PDF byte offsets. Future reordering/structural normalization requires a new normalizer version and explicit map rules. Validate the final reported item count against mapped indices.
4. **Publish:** under the storage-owner's serial dispatcher, scan at most the admitted page's batch count in bounded reads, validate contiguous counters, hash text and maps, and retain only the bounded page string. Map hashing is over canonical individual spans in order, independent of transport grouping. Revalidate identity, writer epoch, attempt revision and expected digests before the commit. The transaction publishes text/maps, advances the contiguous checkpoint, appends the outbox record, and stores the exact receipt. If preparation must yield, persist a `finalizing` phase/cursor; it grants no output visibility or next-page credit. Measure the bounded single-page preparation before freezing whether one call or multiple finalization slices are needed.
5. **Receipt:** the same operation ID and exact request digest returns the **original receipt**, even if the page has since completed. A different payload/kind under that ID is `CONFLICT`. A new operation ID trying to reuse a committed sequence is also `CONFLICT`; do not treat it as a duplicate by content alone. Read current status separately from historical receipts. The root dispatcher must reserve extraction IDs through its cross-journal ID fences and operation-status routing before public integration. This must not add a canonical SQL trigger that depends on a repairable extraction table: root must select a stable operation-claim seam, or explicitly gate the public route until one exists.

UTF-16 counts must be validated in JavaScript and stored explicitly. SQLite `length(TEXT)` counts code points and stops at embedded NUL; it cannot enforce this contract. Preserve NUL/Unicode via the existing safe text extraction/`json_quote` conventions. Use explicit UTF-8 byte accounting for logical disk admission.

The derived source digest is a versioned hash of original attachment identity/hash, extractor/normalizer versions, page number, published text SHA-256, and source-map SHA-256. Store the plain text hash separately. This makes shared chunk IDs change when provenance changes even if output text happens to match; no model-specific tokenizer is involved.

## Initial limits and admission

| Boundary | Proposed initial limit |
| --- | --- |
| Active extraction producer | One per archive; one page attempt per run. Package-local one-per-realm bound remains additional. |
| Original PDF / pages | Existing 32 MiB / 1,000-page proof limits. |
| Published page text | 262,144 UTF-16 units, including generated separators. |
| Stage | 4,096 UTF-16 units, at most 128 spans, and at most 32 KiB serialized envelope; whichever fills first. |
| Whole page maps | At most 32,768 spans and 4 MiB serialized map bytes; these are explicit initial compatibility caps. |
| Staging page | At most 1,024 batches. Coalesce small extractor events by text/map/envelope bounds; do not persist each tiny event independently. |
| Source text read | At most 16,384 UTF-16 units; no surrogate split. |
| Map read | At most 128 spans and 64 KiB response, with revision-bound cursor. |
| FTS slice | Existing byte/work bounds, at most 4 chunk writes for extraction-driven admission. |
| Cleanup slice | At most 32 staging/map rows or 128 compact receipts, plus explicit byte/time budget. |
| Retained extraction payload | Proposed 256 MiB logical text/maps/staging/receipt budget per run and 1 GiB aggregate per archive; root review required. Both include retained old-run receipts. These are not physical SQLite/FTS disk quotas. |

The producer may advance to the next page only after publication **and the previous page's shared FTS publication or an explicit search-failed stop outcome**. Thus extraction cannot silently outrun indexing while search is unhealthy, and the first page can be searched while the rest of the PDF is paused. There are no queued semantic jobs in this slice. Foreground archive work may preempt either task; one retained verified source lease must be admitted through existing storage transfer accounting, not bypass its limits. If foreground work needs the held original-byte admission, abort and await producer/worker teardown before releasing that lease; reopen the immutable source and resume from the last committed page afterward. Never continue a parser using an unpinned or changed reader. A later design may permit a measured bounded backlog; that is not the initial contract.

Logical extraction quota exhaustion and actual `SQLITE_FULL`/OPFS quota failure return explicit capacity/storage outcomes without advancing the page checkpoint. Completed pages remain valid. Retried staging/abandoned work must be cleaned before admitting another page attempt so repeated interruptions cannot accumulate an unbounded partial-run backlog. Completed data can grow on disk under the configured budget; it is not collected in JavaScript.

## Shared FTS integration seams

Add a private extraction source adapter to SearchRepository rather than expose `registerExtractedText` as a public event sink:

```ts
interface PublishedExtractionSources {
  ready(): boolean;
  listVisiblePages(documentIdOrAll, afterPageKey, limit /* <= 32 */): PageKey[];
  loadPage(pageKey): BoundedPublishedPage | null; // one <=262144-unit text source
  current(pageRef): boolean;
  readPublicationBatch(afterRevision, limit /* <= 32 */): Publication[];
}
```

Use a distinct source key `e:<pageAttemptId>`, `sourceType: 'document'`, canonical document ID, page-local offsets, document title/section context, and the versioned derived digest. Existing `x:` legacy registration fixtures can remain isolated until an explicit search schema transition; they are not durable page checkpoints. The shared chunker consumes all text fragments for an `e:` source before `finish()` and uses its existing partial-build invisibility/publication mechanism.

Drain the durable extraction outbox into the existing active and rebuilding search epochs in bounded owner-serialized transactions. A normal new page dirties **only its source**; it does not change the document scope revision. On the first page of a replacement extraction run, atomically switch the selected visible run; invalidate the document scope once and re-enumerate through the bounded document queue. Clear an old failed/pending `d:` PDF source without treating unextracted future pages as permanent FTS failures.

Visibility cannot depend solely on eventually draining the outbox. The search source-current checks and visible-head predicate must also fence each `e:` head against the currently selected published page/run/revision and canonical attachment hash. Extend the private source adapter/predicate for that check; do not broaden every page write into document-wide invalidation. Repeat the fence immediately before FTS head publication and when resolving navigation. This prevents a stale held source or old normalizer run from appearing during drain delays/rebuild. If extraction schema is unavailable, suppress only `e:` sources and report extraction failure; conversation FTS and canonical writes must remain usable.

Search rebuild/repair regenerates FTS from published extraction pages and retains `quixi_extract_*`, checkpoints and receipts. Extraction repair is a separate explicit operation: suppress extraction sources, invalidate its generation, and rebuild extraction from the immutable original. No new canonical trigger should depend on extraction tables. Coordinate namespace/schema handling with canonical archive export/restore allowlists before implementation.

## Interruption, ownership and cleanup

A storage-owner handoff alone does **not** establish that an extraction producer died. Preserve published pages and existing writer fences through owner reopen. A producer reconnects and resolves uncertain receipts before further writes. An explicit resume/claim uses writer-epoch CAS; it invalidates the prior writer, abandons only the current unpublished attempt, and returns the last contiguous checkpoint. A losing producer stops on `STALE_WRITER`/`CONFLICT` and releases its original read lease. Confirmed producer loss may mark the run interrupted; it never rewrites completed pages.

Cancel/parser failure/password-required/source loss retain published pages, mark the run's typed interruption, and fence unfinished attempts out of visibility. Resume under the same identity/version opens PDF.js again and starts at checkpoint + 1. A new attachment hash or extractor/normalizer version requires a new run, never mixed-version page append. The old run remains visible until the replacement's first complete page publishes; that transaction selects the new run and makes old pages/maps stale. Retain old data only for bounded cleanup; it is not a second visible corpus.

Clearing a run first commits source invisibility and a terminal scope receipt, then deletes staged/published derived bytes/maps incrementally. Original attachment bytes, canonical documents, history and sync rows remain untouched. Compact operation receipts remain available for exact status/retry; do not prune a live receipt and later accept the same ID as a fresh operation. Receipt storage counts toward admission budgets. If future receipt compaction is needed, it requires an explicit retired-generation protocol that rejects old scopes, not silent forgetting.

## Navigation and required evidence

Resolve a document SearchHit by its chunk ID and search revision to an exact `PublishedPageRef`, using the currently visible FTS head. Do not resolve merely by `(documentId, page)`, which could select a replacement extraction. Text/map reads repeat the attachment/run/revision fence, return bounded ranges, and reject stale cursors. The UI can then open the original PDF at its actual page/item coordinates. Generated separators remain visibly unmapped; no approximate byte position is presented as original PDF provenance.

Before implementation acceptance, require actual pinned-WASM/public-client/browser evidence for:

1. A phrase/Markdown construct split across many extraction and stage events remains one continuous shared-chunker source; no event-shaped source IDs.
2. Page 1 is searchable while page 2 extraction is deliberately paused. Publishing page 2 leaves page 1's FTS head visible and unchanged.
3. No staged/incomplete page is searchable. Exact same-ID lost-reply retries return original stage/publish receipts; changed payloads and cross-journal IDs fail.
4. Owner termination before/after page commit preserves exactly committed checkpoints, maps and receipts. Owner handoff does not invent producer loss; explicit competing resume fences the old writer.
5. Source hash/version/run changes suppress stale FTS work and mapping cursors, including during delayed outbox drain and search rebuild.
6. Cancel/quota/parser failure preserves prior pages; repeated interruption cleans bounded staging before retry; empty/scanned pages commit a valid checkpoint.
7. Source-map navigation covers multibyte/surrogate/NUL text and original PDF item spans across stage boundaries; no map payload bypasses byte/item budgets.
8. FTS rebuild retains extraction data; extraction corruption does not break canonical writes or conversation search; explicit extraction clear/repair never changes canonical/sync/blob inventory.
9. One-page assembly, map iteration, shared indexing, held read leases, foreground preemption, and physical quota are measured separately. Existing PDF.js whole-source/intermediate allocation caveats remain; this slice does not satisfy final parser-memory acceptance.
