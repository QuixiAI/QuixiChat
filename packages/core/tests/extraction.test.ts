import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStorageRequest, DOCUMENT_EXTRACTION_VERSIONS, EXTRACTION_LIMITS } from '../src/contracts/index.ts';
import type { ExtractionOperations, PublishedPageRef, StorageRequest } from '../src/contracts/index.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pageRef: PublishedPageRef = {
  pageAttemptId: id(1), runId: id(2), page: 1, sourceDigest: 'c'.repeat(64), publicationRevision: 1,
  identity: { documentId: id(3), attachmentId: id(4), attachmentSha256: 'a'.repeat(64), attachmentByteLength: 5, ...DOCUMENT_EXTRACTION_VERSIONS },
};
const request = (operation: keyof ExtractionOperations, args: unknown) => ({ version: 1, requestId: id(9), operation, args }) as StorageRequest;

test('public extraction admission binds original identity, versions and bounded source size', () => {
  assertStorageRequest(request('beginDocumentExtraction', { operationId: id(5), identity: pageRef.identity }));
  for (const change of [{ attachmentByteLength: EXTRACTION_LIMITS.sourceBytes + 1 }, { attachmentSha256: 'wrong' }, { documentId: 'default' }, { extra: true }])
    assert.throws(() => assertStorageRequest(request('beginDocumentExtraction', { operationId: id(5), identity: { ...pageRef.identity, ...change } })));
});

test('public page staging preserves NUL/UTF-16 coverage and rejects split surrogate maps', () => {
  const args = { operationId: id(5), runId: pageRef.runId, writerEpoch: 1, pageAttemptId: pageRef.pageAttemptId, sequence: 0, expectedUTF16Offset: 0, text: 'A\0🧪', spans: [{ start: 0, end: 4, source: null }] };
  assertStorageRequest(request('stagePageText', args));
  assert.throws(() => assertStorageRequest(request('stagePageText', { ...args, spans: [{ start: 0, end: 3, source: null }, { start: 3, end: 4, source: null }] })));
  assert.throws(() => assertStorageRequest(request('stagePageText', { ...args, text: '\ud800', spans: [{ start: 0, end: 1, source: null }] })));
  assert.throws(() => assertStorageRequest(request('stagePageText', { ...args, sequence: EXTRACTION_LIMITS.pageBatches })));
});

test('index credit and restart lookup require exact bounded published page references', () => {
  assertStorageRequest(request('advanceExtractionPageIndex', { pageRef }));
  assertStorageRequest(request('getPublishedExtractionPage', { runId: pageRef.runId, page: 1 }));
  for (const change of [{ publicationRevision: 0 }, { sourceDigest: 'x' }, { page: 1001 }, { extra: true }])
    assert.throws(() => assertStorageRequest(request('advanceExtractionPageIndex', { pageRef: { ...pageRef, ...change } })));
  assert.throws(() => assertStorageRequest(request('getPublishedExtractionPage', { runId: pageRef.runId, page: 0 })));
});

test('map paging binds a finite range, response bytes and cursor while mutation metadata is rejected', () => {
  const args = { pageRef, startUTF16: 0, endUTF16: 4, maxItems: 128, maxBytes: 65536, cursor: null };
  assertStorageRequest(request('readExtractedPageMap', args));
  for (const change of [{ maxBytes: 65537 }, { maxItems: 129 }, { endUTF16: -1 }, { cursor: 'x'.repeat(1025) }, { operationId: id(5) }])
    assert.throws(() => assertStorageRequest(request('readExtractedPageMap', { ...args, ...change })));
});
