import type { StorageClient } from '@quixi/core/contracts';
import { isQuixiId, validateEntityShape } from '@quixi/core/model';
import type { Attachment, Document } from '@quixi/core/model';
import { ExtractionError, LIMITS } from './contracts.ts';
import type { DocumentSource } from './contracts.ts';

export interface StoredPdfSource extends DocumentSource {
  readonly documentId: string;
  close(): Promise<void>;
}

function failure(message: string, cause?: unknown): ExtractionError {
  const error = new ExtractionError('SOURCE_FAILED', message);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ExtractionError('CANCELLED', 'Stored PDF source was cancelled.');
}
async function discard(storage: StorageClient, transferId: string): Promise<void> {
  const result = await storage.request(crypto.randomUUID(), 'discardBlobTransfer', { transferId });
  if (!result || typeof result.discarded !== 'boolean') throw failure('Invalid stored PDF release response.');
  // false is valid after final acknowledgement already released the child.
}

/** Pins one verified original file. Creation IDs are reserved by the public
 * protocol from requestId, so even a lost creation reply has a known cleanup ID.
 * This source never closes its caller's shared StorageClient or reopens a file.
 * Cancellation drains bounded outstanding storage calls before releasing pins. */
export async function openStoredPdfSource(storage: StorageClient, documentId: string, signal?: AbortSignal): Promise<StoredPdfSource> {
  aborted(signal);
  if (!isQuixiId(documentId)) throw failure('Invalid canonical document identity.');
  const rawDocument = await storage.request(crypto.randomUUID(), 'readEntity', { collection: 'documents', id: documentId });
  aborted(signal);
  if (validateEntityShape('documents', rawDocument).length) throw failure('Canonical document is missing or malformed.');
  const document = rawDocument as unknown as Document;
  if (document.id !== documentId) throw failure('Canonical document identity changed.');
  // Capture primitives before awaiting: caller-supplied objects cannot retarget
  // the source while the second canonical read is pending.
  const attachmentId = document.attachmentId;
  const rawAttachment = await storage.request(crypto.randomUUID(), 'readEntity', { collection: 'attachments', id: attachmentId });
  aborted(signal);
  if (validateEntityShape('attachments', rawAttachment).length) throw failure('Canonical attachment is missing or malformed.');
  const attachment = rawAttachment as unknown as Attachment;
  const mimeType = attachment.mimeType?.split(';')[0]?.trim().toLowerCase();
  if (attachment.id !== attachmentId || attachment.availability !== 'available' || mimeType !== 'application/pdf' ||
      typeof attachment.blobSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(attachment.blobSha256) ||
      !Number.isSafeInteger(attachment.sizeBytes) || attachment.sizeBytes! < 1 || attachment.sizeBytes! > LIMITS.sourceBytes)
    throw failure('Stored PDF requires an available immutable attachment of 1 byte to 32 MiB.');
  const sha256 = attachment.blobSha256, byteLength = attachment.sizeBytes!;
  const baseId = crypto.randomUUID();
  try {
    const base = await storage.request(baseId, 'readBlobTransfer', { sha256 });
    if (!base || base.transferId !== baseId || base.sha256 !== sha256 || base.byteLength !== byteLength)
      throw failure('Verified PDF descriptor differs from the canonical attachment.');
    aborted(signal);
  } catch (error) {
    try { await discard(storage, baseId); }
    catch (cleanup) { throw failure('PDF source creation failed and pin release is unconfirmed.', new AggregateError([error, cleanup])); }
    throw error;
  }

  let closing = false;
  let closePromise: Promise<void> | undefined;
  let terminal: unknown;
  let cleanupFailure: unknown;
  const active = new Set<Promise<Uint8Array>>();
  const check = (rangeSignal?: AbortSignal) => {
    aborted(signal); aborted(rangeSignal);
    if (terminal) throw failure('Stored PDF source failed; it cannot be reopened or retargeted.', terminal);
    if (closing) throw new ExtractionError('CANCELLED', 'Stored PDF source is closed.');
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    signal?.removeEventListener('abort', onAbort);
    closePromise = (async () => {
      await Promise.allSettled([...active]);
      try { await discard(storage, baseId); }
      catch (error) { cleanupFailure ??= error; }
      if (cleanupFailure) throw failure('Stored PDF pin release is unconfirmed.', cleanupFailure);
    })();
    return closePromise;
  };
  const onAbort = () => { void close().catch(() => {}); };
  const poison = (error: unknown) => {
    terminal ??= error;
    // Do not await our own in-flight promise from inside readRange.
    void close().catch(() => {});
  };
  const range = async (offset: number, length: number, rangeSignal: AbortSignal): Promise<Uint8Array> => {
    const childId = crypto.randomUUID();
    try {
      const child = await storage.request(childId, 'sliceBlobTransfer', { transferId: baseId, offset, byteLength: length });
      if (!child || child.transferId !== childId || child.sha256 !== sha256 || child.byteLength !== byteLength ||
          child.range?.offset !== offset || child.range.byteLength !== length)
        throw failure('Stored PDF range descriptor differs from its pinned original.');
      check(rangeSignal);
      const output = new Uint8Array(length);
      let received = 0, sequence = 0;
      while (received < length) {
        const chunk = await storage.readChunk(childId);
        check(rangeSignal);
        if (!chunk || chunk.transferId !== childId || chunk.sequence !== sequence || chunk.offset !== received ||
            !(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength < 1 || chunk.bytes.byteLength > length - received ||
            chunk.final !== (received + chunk.bytes.byteLength === length))
          throw failure('Stored PDF range chunk has an invalid identity, sequence, offset, size or final marker.');
        output.set(chunk.bytes, received);
        received += chunk.bytes.byteLength;
        await storage.acknowledgeChunk({ transferId: childId, sequence, committedOffset: received });
        check(rangeSignal);
        sequence++;
      }
      return output;
    } catch (error) {
      if (!(error instanceof ExtractionError && error.code === 'CANCELLED')) poison(error);
      throw error;
    } finally {
      try { await discard(storage, childId); }
      catch (error) { cleanupFailure ??= error; poison(error); throw failure('Stored PDF range release is unconfirmed.', error); }
    }
  };
  const source: StoredPdfSource = Object.freeze({
    documentId, attachmentId, sha256, byteLength, mediaType: 'application/pdf' as const,
    readRange(offset: number, length: number, rangeSignal: AbortSignal): Promise<Uint8Array> {
      try {
        check(rangeSignal);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > LIMITS.rangeBytes || offset > byteLength - length)
          throw failure('Stored PDF range exceeds the original or the 64 KiB read bound.');
        if (active.size >= LIMITS.pendingRanges) throw new ExtractionError('CAPACITY', 'At most four stored PDF ranges may be active.');
      } catch (error) { return Promise.reject(error); }
      const work = Promise.resolve().then(() => { check(rangeSignal); return range(offset, length, rangeSignal); });
      active.add(work);
      void work.then(() => active.delete(work), () => active.delete(work));
      return work;
    },
    close,
  });
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) { await close(); aborted(signal); }
  return source;
}

