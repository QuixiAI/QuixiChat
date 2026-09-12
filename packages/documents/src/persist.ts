import { canonicalJson, DOCUMENT_EXTRACTION_VERSIONS, EXTRACTION_LIMITS, jsonByteLength } from '@quixi/core/contracts';
import type { ExtractionOperations, ExtractionRunStatus, ExtractionIdentity, PageSourceSpan, PublishedPageRef, StorageClient } from '@quixi/core/contracts';
import { PendingExtractionOperationError, writeExtractionMutation } from './persist-mutation.ts';
import type { ExtractionWriteOperation } from './persist-mutation.ts';
export { PendingExtractionOperationError } from './persist-mutation.ts';
export type { PendingExtractionOperation } from './persist-mutation.ts';
import type { JsonValue } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { extractDocument } from './index.ts';
import { ExtractionError } from './contracts.ts';
import type { ExtractionEvent } from './contracts.ts';
import { acquireStoredPdfProducerLease, openStoredPdfSource } from './storage-source.ts';

export interface PdfPersistenceProgress {
  phase: 'opening' | 'extracting' | 'indexing' | 'completed' | 'interrupted';
  runId: string | null;
  page: number;
  pages: number | null;
  indexedThroughPage: number;
}
export interface PdfPersistenceOptions {
  /** The client stays pinned to its original archive throughout the workflow. */
  storage: StorageClient & { readonly archiveId: string };
  documentId: string;
  signal?: AbortSignal;
  /** Awaited: consumers can apply additional bounded downstream backpressure. */
  onProgress?(progress: Readonly<PdfPersistenceProgress>): void | Promise<void>;
}
const id = () => crypto.randomUUID();
const code = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new ExtractionError('CANCELLED', 'Document extraction cancelled; published pages remain available.'); };
async function pause(signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  await new Promise<void>(resolve => setTimeout(resolve, 25));
  cancelled(signal);
}

/** Real PDF.js → bounded page staging → shared FTS. One page is held until its
 * own visible FTS head is ready; embeddings never participate in the credit. */
