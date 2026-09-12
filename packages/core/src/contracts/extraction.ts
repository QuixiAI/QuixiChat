import { isQuixiId } from "../model/validation.ts";
import { jsonByteLength } from "./serialization.ts";
/** Versions accepted by the shipped producer and storage owner. A changed
 * normalizer starts a new derived run; canonical originals remain untouched. */
export const DOCUMENT_EXTRACTION_VERSIONS = Object.freeze({
  extractorVersion: 'quixi-extract-1/pdfjs-6.3.289',
  normalizerVersion: 'quixi-layout-2',
});
export const EXTRACTION_LIMITS = Object.freeze({
  sourceBytes: 33554432,
  pages: 1000,
  pageUTF16: 262144,
  pageItems: 10000,
  stageUTF16: 4096,
  stageSpans: 128,
  stageBytes: 32768,
  pageSpans: 32768,
  pageMapBytes: 4194304,
  pageBatches: 1024,
  runBytes: 268435456,
  archiveBytes: 1073741824,
  textReadUTF16: 16384,
  mapReadSpans: 128,
  mapReadBytes: 65536,
});
export type ExtractionErrorCode =
  | "INVALID_REQUEST"
  | "CONFLICT"
  | "STALE_WRITER"
  | "NOT_FOUND"
  | "CAPACITY"
  | "OVERLOADED"
  | "MIGRATION_FAILED"
  | "SOURCE_UNAVAILABLE"
  | "CANCELLED";
