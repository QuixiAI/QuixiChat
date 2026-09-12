import { invoke } from '@tauri-apps/api/core';
import { openActiveStorageClient } from '@quixi/storage/client';
import type { ArchiveStorageClient } from '@quixi/storage/client';
import { openStoredPdfSource, persistPdfDocument } from '@quixi/documents/storage';
import { NORMALIZER_VERSION } from '@quixi/documents';
import type { PageLayout } from '@quixi/core/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import manifest from '../../../packages/documents/tests/fixtures/manifest.json';
import layoutManifest from '../../../packages/documents/tests/fixtures/layout-manifest.json';
import oneUrl from '../../../packages/documents/tests/fixtures/pages-1.pdf?url';
import hundredUrl from '../../../packages/documents/tests/fixtures/pages-100.pdf?url';
import malformedUrl from '../../../packages/documents/tests/fixtures/malformed.pdf?url';
import encryptedUrl from '../../../packages/documents/tests/fixtures/encrypted.pdf?url';
import columnsUrl from '../../../packages/documents/tests/fixtures/layout-columns.pdf?url';
import rotatedUrl from '../../../packages/documents/tests/fixtures/layout-unsupported.pdf?url';

type FixtureName = 'pages-1.pdf' | 'pages-100.pdf' | 'malformed.pdf' | 'encrypted.pdf' | 'layout-columns.pdf' | 'layout-unsupported.pdf';
type Original = { name: FixtureName; documentId: string; attachmentId: string; sha256: string; byteLength: number };
const urls: Record<FixtureName, string> = { 'pages-1.pdf': oneUrl, 'pages-100.pdf': hundredUrl, 'malformed.pdf': malformedUrl, 'encrypted.pdf': encryptedUrl, 'layout-columns.pdf': columnsUrl, 'layout-unsupported.pdf': rotatedUrl };
const descriptors = { ...manifest, ...layoutManifest.documents };
const config = (globalThis as typeof globalThis & { __QUIXI_DOCUMENT_PROOF__: { profile: string; phase: 'write' | 'restart' | 'cleanup' } }).__QUIXI_DOCUMENT_PROOF__;
const id = () => crypto.randomUUID();
const report: Record<string, unknown> & { checks: string[]; workers: { name: string; url: string }[]; cspViolations: unknown[] } = {
  phase: config?.phase, profile: config?.profile, url: location.href, userAgent: navigator.userAgent,
  secureContext: isSecureContext, crossOriginIsolated,
  capabilities: { worker: typeof Worker === 'function', webLocks: !!navigator.locks, opfs: !!navigator.storage?.getDirectory },
  checks: [], workers: [], cspViolations: [], success: false,
};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function checked(value: unknown, message: string) { assert(value, message); report.checks.push(message); }
function layoutIs(value: PageLayout | null | undefined, expected: PageLayout) { return value?.mode === expected.mode && value.columns === expected.columns && JSON.stringify(value.reasons) === JSON.stringify(expected.reasons); }
async function checkpoint(stage: string) { report.stage = stage; await invoke('document_proof_checkpoint', { report: JSON.stringify(report) }); }
document.addEventListener('securitypolicyviolation', event => {
  if (report.cspViolations.length < 32) report.cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI, disposition: event.disposition });
});
const NativeWorker = Worker;
let activePdfWorkers = 0;
const parserStartPages: number[] = [];
globalThis.Worker = class extends NativeWorker {
  private readonly pdf: boolean;
  private readonly extractor: boolean;
  private ended = false;
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.pdf = options?.name === 'quixi-pdf-parser' || options?.name === 'quixi-document-extractor';
    this.extractor = options?.name === 'quixi-document-extractor';
    if (this.pdf) activePdfWorkers++;
    if (report.workers.length < 64) report.workers.push({ name: options?.name ?? '', url: new URL(String(url), location.href).href });
  }
  override postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) {
    if (this.extractor && (message as { kind?: string })?.kind === 'init') parserStartPages.push((message as { startPage: number }).startPage);
    if (Array.isArray(transfer)) super.postMessage(message, transfer); else super.postMessage(message, transfer);
  }
  override terminate() { if (this.pdf && !this.ended) { activePdfWorkers--; this.ended = true; } super.terminate(); }
};
let storage: ArchiveStorageClient | undefined;
async function seed(name: FixtureName, workspaceId: string): Promise<Original> {
  await checkpoint(`seed:${name}:begin`);
  const expected = descriptors[name], response = await fetch(urls[name], { credentials: 'omit', redirect: 'error' });
  assert(response.ok, 'Bundled PDF fixture is unavailable');
  // Fixture acquisition is explicitly limited to 128 KiB; production extraction
  // below reads its verified OPFS original via <=64 KiB child transfers.
  assert(expected.bytes <= 131072, 'Fixture buffer bound');
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert(bytes.length === expected.bytes && bytesToHex(sha256(bytes)) === expected.sha256, 'Bundled PDF fixture digest changed');
  const upload = await storage!.request(id(), 'beginBlobTransfer', { operationId: id(), purpose: 'document', expectedBytes: expected.bytes, expectedSha256: expected.sha256 });
  for (let offset = 0, sequence = 0; offset < bytes.length; sequence++) {
    const chunk = bytes.slice(offset, offset + 65536), length = chunk.length;
    await storage!.sendChunk({ transferId: upload.transferId, sequence, offset, bytes: chunk, final: offset + length === bytes.length }); offset += length;
  }
  await storage!.request(id(), 'finishBlobTransfer', { operationId: id(), transferId: upload.transferId, expectedBytes: expected.bytes, expectedSha256: expected.sha256 });
  const documentId = id(), attachmentId = id(), now = Date.now();
  await storage!.request(id(), 'commit', { transactionId: id(), stagedBlobIds: [upload.transferId], expectedThreadRevisions: [], mutations: [
    { version: 1, operationId: id(), kind: 'RegisterAttachment', recordedAt: now, payload: { attachment: { id: attachmentId, availability: 'available', filename: name, mimeType: 'application/pdf', sizeBytes: expected.bytes, blobSha256: expected.sha256, rawObjectId: null } } },
    { version: 1, operationId: id(), kind: 'RegisterDocument', recordedAt: now, payload: { document: { id: documentId, attachmentId, workspaceId, title: `Native 日本語 ${name}`, createdAt: now, recordedAt: now, importSourceId: null } } },
  ] });
  await checkpoint(`seed:${name}:committed`);
  return { name, documentId, attachmentId, sha256: expected.sha256, byteLength: expected.bytes };
}
async function original(value: Original): Promise<string> {
  const source = await openStoredPdfSource(storage!, value.documentId), hash = sha256.create();
  try {
    assert(source.sha256 === value.sha256 && source.byteLength === value.byteLength && source.attachmentId === value.attachmentId, 'Stored original descriptor changed');
    for (let offset = 0; offset < source.byteLength; offset += 65536) hash.update(await source.readRange(offset, Math.min(65536, source.byteLength - offset), new AbortController().signal));
    const digest = bytesToHex(hash.digest()); assert(digest === value.sha256, 'Stored original bytes changed'); return digest;
  } finally { await source.close(); }
}
async function storedPage(value: Original, number: number) {
  const run = await storage!.request(id(), 'getDocumentExtraction', { documentId: value.documentId });
  assert(run?.visibleRunId && run.identity.normalizerVersion === 'quixi-layout-2', 'Expected current layout2 published extraction');
  const ref = await storage!.request(id(), 'getPublishedExtractionPage', { runId: run.visibleRunId, page: number });
  assert(ref && ref.identity.documentId === value.documentId, 'Published page belongs to another document');
  const result = await storage!.request(id(), 'readExtractedPageText', { pageRef: ref, startUTF16: 0, maxUTF16: 16384 });
  return { ref, result, run };
}
async function published(value: Original, number: number): Promise<string> {
  const { result } = await storedPage(value, number);
  assert(result.text.includes(`Quixi document fixture page ${number}`), 'Actual PDF.js page text is absent'); return result.text;
}
async function verifyLayouts(originals: Original[]) {
  const columns = originals.find(value => value.name === 'layout-columns.pdf')!, rotated = originals.find(value => value.name === 'layout-unsupported.pdf')!;
  assert(columns && rotated, 'Layout originals are missing');
  const columnPage = await storedPage(columns, 2);
  assert(columnPage.run.state === 'completed' && columnPage.run.completedPage === 2, 'Column document is not completely published');
  const blocks = columnPage.result.text.trimEnd().split(/\n{2,}/), expected = layoutManifest.documents['layout-columns.pdf'].pages[1]!.expectedBlocks;
  const squeeze = (text: string) => text.replace(/\s+/g, ' ').trim();
  checked(blocks.length === expected.length && expected.every((block, at) => squeeze(blocks[at]!) === squeeze(block.lines.join(' '))), 'Persisted page two retains authored heading, both left paragraphs, both right paragraphs and footer order');
  checked(layoutIs(columnPage.result.layout, { mode: 'geometric', reasons: [], columns: 2 }), 'Persisted column page records explicit geometric two-column metadata');
  const search = await storage!.request(id(), 'searchArchive', { query: 'copper lantern', mode: 'exact', filters: { documentIds: [columns.documentId] }, page: { maxItems: 24, maxBytes: 200000, cursor: null } });
  const hit = search.items.find(value => value.documentId === columns.documentId && value.position.page === 2);
  assert(hit, 'Published column page two is missing from actual FTS');
  const resolved = await storage!.request(id(), 'resolveDocumentSearchHit', { chunkId: hit.chunkId, documentId: columns.documentId });
  checked(resolved.pageRef?.pageAttemptId === columnPage.ref.pageAttemptId && resolved.pageRef.identity.normalizerVersion === 'quixi-layout-2', 'Actual page-two FTS hit resolves to the exact current layout2 publication');
  const rotatedPage = await storedPage(rotated, 1);
  assert(rotatedPage.run.state === 'completed' && rotatedPage.run.completedPage === 1, 'Rotated document is not completely published');
  checked(layoutManifest.documents['layout-unsupported.pdf'].pages[0]!.sourceAnchors.every(anchor => rotatedPage.result.text.includes(anchor)), 'Persisted unsupported-layout page retains all horizontal and rotated source anchors');
  const fallback: PageLayout = { mode: 'source_order', reasons: ['rotated_or_skewed'], columns: 1 };
  checked(layoutIs(rotatedPage.result.layout, fallback), 'Persisted rotated page records explicit source-order fallback and reason');
  const short = await storage!.request(id(), 'readExtractedPageText', { pageRef: rotatedPage.ref, startUTF16: 0, maxUTF16: 1 });
  checked(short.text.length === 1 && layoutIs(short.layout, fallback), 'One-character read retains page-level fallback metadata');
  report.layoutPages = [columnPage, rotatedPage].map(({ ref, result }) => ({ pageAttemptId: ref.pageAttemptId, page: ref.page, documentId: ref.identity.documentId, normalizerVersion: ref.identity.normalizerVersion, textSha256: bytesToHex(sha256(new TextEncoder().encode(result.text))), layout: result.layout }));
}
async function main() {
  assert(config && /^[a-f0-9-]{36}$/.test(config.profile) && ['write', 'restart', 'cleanup'].includes(config.phase), 'Synthetic native initialization is required');
  const marker = 'quixi.native-pdf-proof.profile';
  if (config.phase === 'write') {
    assert(localStorage.getItem(marker) === null, 'Proof UUID data store is not fresh');
    localStorage.setItem(marker, config.profile);
  } else assert(localStorage.getItem(marker) === config.profile, 'Restart used a different isolated WKWebsiteDataStore');
  if (config.phase === 'cleanup') {
    const root = await navigator.storage.getDirectory();
    for (const name of ['quixi', 'quixi-selection']) try { await root.removeEntry(name, { recursive: true }); } catch (error) { if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error; }
    localStorage.removeItem('quixi.native-pdf-proof.originals'); localStorage.removeItem(marker);
    report.checks.push('Only synthetic profile archive/catalog and fixture metadata were removed'); return;
  }
  checked(isSecureContext && !!navigator.locks && !!navigator.storage?.getDirectory, 'Bundled native context supplies secure OPFS, Web Locks and workers');
  checked(NORMALIZER_VERSION === 'quixi-layout-2', 'Bundled native producer uses normalizer quixi-layout-2');
  report.normalizerVersion = NORMALIZER_VERSION;
  await checkpoint('storage:opening');
  storage = await openActiveStorageClient();
  await checkpoint('storage:opened');
  checked(storage.archiveId === 'default', 'Managed default is inside the explicitly isolated UUID data store');
  let originals: Original[];
  if (config.phase === 'write') {
    checked((await storage.request(id(), 'diagnostics', null)).canonicalRecords === 0, 'Isolated managed archive starts with zero canonical records');
    const workspace = await storage.request(id(), 'archiveWorkspace', null);
    originals = [];
    for (const name of Object.keys(urls) as FixtureName[]) {
      originals.push(await seed(name, workspace.workspaceId));
      localStorage.setItem('quixi.native-pdf-proof.originals', JSON.stringify(originals));
    }
    const one = originals[0]!, hundred = originals[1]!;
    await checkpoint('extract:one:begin');
    const oneRun = await persistPdfDocument({ storage, documentId: one.documentId });
    checked(oneRun.state === 'completed' && oneRun.completedPage === 1 && activePdfWorkers === 0, 'Actual bundled PDF workers extract/persist one page and terminate');
    report.oneText = (await published(one, 1)).slice(0, 500);
    const abort = new AbortController(); let earlySearch = false;
    await checkpoint('extract:hundred:cancel:begin');
    try {
      await persistPdfDocument({ storage, documentId: hundred.documentId, signal: abort.signal, onProgress: async progress => {
        if (progress.phase === 'indexing' && progress.indexedThroughPage === 1 && !abort.signal.aborted) {
          const search = await storage!.request(id(), 'searchArchive', { query: 'Quixi document fixture', mode: 'best', filters: {}, page: { maxItems: 24, maxBytes: 200000, cursor: null } });
          earlySearch = search.items.some(item => item.documentId === hundred.documentId && item.position.page === 1);
          abort.abort();
        }
      } });
      throw new Error('Cancellation unexpectedly completed');
    } catch (error) { assert((error as { code?: string }).code === 'CANCELLED', `Unexpected cancellation outcome: ${String(error)}`); }
    const paused = await storage.request(id(), 'getDocumentExtraction', { documentId: hundred.documentId });
    checked(earlySearch && paused?.state === 'interrupted' && paused.completedPage === 1 && activePdfWorkers === 0, 'Page one reaches real FTS before cancellation; published checkpoint survives and both PDF workers terminate');
    const beforeResume = parserStartPages.length;
    await checkpoint('extract:hundred:resume:begin');
    const finished = await persistPdfDocument({ storage, documentId: hundred.documentId, onProgress: async progress => {
      if (progress.phase === 'indexing' && progress.indexedThroughPage % 25 === 0) await checkpoint(`extract:hundred:indexed:${progress.indexedThroughPage}`);
    } });
    checked(finished.state === 'completed' && finished.completedPage === 100 && parserStartPages[beforeResume] === 2 && activePdfWorkers === 0, 'Actual 100-page workflow resumes parsing at page two and persists all pages');
    report.hundredText = (await published(hundred, 100)).slice(0, 500);
    report.failureCases = [];
    for (const value of originals.filter(value => value.name === 'malformed.pdf' || value.name === 'encrypted.pdf')) {
      let failure: { code?: string; message?: string } | undefined;
      try { await persistPdfDocument({ storage, documentId: value.documentId }); } catch (error) { failure = error as typeof failure; }
      const expected = value.name === 'encrypted.pdf' ? 'PASSWORD_REQUIRED' : 'PARSE_FAILED';
      checked(failure?.code === expected && activePdfWorkers === 0, `${value.name} produces ${expected} and releases both workers`);
      (report.failureCases as unknown[]).push({ name: value.name, ...failure });
    }
    for (const value of originals.filter(value => value.name.startsWith('layout-'))) {
      await checkpoint(`extract:${value.name}:begin`);
      const run = await persistPdfDocument({ storage, documentId: value.documentId });
      checked(run.state === 'completed' && run.identity.normalizerVersion === 'quixi-layout-2' && activePdfWorkers === 0, `${value.name} completes through bundled layout2 workers and releases them`);
    }
  } else {
    originals = JSON.parse(localStorage.getItem('quixi.native-pdf-proof.originals') ?? 'null') as Original[];
    assert(Array.isArray(originals) && originals.length === 6, 'Restart fixture metadata is missing');
    for (const value of originals.slice(0, 2)) {
      const run = await storage.request(id(), 'getDocumentExtraction', { documentId: value.documentId });
      const pages = value.name === 'pages-1.pdf' ? 1 : 100;
      checked(run?.state === 'completed' && run.completedPage === pages, `${pages}-page completed checkpoint survives full native process restart`);
      await published(value, pages);
    }
  }
  await checkpoint('layout:verify-persisted');
  await verifyLayouts(originals);
  report.originals = [];
  await checkpoint('originals:verify');
  for (const value of originals) (report.originals as unknown[]).push({ ...value, verifiedSha256: await original(value) });
  checked(originals.length === 6, 'All six original PDF byte hashes remain exact, including layout/malformed/encrypted inputs');
  report.parserStartPages = parserStartPages;
  report.activePdfWorkers = activePdfWorkers;
  checked(report.cspViolations.length === 0, 'No main-document CSP violation was observed under unchanged production policy');
  report.diagnostics = await storage.request(id(), 'diagnostics', null);
}
try { await main(); report.success = true; }
catch (error) { report.error = { message: String(error), stack: (error as Error)?.stack, code: (error as { code?: string })?.code }; }
finally {
  await checkpoint('storage:closing');
  try { await storage?.close(); } catch (error) { report.success = false; report.cleanupError = String(error); }
  await invoke('document_proof_report', { report: JSON.stringify(report), success: report.success === true });
}