/** One producer per archive/document across owner contexts. The browser releases
 * the exclusive lock on context death. Collision fails immediately; no waiter
 * may later start an extraction against stale captured workflow state. Once
 * granted, cancellation does not release the lease: the caller must await its
 * parser/source cleanup and interruption checkpoint before explicit release. */
export async function acquireStoredPdfProducerLease(archiveId: string, documentId: string, signal?: AbortSignal): Promise<{ release(): Promise<void> }> {
  aborted(signal);
  if (typeof archiveId !== 'string' || archiveId.length < 1 || archiveId.length > 128 || !isQuixiId(documentId))
    throw failure('Invalid PDF producer lease identity.');
  const locks = globalThis.navigator?.locks;
  if (!locks) throw failure('PDF extraction requires browser Web Locks.');
  let releaseHold!: () => void;
  const hold = new Promise<void>(resolve => { releaseHold = resolve; });
  let resolveAcquired!: () => void, rejectAcquired!: (error: unknown) => void;
  const acquired = new Promise<void>((resolve, reject) => { resolveAcquired = resolve; rejectAcquired = reject; });
  let granted = false;
  const onAbort = () => { if (!granted) releaseHold(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const task = locks.request(`quixi:pdf-producer:v1:${JSON.stringify([archiveId, documentId])}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) { rejectAcquired(new ExtractionError('CAPACITY', 'A PDF extraction producer is already active for this document.')); return; }
    if (signal?.aborted) { rejectAcquired(new ExtractionError('CANCELLED', 'PDF producer lease was cancelled.')); return; }
    granted = true;
    resolveAcquired();
    await hold;
  });
  void task.catch(rejectAcquired);
  void task.then(() => signal?.removeEventListener('abort', onAbort), () => signal?.removeEventListener('abort', onAbort));
  try { await acquired; }
  catch (error) { releaseHold(); await task.catch(() => {}); throw error; }
  return Object.freeze({ async release() { releaseHold(); await task; } });
}