export class ExtractionStorageError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExtractionStorageError";
  }
}
export interface ExtractionIdentity {
  documentId: string;
  attachmentId: string;
  attachmentSha256: string;
  attachmentByteLength: number;
  extractorVersion: string;
  normalizerVersion: string;
}
export interface PageSourceSpan {
  start: number;
  end: number;
  source: null | {
    itemIndex: number;
    itemStart: number;
    itemEnd: number;
    transform: number[];
    width: number;
    height: number;
    direction: "ltr" | "rtl" | "ttb";
  };
}
export interface PageLayout {
  mode: "geometric" | "source_order";
  reasons: ("non_ltr" | "rotated_or_skewed")[];
  columns: 1 | 2;
}
export interface PublishedPageRef {
  pageAttemptId: string;
  runId: string;
  page: number;
  identity: ExtractionIdentity;
  sourceDigest: string;
  publicationRevision: number;
}
export interface ExtractionRunStatus {
  runId: string;
  identity: ExtractionIdentity;
  state: "working" | "interrupted" | "completed" | "cleared";
  writerEpoch: number;
  pageCount: number | null;
  completedPage: number;
  currentPage: {
    pageAttemptId: string;
    page: number;
    nextSequence: number;
    utf16: number;
    mapCount: number;
  } | null;
  visibleRunId: string | null;
  documentRevision: number;
  retainedBytes: number;
  failure: string | null;
}
export interface ExtractionPageStatus {
  pageAttemptId: string;
  page: number;
  nextSequence: number;
  utf16: number;
  mapCount: number;
}
export interface ExtractionWrite {
  operationId: string;
  runId: string;
  writerEpoch: number;
}
export interface ExtractionPageWrite extends ExtractionWrite {
  pageAttemptId: string;
}
export interface ExtractionOperations {
  /** Bounded lookup of one visible published page, including empty/scanned pages.
   * Used to recover page-specific indexing credit after a producer restart. */
  getPublishedExtractionPage: {
    args: { runId: string; page: number };
    result: PublishedPageRef | null;
  };
  /** One bounded shared-FTS slice; the producer grants its next PDF page only
   * after this exact published page is indexed. Empty pages also receive credit. */
  advanceExtractionPageIndex: {
    args: { pageRef: PublishedPageRef };
    result: { indexed: boolean };
  };
  beginDocumentExtraction: {
    args: { operationId: string; identity: ExtractionIdentity };
    result: ExtractionRunStatus;
  };
  resumeDocumentExtraction: {
    args: { operationId: string; runId: string; expectedWriterEpoch: number };
    result: ExtractionRunStatus;
  };
  beginExtractionPage: {
    args: ExtractionWrite & { page: number; documentPageCount: number };
    result: ExtractionPageStatus;
  };
  stagePageText: {
    args: ExtractionPageWrite & {
      sequence: number;
      expectedUTF16Offset: number;
      text: string;
      spans: PageSourceSpan[];
    };
    result: {
      pageAttemptId: string;
      sequence: number;
      committedUTF16Offset: number;
      committedMapCount: number;
    };
  };
  publishExtractionPage: {
    args: ExtractionPageWrite & {
      lastSequence: number;
      expectedUTF16Length: number;
      expectedTextSha256: string;
      expectedMapSha256: string;
      itemCount: number;
      classification: "text" | "possible_scanned";
      /** Omitted by legacy producers; never inferred from text classification. */
      layout?: PageLayout;
    };
    result: { pageRef: PublishedPageRef; completedPage: number };
  };
  completeDocumentExtraction: {
    args: ExtractionWrite;
    result: ExtractionRunStatus;
  };
  interruptDocumentExtraction: {
    args: ExtractionWrite & {
      reason:
        | "user_cancelled"
        | "parser_failed"
        | "password_required"
        | "source_unavailable"
        | "capacity"
        | "confirmed_producer_loss";
    };
    result: ExtractionRunStatus;
  };
  getDocumentExtraction: {
    args: { documentId: string };
    result: ExtractionRunStatus | null;
  };
  getExtractionOperation: {
    args: { operationId: string };
    result:
      | { status: "not_found" }
      | { status: "committed"; requestDigest: string; result: unknown };
  };
  readExtractedPageText: {
    args: { pageRef: PublishedPageRef; startUTF16: number; maxUTF16: number };
    result: {
      text: string;
      startUTF16: number;
      endUTF16: number;
      totalUTF16: number;
      /** Page-level parser assessment, preserved even in a short text window. */
      classification: 'text' | 'possible_scanned';
      /** Null means that this legacy page has no recorded layout assessment. */
      layout: PageLayout | null;
    };
  };
  readExtractedPageMap: {
    args: {
      pageRef: PublishedPageRef;
      startUTF16: number;
      endUTF16: number;
      maxItems: number;
      maxBytes: number;
      cursor: string | null;
    };
    result: {
      items: PageSourceSpan[];
      nextCursor: string | null;
      bytes: number;
    };
  };
  clearDocumentExtraction: {
    args: {
      operationId: string;
      documentId: string;
      expectedRunId: string;
      expectedDocumentRevision: number;
    };
    result: { documentId: string; documentRevision: number; cleared: true };
  };
}
const fail = (message: string): never => {
  throw new ExtractionStorageError("INVALID_REQUEST", message);
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Expected extraction object.");
  return value as Record<string, unknown>;
};
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((k) => !Object.hasOwn(value, k))
  )
    fail("Unknown or missing extraction field.");
}
const integer = (v: unknown, min: number, max: number) => {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    fail("Extraction integer exceeds its bound.");
};
const id = (v: unknown) => {
  if (!isQuixiId(v)) fail("Invalid extraction UUID.");
};
const hash = (v: unknown) => {
  if (typeof v !== "string" || v.length !== 64 || !/^[0-9a-f]{64}$/.test(v))
    fail("Invalid extraction digest.");
};
export function assertExtractionIdentity(
  value: unknown,
): asserts value is ExtractionIdentity {
  const v = object(value);
  keys(v, [
    "documentId",
    "attachmentId",
    "attachmentSha256",
    "attachmentByteLength",
    "extractorVersion",
    "normalizerVersion",
  ]);
  id(v.documentId);
  id(v.attachmentId);
  hash(v.attachmentSha256);
  integer(v.attachmentByteLength, 1, EXTRACTION_LIMITS.sourceBytes);
  for (const k of ["extractorVersion", "normalizerVersion"])
    if (typeof v[k] !== "string" || !v[k].length || v[k].length > 128)
      fail("Invalid extraction version.");
}
export function assertPageLayout(value: unknown): asserts value is PageLayout {
  inspectBoundary(value);
  try { jsonByteLength(value, 512); } catch { fail("Page layout metadata exceeds its bound."); }
  const v = object(value);
  keys(v, ["mode", "reasons", "columns"]);
  if (!["geometric", "source_order"].includes(String(v.mode)) ||
      !Array.isArray(v.reasons) || v.reasons.length > 2 ||
      v.reasons.some(reason => !["non_ltr", "rotated_or_skewed"].includes(reason)) ||
      new Set(v.reasons).size !== v.reasons.length || ![1, 2].includes(Number(v.columns)) ||
      (v.columns !== 1 && v.columns !== 2) ||
      (v.mode === "geometric" && v.reasons.length !== 0) ||
      (v.mode === "source_order" && (v.reasons.length === 0 || v.columns !== 1)))
    fail("Invalid page layout assessment.");
}
export function assertPublishedPageRef(
  value: unknown,
): asserts value is PublishedPageRef {
  const v = object(value);
  keys(v, [
    "pageAttemptId",
    "runId",
    "page",
    "identity",
    "sourceDigest",
    "publicationRevision",
  ]);
  id(v.pageAttemptId);
  id(v.runId);
  integer(v.page, 1, 1000);
  assertExtractionIdentity(v.identity);
  hash(v.sourceDigest);
  integer(v.publicationRevision, 1, Number.MAX_SAFE_INTEGER);
}
function wellFormed(text: string) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(++i);
      if (!(n >= 0xdc00 && n <= 0xdfff)) fail("Unpaired text surrogate.");
    } else if (c >= 0xdc00 && c <= 0xdfff) fail("Unpaired text surrogate.");
  }
}
const fields: Record<keyof ExtractionOperations, string[]> = {
  getPublishedExtractionPage: ["runId", "page"],
  advanceExtractionPageIndex: ["pageRef"],
  beginDocumentExtraction: ["operationId", "identity"],
  resumeDocumentExtraction: ["operationId", "runId", "expectedWriterEpoch"],
  beginExtractionPage: [
    "operationId",
    "runId",
    "writerEpoch",
    "page",
    "documentPageCount",
  ],
  stagePageText: [
    "operationId",
    "runId",
    "writerEpoch",
    "pageAttemptId",
    "sequence",
    "expectedUTF16Offset",
    "text",
    "spans",
  ],
  publishExtractionPage: [
    "operationId",
    "runId",
    "writerEpoch",
    "pageAttemptId",
    "lastSequence",
    "expectedUTF16Length",
    "expectedTextSha256",
    "expectedMapSha256",
    "itemCount",
    "classification",
  ],
  completeDocumentExtraction: ["operationId", "runId", "writerEpoch"],
  interruptDocumentExtraction: [
    "operationId",
    "runId",
    "writerEpoch",
    "reason",
  ],
  getDocumentExtraction: ["documentId"],
  getExtractionOperation: ["operationId"],
  readExtractedPageText: ["pageRef", "startUTF16", "maxUTF16"],
  readExtractedPageMap: [
    "pageRef",
    "startUTF16",
    "endUTF16",
    "maxItems",
    "maxBytes",
    "cursor",
  ],
  clearDocumentExtraction: [
    "operationId",
    "documentId",
    "expectedRunId",
    "expectedDocumentRevision",
  ],
};
/** Inspect bounded own descriptors before serialization, including array accessors. */
function inspectBoundary(value: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 8192 || depth > 32)
      fail("Extraction boundary is too complex.");
    if (!item || typeof item !== "object") return;
    if (
      (!Array.isArray(item) &&
        ![Object.prototype, null].includes(Object.getPrototypeOf(item))) ||
      ancestors.has(item)
    )
      fail("Extraction boundary must be acyclic plain data.");
    ancestors.add(item);
    for (const key in item) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable) continue;
      if (descriptor.get || descriptor.set)
        fail("Extraction boundary cannot contain accessors.");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}
