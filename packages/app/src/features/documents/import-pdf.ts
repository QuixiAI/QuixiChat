import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CommitResult, HostClient, HostFile, MutationBatch, StorageClient } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import type { Attachment, Document } from '@quixi/core/model';

const MAX_BYTES = 32 * 1024 * 1024, HOST_CHUNK = 1024 * 1024, WRITE_CHUNK = 65536;
const next = () => crypto.randomUUID();
function fail(message: string, code = 'INVALID_REQUEST'): Error {
  return Object.assign(new Error(message), { code });
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw fail('PDF import was cancelled.', 'CANCELLED');
}
function boundaryCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: string; error?: { code?: string } };
  return value.error?.code ?? value.code;
}
const terminal = (error: unknown) => ['INVALID_REQUEST', 'UNSUPPORTED', 'CONFLICT', 'NOT_FOUND', 'CANCELLED', 'QUOTA_EXCEEDED', 'MIGRATION_FAILED'].includes(boundaryCode(error) ?? '');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
type PendingState = { storage: StorageClient; committed: boolean; uncertain: boolean; done: boolean; inFlight?: Promise<Document> | undefined };
const pendingStates = new WeakMap<PendingDocumentImportError, PendingState>();

/** Retain this object until reconciliation succeeds or a definitive rejection
 * is returned. Never replace its UUIDs, original batch or verified stage. It is
 * bound to the exact captured StorageClient, not the currently selected archive.
 * A confirmed commit whose final stage release failed also remains reconcilable. */
export class PendingDocumentImportError extends Error {
  readonly code = 'UNKNOWN_OUTCOME';
  constructor(readonly batch: MutationBatch, readonly document: Document, cause: unknown = null) {
    super('PDF import requires reconciliation; retain its original operation identities and staged bytes.');
    this.name = 'PendingDocumentImportError';
    Object.defineProperty(this, 'cause', { value: cause, writable: true });
    Object.defineProperty(this, 'batch', { writable: false });
    Object.defineProperty(this, 'document', { writable: false });
    freeze(batch); freeze(document);
  }
  get committed(): boolean { return pendingStates.get(this)?.committed ?? false; }
}

async function discard(storage: StorageClient, transferId: string): Promise<void> {
  const result = await storage.request(next(), 'discardBlobTransfer', { transferId });
  if (!result || typeof result.discarded !== 'boolean') throw fail('PDF stage release is unconfirmed.', 'UNKNOWN_OUTCOME');
}
function assertCommit(result: CommitResult, batch: MutationBatch): void {
  if (!result || result.transactionId !== batch.transactionId || !Array.isArray(result.operations) || result.operations.length !== batch.mutations.length ||
      result.operations.some((entry, index) => !entry || entry.operationId !== batch.mutations[index]!.operationId || !['committed', 'already_committed'].includes(entry.outcome)))
    throw fail('PDF commit acknowledgement does not match the original atomic batch.', 'UNKNOWN_OUTCOME');
}
async function commitPending(pending: PendingDocumentImportError): Promise<Document> {
  const state = pendingStates.get(pending)!;
  if (state.done) return pending.document;
  if (!state.committed) {
    try {
      const result = await state.storage.request(next(), 'commit', pending.batch);
      assertCommit(result, pending.batch);
      state.committed = true;
    } catch (error) {
      pending.cause = error;
      // A later dispatch refusal says nothing about an earlier lost commit.
      // Selection fences can surface as generic CONFLICT/CANCELLED, including
      // after status reads succeeded. Preserve the original recovery object and
      // stage until an exact acknowledgement establishes that earlier outcome.
      if (state.uncertain || !terminal(error)) { state.uncertain = true; throw pending; }
      try { await discard(state.storage, pending.batch.stagedBlobIds[0]!); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'PDF commit was rejected; stage cleanup is unconfirmed.'); }
      throw error;
    }
  }
  try { await discard(state.storage, pending.batch.stagedBlobIds[0]!); }
  catch (error) { pending.cause = error; throw pending; }
  state.done = true;
  return pending.document;
}

/** Checks receipt coherence, then retries the exact batch to validate its full
 * transaction/payload identity. A status miss never authorizes fresh UUIDs.
 * Concurrent reconciliation callers join one attempt. No archive lookup occurs. */
