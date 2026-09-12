/** Controlled host/storage protocol tests; real OPFS and host picker integration
 * are separate browser evidence. Run with Node --experimental-transform-types --test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { assertStorageRequest } from '@quixi/core/contracts';
import type { ByteChunk, HostClient, HostFile, MutationBatch, StorageClient, StorageRequest } from '@quixi/core/contracts';
import { validateEntityShape } from '@quixi/core/model';
import { importPdf, PendingDocumentImportError, reconcileDocumentImport } from '../../src/features/documents/import-pdf.ts';

const id = () => randomUUID();
const error = (code: string) => Object.assign(new Error(code), { code });
const code = (value: string) => (e: unknown) => (e as { code?: string }).code === value;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const bytes = Uint8Array.from({ length: 150123 }, (_, index) => index % 251); bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  const file: HostFile = { id: id(), name: '資料.pdf', mediaType: 'application/pdf', byteLength: bytes.length };
  const hostId = id(), stageId = id(), workspaceId = id();
  const calls: { kind: string; value?: unknown }[] = [];
  const uploads: Uint8Array[] = [], batches: MutationBatch[] = [];
  const receipts = new Map<string, unknown>();
  let beginOperationId: string | undefined, hostOffset = 0, hostSequence = 0, uploadOffset = 0, uploadSequence = 0;
  const knobs: {
    files?: HostFile[]; hostChunk: number; hostFinalData: boolean;
    chunk?: (chunk: ByteChunk) => ByteChunk;
    stageDescriptor?: Record<string, unknown>; finishDescriptor?: Record<string, unknown>;
    beginError?: unknown; ackError?: unknown; commitError?: unknown;
    commitAfterEffect: boolean; badCommit: boolean; releaseError?: unknown;
    statusError?: unknown; statusOverride?: string[]; beforeCommit?: () => Promise<void>;
    afterChunk?: () => void; detachUpload: boolean; stageLive: boolean; hostLive: boolean;
  } = { hostChunk: 100000, hostFinalData: false, commitAfterEffect: false, badCommit: false, detachUpload: true, stageLive: false, hostLive: false };
  const host = {
    async chooseFiles(_requestId: string, options: unknown) { calls.push({ kind: 'choose', value: options }); return knobs.files ?? [file]; },
    async openFileTransfer() { knobs.hostLive = true; calls.push({ kind: 'open-host' }); return { transferId: hostId, maxChunkBytes: knobs.hostChunk, maxInFlight: 4 }; },
    async readChunk() {
      const size = Math.min(bytes.length - hostOffset, knobs.hostChunk);
      const chunk = { transferId: hostId, sequence: hostSequence++, offset: hostOffset, bytes: bytes.slice(hostOffset, hostOffset + size), final: knobs.hostFinalData ? hostOffset + size === bytes.length : size === 0 };
      hostOffset += size; knobs.afterChunk?.();
      return knobs.chunk?.(chunk) ?? chunk;
    },
    async acknowledgeChunk(ack: unknown) { calls.push({ kind: 'host-ack', value: ack }); },
    async releaseTransfer(_requestId: string, transferId: string) { assert.equal(transferId, hostId); knobs.hostLive = false; calls.push({ kind: 'release-host' }); },
    async releaseFile(_requestId: string, fileId: string) { calls.push({ kind: 'release-file', value: fileId }); },
    async cancel(requestId: string) { knobs.hostLive = false; calls.push({ kind: 'cancel-host', value: requestId }); return { requestId, outcome: 'cancelled', externalEffect: 'not_dispatched' }; },
  } as unknown as HostClient;
  const storage = {
    async request(requestId: string, operation: string, args: any) {
      assertStorageRequest({ version: 1, requestId, operation, args } as StorageRequest);
      calls.push({ kind: operation, value: args });
      switch (operation) {
        case 'beginBlobTransfer': {
          beginOperationId = args.operationId;
          knobs.stageLive = true;
          const result = { transferId: stageId, maxChunkBytes: 1048576, maxInFlight: 4 };
          receipts.set(args.operationId, result);
          if (knobs.beginError) throw knobs.beginError;
          return { ...result, ...knobs.stageDescriptor };
        }
        case 'finishBlobTransfer': {
          assert.equal(args.transferId, stageId); assert.equal(args.expectedBytes, bytes.length);
          assert.equal(args.expectedSha256, createHash('sha256').update(bytes).digest('hex'));
          assert.deepEqual(Buffer.concat(uploads), Buffer.from(bytes));
          return { transferId: stageId, byteLength: bytes.length, sha256: args.expectedSha256, state: 'verified_staged', ...knobs.finishDescriptor };
        }
        case 'commit': {
          batches.push(args); await knobs.beforeCommit?.();
          assert.ok(!knobs.hostLive, 'host transfer must be released before canonical write');
          assert.equal(validateEntityShape('attachments', args.mutations[0].payload.attachment).length, 0);
          assert.equal(validateEntityShape('documents', args.mutations[1].payload.document).length, 0);
          if (knobs.commitError && !knobs.commitAfterEffect) throw knobs.commitError;
          for (const mutation of args.mutations) receipts.set(mutation.operationId, { affected: [{ kind: mutation.kind === 'RegisterAttachment' ? 'attachment' : 'document', id: mutation.kind === 'RegisterAttachment' ? mutation.payload.attachment.id : mutation.payload.document.id }] });
          if (knobs.commitError) throw knobs.commitError;
          return { transactionId: knobs.badCommit ? id() : args.transactionId, operations: args.mutations.map((mutation: { operationId: string }) => ({ operationId: mutation.operationId, outcome: 'committed', result: receipts.get(mutation.operationId) })) };
        }
        case 'operationStatus': {
          if (knobs.statusError) throw knobs.statusError;
          const override = knobs.statusOverride?.shift();
          if (override) return { status: override, result: override === 'not_found' ? null : {} };
          return receipts.has(args.operationId) ? { status: 'committed', result: receipts.get(args.operationId) } : { status: 'not_found', result: null };
        }
        case 'discardBlobTransfer':
          assert.equal(args.transferId, stageId);
          if (knobs.releaseError) throw knobs.releaseError;
          knobs.stageLive = false; return { discarded: true };
        default: throw new Error('Unexpected storage call ' + operation);
      }
    },
    async sendChunk(chunk: ByteChunk) {
      assert.equal(chunk.transferId, stageId); assert.equal(chunk.sequence, uploadSequence++); assert.equal(chunk.offset, uploadOffset);
      assert.ok(chunk.bytes.length <= 65536); const size = chunk.bytes.length;
      calls.push({ kind: 'upload', value: { size, final: chunk.final } });
      uploads.push(knobs.detachUpload ? structuredClone(chunk.bytes, { transfer: [chunk.bytes.buffer] }) : chunk.bytes.slice());
      uploadOffset += size;
      if (knobs.ackError) throw knobs.ackError;
      return { transferId: stageId, sequence: chunk.sequence, committedOffset: uploadOffset };
    },
    async close() { throw new Error('Shared storage client must remain open'); },
  } as unknown as StorageClient;
  return { bytes, file, host, storage, knobs, calls, batches, receipts, stageId, workspaceId, begin: () => beginOperationId };
}
async function pendingImport(f: ReturnType<typeof fixture>): Promise<PendingDocumentImportError> {
  let pending: unknown;
  try { await importPdf(f); } catch (e) { pending = e; }
  assert.ok(pending instanceof PendingDocumentImportError); return pending;
}

test('streams original PDF in <=64 KiB copies, hashes exact bytes, and atomically registers real canonical shapes', async () => {
  const f = fixture(); f.file.mediaType = ' Application/PDF ; charset=binary';
  const document = await importPdf(f), batch = f.batches[0]!;
  assert.equal(batch.mutations.length, 2); assert.deepEqual(batch.stagedBlobIds, [f.stageId]);
  assert.equal(batch.mutations[0]!.kind, 'RegisterAttachment'); assert.equal(batch.mutations[1]!.kind, 'RegisterDocument');
  assert.equal(document.workspaceId, f.workspaceId); assert.equal(document.title, '資料');
  assert.equal(Object.isFrozen(batch), true); assert.equal(Object.isFrozen(document), true);
  assert.equal(new Set([batch.transactionId, document.id, document.attachmentId, ...batch.mutations.map(mutation => mutation.operationId)]).size, 5);
  assert.equal(f.knobs.stageLive, false); assert.equal(f.knobs.hostLive, false);
  assert.ok(f.calls.findIndex(call => call.kind === 'release-file') < f.calls.findIndex(call => call.kind === 'commit'));
});

test('null MIME uses PDF suffix plus actual header, and final data chunk is supported', async () => {
  const f = fixture(); f.file.mediaType = null; f.knobs.hostFinalData = true;
  await importPdf(f); assert.equal(f.knobs.stageLive, false);
});

test('file picker cancellation, extra selections and invalid metadata release selected handles before staging', async () => {
  for (const adjust of [
    (f: ReturnType<typeof fixture>) => { f.knobs.files = []; },
    (f: ReturnType<typeof fixture>) => { f.knobs.files = [f.file, { ...f.file, id: id() }]; },
    (f: ReturnType<typeof fixture>) => { f.file.byteLength = 0; },
    (f: ReturnType<typeof fixture>) => { f.file.byteLength = 32 * 1024 * 1024 + 1; },
    (f: ReturnType<typeof fixture>) => { f.file.byteLength = null; },
    (f: ReturnType<typeof fixture>) => { f.file.mediaType = 'text/plain'; },
  ]) {
    const f = fixture(); adjust(f); await assert.rejects(importPdf(f));
    assert.equal(f.calls.some(call => call.kind === 'beginBlobTransfer'), false);
    assert.equal(f.calls.filter(call => call.kind === 'release-file').length, (f.knobs.files ?? [f.file]).length);
  }
});

test('invalid PDF header, sequence, offset, ID, final and oversized host chunks clean known resources', async () => {
  for (const damage of [
    (chunk: ByteChunk) => ({ ...chunk, sequence: 1 }), (chunk: ByteChunk) => ({ ...chunk, offset: 1 }),
    (chunk: ByteChunk) => ({ ...chunk, transferId: id() }), (chunk: ByteChunk) => ({ ...chunk, final: true }),
    (chunk: ByteChunk) => ({ ...chunk, bytes: new Uint8Array(100001) }),
    (chunk: ByteChunk) => ({ ...chunk, bytes: new Uint8Array(chunk.bytes.length) }),
  ]) {
    const f = fixture(); f.knobs.chunk = damage;
    await assert.rejects(importPdf(f), code('INVALID_REQUEST'));
    assert.equal(f.knobs.stageLive, false); assert.equal(f.knobs.hostLive, false); assert.equal(f.batches.length, 0);
  }
});

test('precommit cancellation drains transfer and releases file/stage without canonical writes', async () => {
  const f = fixture(), controller = new AbortController(); f.knobs.afterChunk = () => controller.abort();
  await assert.rejects(importPdf({ ...f, signal: controller.signal }), code('CANCELLED'));
  assert.equal(f.knobs.stageLive, false); assert.equal(f.knobs.hostLive, false); assert.equal(f.batches.length, 0);
});

test('unknown upload creation reply resolves only its original operation status for cleanup, never restarts upload', async () => {
  const f = fixture(); f.knobs.beginError = error('UNKNOWN_OUTCOME');
  await assert.rejects(importPdf(f), code('UNKNOWN_OUTCOME'));
  assert.equal(f.knobs.stageLive, false); assert.equal(f.knobs.hostLive, false);
  assert.equal(f.calls.filter(call => call.kind === 'beginBlobTransfer').length, 1);
  assert.deepEqual(f.calls.find(call => call.kind === 'operationStatus')!.value, { operationId: f.begin() });
});

test('malformed finish metadata prevents canonical publication and releases stage', async () => {
  const f = fixture(); f.knobs.finishDescriptor = { sha256: '0'.repeat(64) };
  await assert.rejects(importPdf(f), code('INVALID_REQUEST'));
  assert.equal(f.batches.length, 0); assert.equal(f.knobs.stageLive, false);
});

for (const afterEffect of [false, true]) test(`unknown commit ${afterEffect ? 'after' : 'before'} effect retains exact batch/stage; reconciliation uses identical UUIDs and payload`, async () => {
  const f = fixture(); f.knobs.commitError = error('UNKNOWN_OUTCOME'); f.knobs.commitAfterEffect = afterEffect;
  const pending = await pendingImport(f), serialized = JSON.stringify(pending.batch);
  assert.equal(f.knobs.stageLive, true); assert.equal(f.knobs.hostLive, false);
  assert.equal(f.calls.some(call => call.kind === 'discardBlobTransfer'), false);
  assert.throws(() => { pending.batch.transactionId = id(); }, TypeError);
  assert.throws(() => { (pending as any).batch = {}; }, TypeError);
  f.knobs.commitError = undefined;
  const document = await reconcileDocumentImport(f.storage, pending);
  assert.equal(document, pending.document); assert.equal(f.batches.length, 2);
  assert.ok(f.batches.every(batch => JSON.stringify(batch) === serialized));
  assert.equal(f.batches[0], f.batches[1]); assert.equal(f.knobs.stageLive, false);
});

test('status uncertainty or partial atomic receipts retain pending state without retry or discard', async () => {
  const f = fixture(); f.knobs.commitError = error('UNKNOWN_OUTCOME'); const pending = await pendingImport(f);
  f.knobs.statusError = error('CLOSED');
  await assert.rejects(reconcileDocumentImport(f.storage, pending), e => e === pending);
  f.knobs.statusError = undefined; f.knobs.statusOverride = ['committed', 'not_found'];
  await assert.rejects(reconcileDocumentImport(f.storage, pending), e => e === pending);
  assert.equal(f.batches.length, 1); assert.equal(f.knobs.stageLive, true);
});

test('later selection-fenced or definitive dispatch errors cannot erase an earlier unknown commit', async () => {
  for (const refusal of ['CONFLICT', 'STALE_ARCHIVE', 'CANCELLED', 'INVALID_REQUEST']) {
    const f = fixture(); f.knobs.commitError = error('UNKNOWN_OUTCOME'); f.knobs.commitAfterEffect = true;
    const pending = await pendingImport(f), original = JSON.stringify(pending.batch);
    // Both status reads now find committed receipts, but the selection can
    // change before the subsequent exact-batch replay reaches its owner.
    f.knobs.commitError = error(refusal); f.knobs.commitAfterEffect = false;
    await assert.rejects(reconcileDocumentImport(f.storage, pending), e => e === pending);
    assert.equal(f.knobs.stageLive, true);
    assert.equal(f.calls.some(call => call.kind === 'discardBlobTransfer'), false);
    assert.equal(JSON.stringify(pending.batch), original);
    f.knobs.commitError = undefined;
    assert.equal(await reconcileDocumentImport(f.storage, pending), pending.document);
    assert.equal(f.knobs.stageLive, false);
  }
});

test('recovery cannot retarget another client and concurrent callers join one exact attempt', async () => {
  const f = fixture(); f.knobs.commitError = error('UNKNOWN_OUTCOME'); const pending = await pendingImport(f);
  await assert.rejects(reconcileDocumentImport(fixture().storage, pending), code('CONFLICT'));
  const gate = deferred(), entered = deferred(); f.knobs.commitError = undefined;
  f.knobs.beforeCommit = async () => { entered.resolve(); await gate.promise; };
  const first = reconcileDocumentImport(f.storage, pending); const second = reconcileDocumentImport(f.storage, pending);
  assert.equal(first, second); await entered.promise; gate.resolve(); await first;
  assert.equal(f.batches.length, 2);
});

test('definitive commit rejection releases stage; malformed success remains pending', async () => {
  const f = fixture(); f.knobs.commitError = error('CONFLICT');
  await assert.rejects(importPdf(f), code('CONFLICT')); assert.equal(f.knobs.stageLive, false);
  const malformed = fixture(); malformed.knobs.badCommit = true;
  const pending = await pendingImport(malformed); assert.equal(pending.committed, false); assert.equal(malformed.knobs.stageLive, true);
});

test('post-dispatch cancellation observes known success rather than reporting an uncommitted cancellation', async () => {
  const f = fixture(), controller = new AbortController(), gate = deferred(), entered = deferred();
  f.knobs.beforeCommit = async () => { entered.resolve(); await gate.promise; };
  const result = importPdf({ ...f, signal: controller.signal }); await entered.promise; controller.abort(); gate.resolve();
  const document = await result; assert.ok(document.id); assert.equal(f.knobs.stageLive, false);
});

test('confirmed commit with unconfirmed stage release remains recoverable without a second canonical dispatch', async () => {
  const f = fixture(); f.knobs.releaseError = error('UNKNOWN_OUTCOME');
  const pending = await pendingImport(f); assert.equal(pending.committed, true);
  f.knobs.releaseError = undefined;
  assert.equal(await reconcileDocumentImport(f.storage, pending), pending.document);
  assert.equal(f.batches.length, 1); assert.equal(f.knobs.stageLive, false);
});
