import { isQuixiId } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ExtractionError, LIMITS } from './contracts';
import type { DocumentSource, ExtractionEvent, ExtractionOptions } from './contracts';
export * from './contracts';
let extractionActive = false;

/** Pulling the next event is the sole output credit. Both real workers are owned here. */
export async function* extractDocument(inputSource: DocumentSource, inputOptions: ExtractionOptions = {}): AsyncGenerator<ExtractionEvent> {
  if (!inputSource || typeof inputSource.readRange !== 'function') throw new ExtractionError('SOURCE_FAILED', 'Missing immutable source reader.');
  // Copy once before the first await; callers cannot retarget a running extraction.
  const source = Object.freeze({ attachmentId: inputSource.attachmentId, sha256: inputSource.sha256, byteLength: inputSource.byteLength, mediaType: inputSource.mediaType, readRange: inputSource.readRange.bind(inputSource) });
  const options = Object.freeze({ signal: inputOptions.signal, startPage: inputOptions.startPage, watchdogMs: inputOptions.watchdogMs });
  if (!Number.isSafeInteger(source.byteLength) || source.byteLength < 1 || source.byteLength > LIMITS.sourceBytes) throw new ExtractionError('CAPACITY', 'Source must contain 1 byte through 32 MiB.');
  if (typeof source.sha256 !== 'string' || source.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(source.sha256) || !isQuixiId(source.attachmentId) || !['application/pdf', 'text/plain', 'text/markdown'].includes(source.mediaType)) throw new ExtractionError('INTEGRITY', 'Invalid immutable source descriptor.');
  const startPage = options.startPage ?? 1;
  if (!Number.isInteger(startPage) || startPage < 1 || startPage > LIMITS.pages) throw new ExtractionError('CAPACITY', 'Invalid resume page.');
  const timeout = options.watchdogMs ?? LIMITS.watchdogMs;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > LIMITS.watchdogMs) throw new ExtractionError('CAPACITY', 'Invalid watchdog.');
  if (extractionActive) throw new ExtractionError('CAPACITY', 'This realm already has an active extraction.');
  const controller = new AbortController();
  let conductor: Worker | undefined, parser: Worker | undefined;
  let rejectPending: ((error: unknown) => void) | undefined;
  let fatal: ExtractionError | undefined;
  const fail = (error: ExtractionError) => { fatal ??= error; controller.abort(); conductor?.terminate(); parser?.terminate(); rejectPending?.(fatal); };
  const aborted = () => fail(new ExtractionError('CANCELLED', 'Extraction cancelled; current page must be discarded.'));
  options.signal?.addEventListener('abort', aborted, { once: true });
  if (options.signal?.aborted) aborted();
  const read = async (offset: number, length: number) => {
    if (fatal) throw fatal;
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || length > LIMITS.rangeBytes || offset + length > source.byteLength) throw new ExtractionError('CAPACITY', 'Invalid source range.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortRead: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => { abortRead = () => reject(fatal ?? new ExtractionError('CANCELLED', 'Source read cancelled.')); controller.signal.addEventListener('abort', abortRead, { once: true }); });
      const bytes = await Promise.race([cancelled, source.readRange(offset, length, controller.signal), new Promise<never>((_, reject) => { timer = setTimeout(() => { const e = new ExtractionError('TIMEOUT', 'Source range timed out.'); fail(e); reject(e); }, timeout); })]);
      if (fatal) throw fatal;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) throw new ExtractionError('SOURCE_FAILED', 'Source returned a short range.');
      return bytes.slice();
    } catch (e) { throw e instanceof ExtractionError ? e : new ExtractionError('SOURCE_FAILED', 'Immutable source read failed.'); } finally { clearTimeout(timer); if (abortRead) controller.signal.removeEventListener('abort', abortRead); }
  };
  extractionActive = true;
  try {
    // Verify before dispatch, bounded to one source range. A trusted storage adapter may cache its own verification.
    const hash = sha256.create();
    for (let offset = 0; offset < source.byteLength; offset += LIMITS.rangeBytes) hash.update(await read(offset, Math.min(LIMITS.rangeBytes, source.byteLength - offset)));
    if (bytesToHex(hash.digest()) !== source.sha256) throw new ExtractionError('INTEGRITY', 'Original source hash differs.');
    conductor = new Worker(new URL('./worker/index.ts', import.meta.url), { type: 'module', name: 'quixi-document-extractor' });
    parser = new Worker(new URL('./worker/parser.ts', import.meta.url), { type: 'module', name: 'quixi-pdf-parser' });
    const channel = new MessageChannel();
    parser.postMessage({ port: channel.port1 }, [channel.port1]);
    conductor.postMessage({ kind: 'init', port: channel.port2, source: { attachmentId: source.attachmentId, sha256: source.sha256, byteLength: source.byteLength, mediaType: source.mediaType }, startPage }, [channel.port2]);
    let settle: ((value: IteratorResult<ExtractionEvent>) => void) | undefined;
    let reading = 0;
    conductor.onmessage = ({ data }) => {
      if (data.kind === 'read') {
        if (++reading > LIMITS.pendingRanges) { fail(new ExtractionError('CAPACITY', 'Too many source reads.')); return; }
        void read(data.offset, data.length).then(bytes => conductor?.postMessage({ kind: 'range', id: data.id, bytes }, [bytes.buffer]), e => fail(e instanceof ExtractionError ? e : new ExtractionError('SOURCE_FAILED', String(e)))).finally(() => reading--);
      } else if (data.kind === 'result') settle?.(data.result);
      else if (data.kind === 'failure') fail(new ExtractionError(data.code, data.message));
    };
    conductor.onerror = parser.onerror = event => { event.preventDefault(); fail(new ExtractionError('PARSE_FAILED', event.message || 'Worker failed.')); };
    while (!fatal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await new Promise<IteratorResult<ExtractionEvent>>((resolve, reject) => {
          settle = resolve; rejectPending = reject;
          timer = setTimeout(() => fail(new ExtractionError('TIMEOUT', 'Parser step timed out; both workers terminated.')), timeout);
          conductor!.postMessage({ kind: 'next' });
        });
        clearTimeout(timer); settle = undefined; rejectPending = undefined;
        if (result.done) return;
        yield result.value;
      } finally { clearTimeout(timer); }
    }
    throw fatal;
  } finally {
    extractionActive = false;
    controller.abort(); conductor?.terminate(); parser?.terminate(); options.signal?.removeEventListener('abort', aborted);
  }
}
