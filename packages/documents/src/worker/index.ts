import { getDocument, PDFDataRangeTransport, PDFWorker } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { LOCAL_ASSETS } from './assets';
import { EXTRACTOR_VERSION, ExtractionError, LIMITS } from '../contracts';
import type { DocumentSource, ExtractionEvent } from '../contracts';
import { normalizePdfPage } from '../layout';
import type { PdfLayoutItem, PdfPageLayout } from '../layout';
const assetFetch = globalThis.fetch.bind(globalThis);
const denied = () => { throw new Error('External network is disabled in document extraction.'); };
Object.assign(globalThis, { fetch: denied, XMLHttpRequest: denied, WebSocket: denied, importScripts: denied, eval: denied, Function: denied });
// Document-provided URLs cannot reach fetch: only exact bundled names resolve.
let assetReads = 0;
class LocalDataOnly {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    try {
      if (++assetReads > LIMITS.pendingRanges) throw new ExtractionError('CAPACITY', 'Supplemental asset queue exceeded.');
      const url = LOCAL_ASSETS[`${kind}/${filename}`];
      if (!url) throw new ExtractionError('PARSE_FAILED', 'Unregistered supplemental PDF asset.');
      const response = await assetFetch(url, { credentials: 'omit', redirect: 'error' });
      if (!response.ok || !response.body) throw new ExtractionError('PARSE_FAILED', 'Bundled PDF asset unavailable.');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          length += chunk.value.length;
          if (length > 1024 * 1024) throw new ExtractionError('CAPACITY', 'Bundled PDF asset exceeds limit.');
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const bytes = new Uint8Array(length); let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
      return bytes;
    } catch (e) { failure(e); throw e; } finally { assetReads--; }
  }
}
let sequence = 0;
const pending = new Map<number, (bytes: Uint8Array) => void>();
function read(offset: number, length: number): Promise<Uint8Array> {
  if (pending.size >= LIMITS.pendingRanges) throw new ExtractionError('CAPACITY', 'Range queue is full.');
  const id = ++sequence;
  return new Promise(resolve => { pending.set(id, resolve); self.postMessage({ kind: 'read', id, offset, length }); });
}
let iterator: AsyncGenerator<ExtractionEvent>;
let pulling = false;
let rangeFailure: unknown;
const failure = (e: unknown) => self.postMessage({ kind: 'failure', code: e instanceof ExtractionError ? e.code : e instanceof Error && e.name === 'PasswordException' ? 'PASSWORD_REQUIRED' : 'PARSE_FAILED', message: e instanceof Error ? e.message.slice(0, 512) : 'Extraction failed.' });
self.onmessage = ({ data }) => {
  if (data.kind === 'init') iterator = extract(data.source, data.port, data.startPage);
  else if (data.kind === 'range') { const resolve = pending.get(data.id); pending.delete(data.id); resolve?.(data.bytes); }
  else if (data.kind === 'next' && !pulling) { pulling = true; void iterator.next().then(result => self.postMessage({ kind: 'result', result }), failure).finally(() => { pulling = false; }); }
};
async function* extract(source: Omit<DocumentSource, 'readRange'>, port: MessagePort, startPage: number): AsyncGenerator<ExtractionEvent> {
  const provenance = { attachmentId: source.attachmentId, sha256: source.sha256, extractorVersion: EXTRACTOR_VERSION };
  if (source.mediaType !== 'application/pdf') {
    if (startPage !== 1) throw new ExtractionError('CAPACITY', 'Text resume is only supported at its document boundary.');
    yield { ...provenance, kind: 'document', pages: 1, parser: 'UTF-8 fatal decoder', sourceBufferBytes: 0 };
    yield { ...provenance, kind: 'page-start', page: 1 };
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let byteOffset = 0, units = 0, batches = 0;
    for (let offset = 0; offset < source.byteLength; offset += LIMITS.rangeBytes) {
      const bytes = await read(offset, Math.min(LIMITS.rangeBytes, source.byteLength - offset));
      const text = decoder.decode(bytes, { stream: offset + bytes.length < source.byteLength });
      for (let at = 0; at < text.length;) {
        let end = Math.min(text.length, at + LIMITS.batchUTF16);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
        const value = text.slice(at, end), length = new TextEncoder().encode(value).length;
        yield { ...provenance, kind: 'text', page: 1, text: value, spans: [{ outputStart: 0, outputEnd: value.length, source: { byteStart: byteOffset, byteEnd: byteOffset + length, utf16Start: units, utf16End: units + value.length } }] };
        byteOffset += length; units += value.length; batches++; at = end;
      }
    }
    yield { ...provenance, kind: 'page-end', page: 1, items: batches, utf16: units, classification: units ? 'text' : 'possible_scanned', cleanup: true };
    yield { ...provenance, kind: 'complete', pages: 1 }; return;
  }
  // PDF.js 6.3.289 runtime accepts an event/message port; its generated declaration incorrectly types this default as null.
  // @ts-expect-error Tested against the pinned runtime using an actual dedicated parser Worker.
  const worker = new PDFWorker({ port });
  port.start();
  class Range extends PDFDataRangeTransport {
    active = 0;
    override requestDataRange(begin: number, end: number) {
      if (end - begin > LIMITS.pdfRangeBytes || ++this.active > LIMITS.pendingRanges) { failure(new ExtractionError('CAPACITY', 'PDF parser requested an oversized range or queue.')); return; }
      void (async () => {
        const bytes = new Uint8Array(end - begin);
        for (let offset = begin; offset < end; offset += LIMITS.rangeBytes) bytes.set(await read(offset, Math.min(LIMITS.rangeBytes, end - offset)), offset - begin);
        this.onDataRange(begin, bytes);
      })().catch(e => { rangeFailure = e; failure(e); }).finally(() => this.active--);
    }
  }
  const range = new Range(source.byteLength, new Uint8Array(), true);
  const task = getDocument({ range, worker, rangeChunkSize: LIMITS.rangeBytes, disableAutoFetch: true, disableStream: true, stopAtErrors: true, useWorkerFetch: false, useWasm: false, disableFontFace: true, useSystemFonts: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false, maxImageSize: 0, enableXfa: false, BinaryDataFactory: LocalDataOnly });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > LIMITS.pages || startPage > pdf.numPages) throw new ExtractionError('CAPACITY',
      pdf.numPages > LIMITS.pages ? `This PDF exceeds the ${LIMITS.pages}-page extraction limit.` : 'The requested resume page is beyond the end of this PDF.');
    yield { ...provenance, kind: 'document', pages: pdf.numPages, parser: 'PDF.js 6.3.289 / 1c8020a7d / Quixi range patch 1 / dedicated worker', sourceBufferBytes: source.byteLength };
    for (let pageNumber = startPage; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      let items = 0, units = 0, meaningfulUnits = 0, cleaned = false;
      let layout: PdfPageLayout | undefined;
      try {
        yield { ...provenance, kind: 'page-start', page: pageNumber };
        const reader = page.streamTextContent({ disableNormalization: true, includeMarkedContent: false }).getReader();
        const pageItems: PdfLayoutItem[] = [];
        const fonts = new Map<string, boolean>();
        try {
          while (true) {
            const batch = await reader.read();
            if (batch.done) break;
            for (const item of batch.value.items) {
              if (!('str' in item)) continue;
              const textItem = item as TextItem;
              if (++items > LIMITS.pageItems || units + textItem.str.length + Number(textItem.hasEOL) > LIMITS.pageUTF16) { const e = new ExtractionError('CAPACITY', 'PDF page text/item budget exceeded.'); failure(e); throw e; }
              if (textItem.transform.length !== 6 || ![...textItem.transform, textItem.width, textItem.height].every(Number.isFinite)) throw new ExtractionError('PARSE_FAILED', 'Invalid PDF source layout coordinates.');
              units += textItem.str.length + Number(textItem.hasEOL); meaningfulUnits += textItem.str.trim().length;
              const style = batch.value.styles[textItem.fontName];
              if (style) fonts.set(textItem.fontName, /monospace|courier/i.test(style.fontFamily));
              pageItems.push({ itemIndex: items - 1, str: textItem.str, transform: [...textItem.transform], width: textItem.width,
                height: textItem.height, dir: textItem.dir, hasEOL: textItem.hasEOL, monospace: fonts.get(textItem.fontName) ?? false });
            }
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
        layout = normalizePdfPage(pageItems);
        pageItems.length = 0; fonts.clear();
        units = layout.utf16;
        for (const text of layout.text()) yield { ...provenance, kind: 'text', page: pageNumber, ...text };
      } finally { cleaned = page.cleanup(); }
      // PageProxy.cleanup only releases display-side objects. PDF.js also keeps
      // whole input strings and glyph arrays in shared parser font caches; free
      // those between fully drained page streams before granting page-end credit.
      // No rendering runs in this worker, so document cleanup cannot race it.
      await pdf.cleanup();
      yield { ...provenance, kind: 'page-end', page: pageNumber, items, utf16: units, classification: meaningfulUnits < 8 ? 'possible_scanned' : 'text', cleanup: cleaned,
        layout: { mode: layout!.mode, reasons: layout!.reasons, columns: layout!.columns } };
      if (rangeFailure) throw rangeFailure;
    }
    yield { ...provenance, kind: 'complete', pages: pdf.numPages };
  } finally { await task.destroy(); worker.destroy(); }
}
