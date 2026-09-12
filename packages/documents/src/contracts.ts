import { DOCUMENT_EXTRACTION_VERSIONS } from '@quixi/core/contracts';
export const EXTRACTOR_VERSION = DOCUMENT_EXTRACTION_VERSIONS.extractorVersion;
export const NORMALIZER_VERSION = DOCUMENT_EXTRACTION_VERSIONS.normalizerVersion;
export const LIMITS = Object.freeze({ sourceBytes: 32 * 1024 * 1024, rangeBytes: 65536, pdfRangeBytes: 1024 * 1024, pages: 1000, pageItems: 10000, pageUTF16: 262144, batchUTF16: 4096, pendingRanges: 4, watchdogMs: 30000 });
export interface DocumentSource {
  attachmentId: string;
  sha256: string;
  byteLength: number;
  mediaType: 'application/pdf' | 'text/plain' | 'text/markdown';
  /** Immutable original bytes, scoped to this source. Never a document-provided URL. */
  readRange(offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>;
}
export interface SourceSpan {
  outputStart: number; outputEnd: number;
  source: null | { itemIndex: number; itemStart: number; itemEnd: number; transform: number[]; width: number; height: number; direction: string } | { byteStart: number; byteEnd: number; utf16Start: number; utf16End: number };
}
export type ExtractionEvent = {
  attachmentId: string; sha256: string; extractorVersion: string;
} & (
  { kind: 'document'; pages: number | null; parser: string; sourceBufferBytes: number }
  | { kind: 'page-start'; page: number }
  | { kind: 'text'; page: number; text: string; spans: SourceSpan[] }
  | { kind: 'page-end'; page: number; items: number; utf16: number; classification: 'text' | 'possible_scanned'; cleanup: boolean;
      layout?: { mode: 'geometric' | 'source_order'; reasons: ('non_ltr' | 'rotated_or_skewed')[]; columns: 1 | 2 } }
  | { kind: 'complete'; pages: number }
);
export type ExtractionFailureCode = 'CANCELLED' | 'CAPACITY' | 'INTEGRITY' | 'PASSWORD_REQUIRED' | 'PARSE_FAILED' | 'TIMEOUT' | 'SOURCE_FAILED';
export class ExtractionError extends Error {
  constructor(readonly code: ExtractionFailureCode, message: string) { super(message); this.name = 'ExtractionError'; }
}
export interface ExtractionOptions {
  signal?: AbortSignal;
  /** Resume only after a durably committed page-end with matching source hash/version. */
  startPage?: number;
  /** Test or host may tighten, never increase, the watchdog. */
  watchdogMs?: number;
}
