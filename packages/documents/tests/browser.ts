import { extractDocument, ExtractionError, LIMITS } from '../src/index';
import type { DocumentSource } from '../src/index';
import manifest from './fixtures/manifest.json';
const NativeWorker = globalThis.Worker;
let activeWorkers = 0, terminatedWorkers = 0, stallNext = false;
class ObservedWorker extends NativeWorker {
  ended = false;
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); activeWorkers++; }
  override terminate() { if (!this.ended) { this.ended = true; activeWorkers--; terminatedWorkers++; } super.terminate(); }
  override postMessage(message: any, transfer: Transferable[] | StructuredSerializeOptions = []) { if (stallNext && message.kind === 'next') return; if (Array.isArray(transfer)) super.postMessage(message, transfer); else super.postMessage(message, transfer); }
}
globalThis.Worker = ObservedWorker;
let ranges = 0, maxRange = 0, inFlight = 0, maxInFlight = 0;
const fixtureId = (name: keyof typeof manifest) => `${manifest[name].sha256.slice(0, 8)}-0000-4000-8000-000000000001`;
const source = (name: keyof typeof manifest): DocumentSource => ({ attachmentId: fixtureId(name), sha256: manifest[name].sha256, byteLength: manifest[name].bytes, mediaType: name.endsWith('.pdf') ? 'application/pdf' : 'text/plain', async readRange(offset, length, signal) {
  ranges++; maxRange = Math.max(maxRange, length); maxInFlight = Math.max(maxInFlight, ++inFlight);
  try {
    const response = await fetch(`/fixtures/${name}`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal });
    if (response.status !== 206) throw new Error('Fixture must honor bounded range requests.');
    return new Uint8Array(await response.arrayBuffer());
  } finally { inFlight--; }
} });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function run() {
  const checks: unknown[] = [];
  for (const name of ['pages-1.pdf', 'pages-100.pdf', 'pages-1000.pdf', 'scanned.pdf', 'actions.pdf', 'unicode.txt'] as const) {
    await (globalThis as any).measureDocumentMemory('start', name);
    const started = performance.now(); let pages = 0, batches = 0, maxBatch = 0, totalUnits = 0, items = 0, buffer = 0, scan = false;
    let text = ''; let previousByte = 0; const seen = new Set<number>();
    for await (const event of extractDocument(source(name))) {
      if (event.kind === 'document') buffer = event.sourceBufferBytes;
      if (event.kind === 'text') {
        batches++; maxBatch = Math.max(maxBatch, event.text.length); totalUnits += event.text.length;
        assert(event.sha256 === manifest[name].sha256 && event.attachmentId === fixtureId(name), 'Source provenance lost');
        assert(event.text.length <= LIMITS.batchUTF16, 'Output credit exceeds bound');
        if (name === 'unicode.txt' || name === 'pages-1.pdf') text += event.text;
        for (const span of event.spans) {
          if (span.source && 'itemIndex' in span.source) { assert(span.source.itemEnd - span.source.itemStart === span.outputEnd - span.outputStart, 'PDF source item span mismatch'); seen.add(span.source.itemIndex); }
          if (span.source && 'byteStart' in span.source) { assert(span.source.byteStart === previousByte, 'UTF8 source byte continuity'); previousByte = span.source.byteEnd; }
        }
      }
      if (event.kind === 'page-end') { pages++; items = Math.max(items, event.items); scan ||= event.classification === 'possible_scanned'; assert(event.cleanup, 'Page not released'); }
    }
    if (name === 'pages-1.pdf') assert(text.includes('Quixi document fixture page 1') && seen.size >= 5, 'Actual PDF text absent');
    if (name === 'unicode.txt') { const original = await (await fetch('/fixtures/unicode.txt')).text(); assert(text.replace(/^\ufeff/, '') === original && previousByte === manifest[name].bytes, 'UTF8 exact text/source bytes mismatch'); }
    if (name === 'scanned.pdf') assert(scan && totalUnits === 0, 'Scanned outcome not explicit');
    if (name === 'actions.pdf') assert(!(globalThis as any).__quixiEmbeddedAction, 'Embedded action ran');
    const processMemory = await (globalThis as any).measureDocumentMemory('end', name);
    checks.push({ name, processMemory, pages, batches, maxBatch, totalUnits, maxPageItems: items, possibleScanned: scan, parserSourceBufferBytes: buffer, elapsedMs: Math.round(performance.now() - started) });
  }
  for (const [name, expected] of [['encrypted.pdf', 'PASSWORD_REQUIRED'], ['malformed.pdf', 'PARSE_FAILED'], ['pages-1001.pdf', 'CAPACITY'], ['dense-page.pdf', 'CAPACITY'], ['invalid-utf8.txt', 'PARSE_FAILED']] as const) {
    let code: string | undefined;
    try { for await (const _ of extractDocument(source(name))) {} } catch (e) { code = e instanceof ExtractionError ? e.code : String(e); }
    assert(code === expected, `${name}: expected ${expected}, got ${code}`); checks.push({ name, code });
  }
  const controller = new AbortController(); let cancelled: unknown; let received = 0;
  try { for await (const event of extractDocument(source('pages-1000.pdf'), { signal: controller.signal })) { if (event.kind === 'page-end' && ++received === 2) controller.abort(); } } catch (e) { cancelled = e instanceof ExtractionError ? e.code : String(e); }
  assert(cancelled === 'CANCELLED' && received === 2, 'Cancellation did not stop after page boundary');
  checks.push({ name: 'cancel', code: cancelled, completedPages: received });
  let resumed = 0;
  for await (const event of extractDocument(source('pages-100.pdf'), { startPage: 98 })) if (event.kind === 'page-end') { assert(event.page === 98 + resumed, 'Resume page is wrong'); resumed++; }
  assert(resumed === 3, 'Resume missing pages'); checks.push({ name: 'resume', pages: resumed });
  const pull = extractDocument(source('pages-100.pdf')); await pull.next(); let concurrentCode: string | undefined; try { await extractDocument(source('pages-1.pdf')).next(); } catch (e) { concurrentCode = (e as ExtractionError).code; } assert(concurrentCode === 'CAPACITY', 'Concurrent extraction bypassed admission'); checks.push({ name: 'job-admission', code: concurrentCode });
  const before = ranges; await new Promise(resolve => setTimeout(resolve, 100)); assert(ranges === before, 'Parser read ahead without output credit'); await pull.return(undefined); checks.push({ name: 'backpressure', additionalReads: ranges - before });
  let capacity: string | undefined;
  try { await extractDocument({ ...source('pages-1.pdf'), byteLength: LIMITS.sourceBytes + 1 }).next(); } catch (e) { capacity = (e as ExtractionError).code; }
  assert(capacity === 'CAPACITY', 'Oversized source accepted'); checks.push({ name: 'source-cap', code: capacity });
  let integrity: string | undefined;
  try { await extractDocument({ ...source('pages-1.pdf'), sha256: '0'.repeat(64) }).next(); } catch (e) { integrity = (e as ExtractionError).code; }
  assert(integrity === 'INTEGRITY', 'Altered source accepted'); checks.push({ name: 'source-integrity', code: integrity });
  let timeoutCode: string | undefined;
  try { await extractDocument({ ...source('pages-1.pdf'), readRange: () => new Promise(() => {}) }, { watchdogMs: 20 }).next(); } catch (e) { timeoutCode = (e as ExtractionError).code; }
  assert(timeoutCode === 'TIMEOUT', 'Stalled source did not time out'); checks.push({ name: 'watchdog', code: timeoutCode });
  const stalled = extractDocument(source('pages-1.pdf'), { watchdogMs: 500 });
  await stalled.next(); assert(activeWorkers === 2, 'Two real workers were not owned');
  const priorTerminated = terminatedWorkers; stallNext = true;
  let parserTimeout: string | undefined;
  try { await stalled.next(); } catch (e) { parserTimeout = (e as ExtractionError).code; } finally { stallNext = false; }
  assert(parserTimeout === 'TIMEOUT' && Number(activeWorkers) === 0 && terminatedWorkers - priorTerminated === 2, 'Watchdog did not terminate both real workers');
  checks.push({ name: 'worker-watchdog', code: parserTimeout, terminatedWorkers: terminatedWorkers - priorTerminated });
  const blocked = new AbortController(); let sourceCancelled: string | undefined;
  const startedCancel = performance.now();
  const blockedRead = extractDocument({ ...source('pages-1.pdf'), readRange: () => new Promise(() => {}) }, { signal: blocked.signal }).next();
  setTimeout(() => blocked.abort(), 10);
  try { await blockedRead; } catch (e) { sourceCancelled = (e as ExtractionError).code; }
  assert(sourceCancelled === 'CANCELLED' && performance.now() - startedCancel < 500, 'Uncooperative source did not cancel promptly');
  checks.push({ name: 'source-cancel', code: sourceCancelled });
  const original = source('pages-1.pdf'); const mutable = { ...original }; const mutableOptions = { startPage: 1 };
  let mutated = false, snapshotPages = 0;
  mutable.readRange = async (...args) => {
    const bytes = await original.readRange(...args);
    if (!mutated) { mutated = true; mutable.attachmentId = 'changed'; mutable.sha256 = '0'.repeat(64); mutable.byteLength = 1; mutable.mediaType = 'text/plain'; mutable.readRange = async () => { throw new Error('Replaced reader must not run'); }; mutableOptions.startPage = 100; }
    return bytes;
  };
  for await (const event of extractDocument(mutable, mutableOptions)) {
    assert(event.attachmentId === original.attachmentId && event.sha256 === original.sha256, 'Caller mutation changed frozen provenance');
    if (event.kind === 'page-end') snapshotPages++;
  }
  assert(snapshotPages === 1 && mutated, 'Descriptor mutation fixture did not execute'); checks.push({ name: 'descriptor-snapshot', pages: snapshotPages });
  let rejectReads = false, callbackCode: string | undefined;
  const rejecting = source('pages-1000.pdf');
  try {
    for await (const event of extractDocument({ ...rejecting, readRange: (...args) => rejectReads ? Promise.reject(new Error('synthetic range failure')) : rejecting.readRange(...args) })) if (event.kind === 'document') rejectReads = true;
  } catch (e) { callbackCode = (e as ExtractionError).code; }
  assert(callbackCode === 'SOURCE_FAILED' && Number(activeWorkers) === 0, 'Callback rejection did not release workers'); checks.push({ name: 'callback-rejection', code: callbackCode });
  for (const [name, descriptor, expected] of [
    ['unbounded-id', { ...original, attachmentId: 'x'.repeat(100000) }, 'INTEGRITY'],
    ['non-bytes', { ...original, readRange: async () => ({ byteLength: original.byteLength, slice() { throw new Error('Must not call slice'); } }) as unknown as Uint8Array }, 'SOURCE_FAILED'],
  ] as const) {
    let code: string | undefined; try { await extractDocument(descriptor).next(); } catch (e) { code = (e as ExtractionError).code; }
    assert(code === expected, 'Unbounded or non-byte source boundary accepted'); checks.push({ name, code });
  }
  assert(Number(activeWorkers) === 0, 'Worker leaked after completion or cancellation');
  return { checks, activeWorkers, terminatedWorkers, ranges, maxRange, maxInFlight, userAgent: navigator.userAgent, limits: LIMITS, externalAction: (globalThis as any).__quixiEmbeddedAction ?? false };
}
(globalThis as any).runDocumentProof = run;