export function assertExtractionArgs<K extends keyof ExtractionOperations>(
  operation: K,
  value: unknown,
): asserts value is ExtractionOperations[K]["args"] {
  inspectBoundary(value);
  try {
    jsonByteLength(value, EXTRACTION_LIMITS.stageBytes);
  } catch {
    fail("Extraction envelope exceeds finite JSON bounds.");
  }
  const v = object(value);
  if (!Object.hasOwn(fields, operation)) fail("Unknown extraction operation.");
  keys(v, operation === "publishExtractionPage" && Object.hasOwn(v, "layout")
    ? [...fields[operation], "layout"] : fields[operation]);
  for (const k of [
    "operationId",
    "runId",
    "documentId",
    "pageAttemptId",
    "expectedRunId",
  ])
    if (Object.hasOwn(v, k)) id(v[k]);
  for (const k of [
    "writerEpoch",
    "expectedWriterEpoch",
    "expectedDocumentRevision",
  ])
    if (Object.hasOwn(v, k)) integer(v[k], 1, Number.MAX_SAFE_INTEGER);
  if (operation === "beginDocumentExtraction")
    assertExtractionIdentity(v.identity);
  if (operation === "advanceExtractionPageIndex")
    assertPublishedPageRef(v.pageRef);
  if (operation === "getPublishedExtractionPage") integer(v.page, 1, 1000);
  if (operation === "beginExtractionPage") {
    integer(v.page, 1, 1000);
    integer(v.documentPageCount, 1, 1000);
    if (Number(v.page) > Number(v.documentPageCount))
      fail("Page exceeds document count.");
  }
  if (operation === "stagePageText") {
    integer(v.sequence, 0, 1023);
    integer(v.expectedUTF16Offset, 0, 262144);
    if (typeof v.text !== "string" || !v.text.length || v.text.length > 4096)
      fail("Stage text exceeds bound.");
    wellFormed(v.text as string);
    if (!Array.isArray(v.spans) || !v.spans.length || v.spans.length > 128)
      fail("Stage maps exceed bound.");
    let at = Number(v.expectedUTF16Offset);
    for (const item of v.spans as unknown[]) {
      const s = object(item);
      keys(s, ["start", "end", "source"]);
      integer(s.start, 0, 262144);
      integer(s.end, 1, 262144);
      if (s.start !== at || Number(s.end) <= at)
        fail("Maps must cover the stage contiguously.");
      at = Number(s.end);
      const relativeEnd = at - Number(v.expectedUTF16Offset);
      if (relativeEnd > 0 && relativeEnd < (v.text as string).length) {
        const previous = (v.text as string).charCodeAt(relativeEnd - 1);
        const next = (v.text as string).charCodeAt(relativeEnd);
        if (
          previous >= 0xd800 &&
          previous <= 0xdbff &&
          next >= 0xdc00 &&
          next <= 0xdfff
        )
          fail("Source map splits a surrogate pair.");
      }
      if (s.source !== null) {
        const p = object(s.source);
        keys(p, [
          "itemIndex",
          "itemStart",
          "itemEnd",
          "transform",
          "width",
          "height",
          "direction",
        ]);
        integer(p.itemIndex, 0, 9999);
        integer(p.itemStart, 0, 262144);
        integer(p.itemEnd, 1, 262144);
        if (
          Number(p.itemEnd) - Number(p.itemStart) !==
          Number(s.end) - Number(s.start)
        )
          fail("Source span differs from copied text.");
        if (
          !Array.isArray(p.transform) ||
          p.transform.length !== 6 ||
          ![...p.transform, p.width, p.height].every(
            (n) => typeof n === "number" && Number.isFinite(n),
          ) ||
          !["ltr", "rtl", "ttb"].includes(String(p.direction))
        )
          fail("Invalid source layout.");
      }
    }
    if (at !== Number(v.expectedUTF16Offset) + (v.text as string).length)
      fail("Maps do not cover the stage text.");
  }
  if (operation === "publishExtractionPage") {
    if (Object.hasOwn(v, "layout")) assertPageLayout(v.layout);
    integer(v.lastSequence, -1, 1023);
    integer(v.expectedUTF16Length, 0, 262144);
    integer(v.itemCount, 0, 10000);
    hash(v.expectedTextSha256);
    hash(v.expectedMapSha256);
    if (!["text", "possible_scanned"].includes(String(v.classification)))
      fail("Invalid page classification.");
  }
  if (
    operation === "interruptDocumentExtraction" &&
    ![
      "user_cancelled",
      "parser_failed",
      "password_required",
      "source_unavailable",
      "capacity",
      "confirmed_producer_loss",
    ].includes(String(v.reason))
  )
    fail("Invalid interruption reason.");
  if (
    operation === "readExtractedPageText" ||
    operation === "readExtractedPageMap"
  ) {
    assertPublishedPageRef(v.pageRef);
    integer(v.startUTF16, 0, 262144);
  }
  if (operation === "readExtractedPageText") integer(v.maxUTF16, 1, 16384);
  if (operation === "readExtractedPageMap") {
    integer(v.endUTF16, Number(v.startUTF16), 262144);
    integer(v.maxItems, 1, 128);
    integer(v.maxBytes, 256, 65536);
    if (
      v.cursor !== null &&
      (typeof v.cursor !== "string" || v.cursor.length > 1024)
    )
      fail("Invalid map cursor.");
  }
}