export async function persistPdfDocument(options: PdfPersistenceOptions): Promise<ExtractionRunStatus> {
  const { storage, documentId, signal, onProgress } = options;
  const archiveId = storage.archiveId;
  let run: ExtractionRunStatus | null = null;
  let indexedThroughPage = 0;
  let pages: number | null = null;
  let currentPage = 0;
  const progress = async (phase: PdfPersistenceProgress['phase']) => {
    await onProgress?.(Object.freeze({ phase, runId: run?.runId ?? null, page: currentPage, pages, indexedThroughPage }));
  };
  const write = <K extends ExtractionWriteOperation>(operation: K, input: Omit<ExtractionOperations[K]['args'], 'operationId'>, control = false) =>
    writeExtractionMutation(storage, operation, input, signal, control);
  async function index(pageRef: PublishedPageRef) {
    currentPage = pageRef.page;
    await progress('indexing');
    for (;;) {
      cancelled(signal);
      const result = await storage.request(id(), 'advanceExtractionPageIndex', { pageRef });
      if (result.indexed) break;
      await pause(signal);
    }
    indexedThroughPage = pageRef.page;
    await progress('indexing');
    cancelled(signal);
  }
  await progress('opening');
  const producer = await acquireStoredPdfProducerLease(archiveId, documentId, signal);
  let source: Awaited<ReturnType<typeof openStoredPdfSource>> | undefined;
  let primaryFailure: { error: unknown } | undefined;
  try {
    source = await openStoredPdfSource(storage, documentId, signal);
    const identity: ExtractionIdentity = {
      documentId, attachmentId: source.attachmentId, attachmentSha256: source.sha256,
      attachmentByteLength: source.byteLength, ...DOCUMENT_EXTRACTION_VERSIONS,
    };
    const previous = await storage.request(id(), 'getDocumentExtraction', { documentId });
    cancelled(signal);
    if (previous && previous.state !== 'cleared' && canonicalJson(previous.identity as unknown as JsonValue) === canonicalJson(identity as unknown as JsonValue)) {
      run = previous.state === 'completed' ? previous : await write('resumeDocumentExtraction', { runId: previous.runId, expectedWriterEpoch: previous.writerEpoch });
    } else {
      // The exclusive producer lease proves that an older-version run for this
      // document has no live owner. Preserve its published pages until the new
      // run publishes replacement page one, but release its working admission.
      if (previous?.state === 'working') await write('interruptDocumentExtraction', {
        runId: previous.runId, writerEpoch: previous.writerEpoch, reason: 'confirmed_producer_loss',
      });
      run = await write('beginDocumentExtraction', { identity });
    }
    pages = run.pageCount;
    // Recover exact page credit after interrupted indexing or an index rebuild.
    // This reads one small reference at a time, not all document text/chunks.
    for (let page = 1; page <= run.completedPage; page++) {
      const ref = await storage.request(id(), 'getPublishedExtractionPage', { runId: run.runId, page });
      if (!ref || ref.runId !== run.runId || ref.page !== page) throw new ExtractionError('SOURCE_FAILED', 'A saved document page is unavailable; preserve the extraction for recovery.');
      await index(ref);
    }
    if (run.state === 'completed') { await progress('completed'); return run; }
    if (run.pageCount !== null && run.completedPage === run.pageCount) {
      run = await write('completeDocumentExtraction', { runId: run.runId, writerEpoch: run.writerEpoch });
      await progress('completed'); return run;
    }
    let pageAttemptId: string | null = null, sequence = 0, committedUTF16 = 0;
    let bufferText = '', bufferSpans: PageSourceSpan[] = [];
    let textHash = sha256.create(), mapHash = sha256.create();
    const pageWrite = () => ({ runId: run!.runId, writerEpoch: run!.writerEpoch, pageAttemptId: pageAttemptId! });
    const fits = (text: string, spans: PageSourceSpan[]) => {
      if (text.length > EXTRACTION_LIMITS.stageUTF16 || spans.length > EXTRACTION_LIMITS.stageSpans) return false;
      try { jsonByteLength({ ...pageWrite(), operationId: '00000000-0000-4000-8000-000000000000', sequence, expectedUTF16Offset: committedUTF16, text, spans }, EXTRACTION_LIMITS.stageBytes); return true; }
      catch { return false; }
    };
    async function flush() {
      if (!bufferText) return;
      const text = bufferText, spans = bufferSpans;
      await write('stagePageText', { ...pageWrite(), sequence, expectedUTF16Offset: committedUTF16, text, spans });
      textHash.update(new TextEncoder().encode(text));
      for (const span of spans) mapHash.update(new TextEncoder().encode(canonicalJson(span as unknown as JsonValue) + '\n'));
      committedUTF16 += text.length; sequence++;
      bufferText = ''; bufferSpans = [];
    }
    const append = async (event: Extract<ExtractionEvent, { kind: 'text' }>) => {
      const spansAt = (offset: number): PageSourceSpan[] => event.spans.map(span => {
        if (span.source !== null && (!('itemIndex' in span.source) || !['ltr', 'rtl', 'ttb'].includes(span.source.direction))) throw new ExtractionError('PARSE_FAILED', 'PDF source layout is invalid.');
        return { start: offset + span.outputStart, end: offset + span.outputEnd, source: span.source === null ? null : { ...span.source, transform: [...span.source.transform], direction: span.source.direction as 'ltr' | 'rtl' | 'ttb' } };
      });
      let spans = spansAt(committedUTF16 + bufferText.length);
      if (!fits(bufferText + event.text, [...bufferSpans, ...spans])) { await flush(); spans = spansAt(committedUTF16); }
      if (!fits(bufferText + event.text, [...bufferSpans, ...spans])) throw new ExtractionError('CAPACITY', 'A PDF text batch exceeds its bounded storage envelope.');
      bufferText += event.text; bufferSpans.push(...spans);
    };
    try {
      for await (const event of extractDocument(source, { ...(signal ? { signal } : {}), startPage: run.completedPage + 1 })) {
        cancelled(signal);
        if (event.attachmentId !== source.attachmentId || event.sha256 !== source.sha256 || event.extractorVersion !== identity.extractorVersion) throw new ExtractionError('INTEGRITY', 'Parser source identity changed during extraction.');
        switch (event.kind) {
          case 'document':
            if (event.pages === null || !Number.isInteger(event.pages) || event.pages < 1 || event.pages > EXTRACTION_LIMITS.pages || pages !== null && pages !== event.pages) throw new ExtractionError('PARSE_FAILED', 'PDF page count changed or exceeds its bound.');
            pages = event.pages; break;
          case 'page-start': {
            if (pageAttemptId || pages === null || event.page !== run.completedPage + 1) throw new ExtractionError('PARSE_FAILED', 'Parser page order differs from its durable checkpoint.');
            currentPage = event.page;
            const page = await write('beginExtractionPage', { runId: run.runId, writerEpoch: run.writerEpoch, page: event.page, documentPageCount: pages });
            pageAttemptId = page.pageAttemptId; sequence = 0; committedUTF16 = 0;
            bufferText = ''; bufferSpans = [];
            textHash.destroy(); mapHash.destroy(); textHash = sha256.create(); mapHash = sha256.create();
            await progress('extracting'); break;
          }
          case 'text':
            if (!pageAttemptId || event.page !== currentPage) throw new ExtractionError('PARSE_FAILED', 'Text arrived outside its active PDF page.');
            await append(event); break;
          case 'page-end': {
            if (!pageAttemptId || event.page !== currentPage) throw new ExtractionError('PARSE_FAILED', 'PDF completion refers to another page.');
            await flush();
            if (event.utf16 !== committedUTF16) throw new ExtractionError('INTEGRITY', 'Stored page length differs from parser output.');
            const published = await write('publishExtractionPage', { ...pageWrite(), lastSequence: sequence - 1, expectedUTF16Length: committedUTF16, expectedTextSha256: bytesToHex(textHash.digest()), expectedMapSha256: bytesToHex(mapHash.digest()), itemCount: event.items, classification: event.classification,
              ...(event.layout ? { layout: event.layout } : {}) });
            run = { ...run, completedPage: published.completedPage, pageCount: pages, currentPage: null };
            pageAttemptId = null;
            await index(published.pageRef); break;
          }
          case 'complete':
            if (pageAttemptId || event.pages !== pages || run.completedPage !== pages) throw new ExtractionError('PARSE_FAILED', 'PDF ended before every page was durably published.');
            run = await write('completeDocumentExtraction', { runId: run.runId, writerEpoch: run.writerEpoch });
            await progress('completed'); return run;
        }
      }
      throw new ExtractionError('PARSE_FAILED', 'PDF parser stopped before document completion.');
    } finally { textHash.destroy(); mapHash.destroy(); }
  } catch (error) {
    try {
      if (run?.state === 'working' && !(error instanceof PendingExtractionOperationError)) {
        const reason = signal?.aborted || code(error) === 'CANCELLED' ? 'user_cancelled' : code(error) === 'PASSWORD_REQUIRED' ? 'password_required' : ['SOURCE_FAILED', 'INTEGRITY', 'IO_ERROR', 'NOT_FOUND'].includes(code(error) ?? '') ? 'source_unavailable' : ['CAPACITY', 'QUOTA_EXCEEDED'].includes(code(error) ?? '') ? 'capacity' : 'parser_failed';
        run = await write('interruptDocumentExtraction', { runId: run.runId, writerEpoch: run.writerEpoch, reason }, true);
        await progress('interrupted');
      }
    } catch (recoveryError) { primaryFailure = { error: recoveryError }; throw recoveryError; }
    primaryFailure = { error };
    throw error;
  } finally {
    const failures: unknown[] = [];
    try { await source?.close(); } catch (error) { failures.push(error); }
    try { await producer.release(); } catch (error) { failures.push(error); }
    // Cleanup must never replace an unresolved write's exact recovery identity.
    if (primaryFailure?.error instanceof PendingExtractionOperationError)
      primaryFailure.error.cleanupFailures = failures;
    if (failures.length && !primaryFailure)
      throw new AggregateError(failures, 'Document processing finished, but resource release is unconfirmed.');
  }
}