export function reconcileDocumentImport(storage: StorageClient, pending: PendingDocumentImportError): Promise<Document> {
  const state = pendingStates.get(pending);
  if (!state || state.storage !== storage) return Promise.reject(fail('PDF recovery must use the original captured storage client.', 'CONFLICT'));
  if (state.inFlight) return state.inFlight;
  const work = (async () => {
    if (!state.committed) {
      try {
        const statuses = [];
        for (const mutation of pending.batch.mutations) {
          const result = await storage.request(next(), 'operationStatus', { operationId: mutation.operationId });
          if (!result || !['committed', 'not_found'].includes(result.status) || (result.status === 'not_found' && result.result !== null)) throw pending;
          statuses.push(result.status);
        }
        if (new Set(statuses).size !== 1) throw pending;
      } catch (error) { if (error !== pending) pending.cause = error; throw pending; }
    }
    return commitPending(pending);
  })();
  state.inFlight = work;
  void work.then(() => { state.inFlight = undefined; }, () => { state.inFlight = undefined; });
  return work;
}

/** Picks one PDF and streams/hash-checks the immutable original into bounded
 * staging. No file URL, SQL, full-file buffer or shared-client close is used.
 * Once commit dispatch begins, cancellation cannot erase its observed outcome. */
export async function importPdf(options: { storage: StorageClient; host: HostClient; workspaceId: string; signal?: AbortSignal }): Promise<Document> {
  const { storage, host, workspaceId, signal } = options;
  check(signal);
  if (!isQuixiId(workspaceId)) throw fail('Invalid PDF workspace identity.');
  const files = await host.chooseFiles(next(), { multiple: false, mediaTypes: ['application/pdf'] });
  let file: HostFile | undefined;
  let hostTransferId: string | undefined, openRequestId: string | undefined;
  let stageId: string | undefined, beginOperationId: string | undefined;
  let stageOwnedByCommit = false;
  const releaseHost = async () => {
    const errors: unknown[] = [];
    if (hostTransferId) {
      const transferId = hostTransferId; hostTransferId = undefined;
      try { await host.releaseTransfer(next(), transferId); } catch (error) { errors.push(error); }
    } else if (openRequestId) {
      try { await host.cancel(openRequestId); } catch (error) { errors.push(error); }
    }
    openRequestId = undefined;
    if (Array.isArray(files)) for (const selected of files.slice(0, 256)) {
      if (selected && isQuixiId(selected.id)) {
        try { await host.releaseFile(next(), selected.id); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'PDF host resource cleanup is unconfirmed.');
  };
  let hostReleased = false;
  try {
    check(signal);
    if (!Array.isArray(files) || files.length !== 1) throw fail(files?.length === 0 ? 'No PDF was selected.' : 'Choose exactly one PDF.', files?.length === 0 ? 'CANCELLED' : 'INVALID_REQUEST');
    file = files[0];
    if (!file || !isQuixiId(file.id) || typeof file.name !== 'string' || file.name.length < 1 || file.name.length > 1024 ||
        !(file.mediaType === null || typeof file.mediaType === 'string') || !Number.isSafeInteger(file.byteLength) || file.byteLength! < 1 || file.byteLength! > MAX_BYTES)
      throw fail('Choose a local PDF of 1 byte to 32 MiB with a known size.');
    const mime = file.mediaType?.split(';')[0]?.trim().toLowerCase();
    if (mime ? mime !== 'application/pdf' : !/\.pdf$/i.test(file.name)) throw fail('The selected file is not a PDF.');
    const filename = file.name, byteLength = file.byteLength!;
    openRequestId = next();
    const input = await host.openFileTransfer(openRequestId, file.id);
    if (input && isQuixiId(input.transferId)) hostTransferId = input.transferId;
    if (!hostTransferId || !Number.isSafeInteger(input.maxChunkBytes) || input.maxChunkBytes < 1 || input.maxChunkBytes > HOST_CHUNK ||
        !Number.isSafeInteger(input.maxInFlight) || input.maxInFlight < 1 || input.maxInFlight > 4) throw fail('Invalid bounded host PDF transfer.');
    check(signal);
    beginOperationId = next();
    const stage = await storage.request(next(), 'beginBlobTransfer', { operationId: beginOperationId, purpose: 'document', expectedBytes: byteLength, expectedSha256: null });
    if (stage && isQuixiId(stage.transferId)) stageId = stage.transferId;
    if (!stageId || !Number.isSafeInteger(stage.maxChunkBytes) || stage.maxChunkBytes < 1 || stage.maxChunkBytes > HOST_CHUNK ||
        !Number.isSafeInteger(stage.maxInFlight) || stage.maxInFlight < 1 || stage.maxInFlight > 4) throw fail('Invalid bounded PDF storage transfer.');
    check(signal);
    const hash = sha256.create();
    const signature = new Uint8Array(5); let signatureLength = 0;
    let offset = 0, sequence = 0, uploadOffset = 0, uploadSequence = 0;
    const send = async (bytes: Uint8Array, final: boolean) => {
      const size = bytes.byteLength;
      const ack = await storage.sendChunk({ transferId: stageId!, sequence: uploadSequence, offset: uploadOffset, bytes, final });
      if (!ack || ack.transferId !== stageId || ack.sequence !== uploadSequence || ack.committedOffset !== uploadOffset + size)
        throw fail('PDF storage acknowledgement has an invalid identity or offset.');
      uploadOffset += size; uploadSequence++; check(signal);
    };
    while (true) {
      check(signal);
      const chunk = await host.readChunk(hostTransferId); check(signal);
      if (!chunk || chunk.transferId !== hostTransferId || chunk.sequence !== sequence || chunk.offset !== offset || !(chunk.bytes instanceof Uint8Array) ||
          typeof chunk.final !== 'boolean' || chunk.bytes.length > input.maxChunkBytes || chunk.bytes.length > byteLength - offset ||
          (!chunk.bytes.length && !chunk.final) || (chunk.final && offset + chunk.bytes.length !== byteLength))
        throw fail('PDF host bytes changed or their transfer was malformed.');
      const size = chunk.bytes.byteLength;
      for (let i = 0; signatureLength < 5 && i < size; i++) signature[signatureLength++] = chunk.bytes[i]!;
      if (signatureLength === 5 && !signature.every((byte, i) => byte === [37, 80, 68, 70, 45][i])) throw fail('Selected bytes do not begin with a PDF header.');
      hash.update(chunk.bytes);
      for (let start = 0; start < size; start += Math.min(WRITE_CHUNK, stage.maxChunkBytes))
        await send(chunk.bytes.slice(start, start + Math.min(WRITE_CHUNK, stage.maxChunkBytes)), false);
      offset += size;
      await host.acknowledgeChunk({ transferId: hostTransferId, sequence, committedOffset: offset });
      check(signal); sequence++;
      if (chunk.final) break;
    }
    if (signatureLength !== 5) throw fail('Selected bytes do not contain a PDF header.');
    await send(new Uint8Array(), true);
    const digest = bytesToHex(hash.digest());
    const verified = await storage.request(next(), 'finishBlobTransfer', { operationId: next(), transferId: stageId, expectedBytes: byteLength, expectedSha256: digest });
    if (!verified || verified.transferId !== stageId || verified.sha256 !== digest || verified.byteLength !== byteLength || verified.state !== 'verified_staged')
      throw fail('Stored PDF verification differs from the original.');
    check(signal);
    // Release host resources before the canonical write, so host cleanup cannot
    // turn known canonical success into an unrelated apparent import failure.
    hostReleased = true; await releaseHost(); check(signal);
    const now = Date.now();
    const attachment: Attachment = { id: next(), availability: 'available', filename, mimeType: 'application/pdf', sizeBytes: byteLength, blobSha256: digest, rawObjectId: null };
    const document: Document = { id: next(), workspaceId, attachmentId: attachment.id, title: filename.replace(/\.pdf$/i, '').trim() || 'PDF document', createdAt: now, recordedAt: now, importSourceId: null };
    const batch: MutationBatch = { transactionId: next(), expectedThreadRevisions: [], stagedBlobIds: [stageId], mutations: [
      { version: 1, operationId: next(), kind: 'RegisterAttachment', recordedAt: now, payload: { attachment } },
      { version: 1, operationId: next(), kind: 'RegisterDocument', recordedAt: now, payload: { document } },
    ] };
    const pending = new PendingDocumentImportError(batch, document, null);
    pendingStates.set(pending, { storage, committed: false, uncertain: false, done: false });
    stageOwnedByCommit = true;
    return await commitPending(pending);
  } catch (error) {
    const cleanup: unknown[] = [];
    if (!stageOwnedByCommit) {
      if (!stageId && beginOperationId) {
        try {
          const status = await storage.request(next(), 'operationStatus', { operationId: beginOperationId });
          if (status.status === 'committed') {
            const transferId = (status.result as { transferId?: unknown } | null)?.transferId;
            if (!isQuixiId(transferId)) throw fail('Upload creation status has no valid cleanup identity.', 'UNKNOWN_OUTCOME');
            stageId = transferId;
          } else if (status.status !== 'not_found') throw fail('Upload creation outcome is unknown.', 'UNKNOWN_OUTCOME');
        } catch (statusError) { cleanup.push(statusError); }
      }
      if (stageId) try { await discard(storage, stageId); } catch (releaseError) { cleanup.push(releaseError); }
    }
    if (!hostReleased) { hostReleased = true; try { await releaseHost(); } catch (releaseError) { cleanup.push(releaseError); } }
    if (cleanup.length) throw new AggregateError([error, ...cleanup], 'PDF import failed and resource cleanup is unconfirmed.');
    throw error;
  }
}
