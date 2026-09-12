/** Controlled public-client protocol evidence. This file does not prove OPFS
 * pinning or browser Web Lock context-death behavior; those use integration tests.
 * Run: node --experimental-transform-types --test packages/documents/tests/storage-source.test.ts */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ByteChunk, ChunkAcknowledgement, StorageClient, StorageOperations } from '@quixi/core/contracts';
import type { Attachment, Document } from '@quixi/core/model';
import { openStoredPdfSource, acquireStoredPdfProducerLease } from '../src/storage-source.ts';

const id = () => randomUUID();
const sha = 'a'.repeat(64);
const live = () => new AbortController().signal;
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Hook = (operation: 'readBlobTransfer' | 'sliceBlobTransfer', transferId: string) => Promise<void>;
function fixture() {
  const document: Document = { id: id(), workspaceId: id(), attachmentId: id(), title: '日本語\u0000 PDF', createdAt: null, recordedAt: 1, importSourceId: null };
  const attachment: Attachment = { id: document.attachmentId, availability: 'available', filename: 'fixture.pdf', mimeType: 'application/pdf', sizeBytes: 131072, blobSha256: sha, rawObjectId: null };
  const calls: { operation: string; id: string; args?: unknown }[] = [];
  const pins = new Map<string, { base: boolean; offset: number; length: number; read: number; sequence: number }>();
  const discarded: string[] = [];
  const knobs: {
    allocate?: Hook;
    descriptor?: (operation: string, value: unknown) => unknown;
    chunk?: (value: ByteChunk) => ByteChunk;
    beforeChunk?: () => Promise<void>;
    acknowledgeError?: unknown;
    discardError?: unknown;
    chunkBytes: number;
    closed: number;
  } = { chunkBytes: 65536, closed: 0 };
  const storage: StorageClient = {
    async request<K extends keyof StorageOperations>(requestId: string, operation: K, args: StorageOperations[K]['args']): Promise<StorageOperations[K]['result']> {
      calls.push({ operation, id: requestId, args });
      let result: unknown;
      if (operation === 'readEntity') {
        const read = args as StorageOperations['readEntity']['args'];
        result = read.collection === 'documents' ? document : attachment;
      } else if (operation === 'readBlobTransfer') {
        pins.set(requestId, { base: true, offset: 0, length: attachment.sizeBytes!, read: 0, sequence: 0 });
        await knobs.allocate?.('readBlobTransfer', requestId);
        result = { transferId: requestId, sha256: sha, byteLength: 131072 };
      } else if (operation === 'sliceBlobTransfer') {
        const slice = args as StorageOperations['sliceBlobTransfer']['args'];
        assert.ok(pins.get(slice.transferId)?.base, 'slice must use the pinned original');
        pins.set(requestId, { base: false, offset: slice.offset, length: slice.byteLength, read: 0, sequence: 0 });
        await knobs.allocate?.('sliceBlobTransfer', requestId);
        result = { transferId: requestId, sha256: sha, byteLength: 131072, range: { offset: slice.offset, byteLength: slice.byteLength } };
      } else if (operation === 'discardBlobTransfer') {
        const transferId = (args as StorageOperations['discardBlobTransfer']['args']).transferId;
        discarded.push(transferId);
        if (knobs.discardError) throw knobs.discardError;
        result = { discarded: pins.delete(transferId) };
      } else throw new Error('Unexpected source operation: ' + operation);
      return (knobs.descriptor?.(operation, result) ?? result) as StorageOperations[K]['result'];
    },
    async readChunk(transferId) {
      calls.push({ operation: 'readChunk', id: transferId });
      await knobs.beforeChunk?.();
      const pin = pins.get(transferId); assert.ok(pin && !pin.base);
      const bytes = Uint8Array.from({ length: Math.min(pin.length - pin.read, knobs.chunkBytes) }, (_, i) => (pin.offset + pin.read + i) % 251);
      const chunk = { transferId, offset: pin.read, sequence: pin.sequence, bytes, final: pin.read + bytes.length === pin.length };
      pin.read += bytes.length; pin.sequence++;
      return knobs.chunk?.(chunk) ?? chunk;
    },
    async acknowledgeChunk(ack: ChunkAcknowledgement) {
      calls.push({ operation: 'acknowledgeChunk', id: ack.transferId, args: ack });
      if (knobs.acknowledgeError) throw knobs.acknowledgeError;
      const pin = pins.get(ack.transferId); assert.ok(pin);
      assert.equal(ack.sequence, pin.sequence - 1); assert.equal(ack.committedOffset, pin.read);
      if (pin.read === pin.length) pins.delete(ack.transferId);
    },
    async sendChunk() { throw new Error('Read-only source attempted an upload'); },
    async cancel() { throw new Error('Source must drain creation replies before discard'); },
    onProgress() { return () => {}; }, onChange() { return () => {}; },
    async close() { knobs.closed++; throw new Error('Source must not close its shared StorageClient'); },
  };
  return { document, attachment, calls, pins, discarded, knobs, storage };
}
const expected = (offset: number, length: number) => Uint8Array.from({ length }, (_, i) => (offset + i) % 251);

test('frozen canonical PDF descriptor pins one original and reads bounded sequential child chunks', async () => {
  const f = fixture(); f.knobs.chunkBytes = 3; f.attachment.mimeType = ' Application/PDF ; charset=binary';
  const source = await openStoredPdfSource(f.storage, f.document.id);
  assert.ok(Object.isFrozen(source));
  assert.equal(source.attachmentId, f.attachment.id); assert.equal(source.sha256, sha);
  f.document.attachmentId = id(); f.attachment.blobSha256 = 'b'.repeat(64); f.attachment.sizeBytes = 1;
  assert.deepEqual(await source.readRange(27, 11, live()), expected(27, 11));
  assert.equal(source.byteLength, 131072); assert.equal(source.sha256, sha);
  assert.equal(f.calls.filter(call => call.operation === 'readBlobTransfer').length, 1);
  assert.equal(f.calls.filter(call => call.operation === 'readEntity').length, 2);
  assert.equal(f.pins.size, 1);
  const first = source.close(); assert.equal(source.close(), first); await first;
  assert.equal(f.pins.size, 0); assert.equal(f.knobs.closed, 0);
  await assert.rejects(source.readRange(0, 1, live()), code('CANCELLED'));
});

test('source bounds reject invalid records and ranges before transfer admission', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.document.id = id(); },
    (f: ReturnType<typeof fixture>) => { f.attachment.id = id(); },
    (f: ReturnType<typeof fixture>) => { f.attachment.mimeType = 'text/plain'; },
    (f: ReturnType<typeof fixture>) => { f.attachment.availability = 'missing'; },
    (f: ReturnType<typeof fixture>) => { f.attachment.blobSha256 = 'z'.repeat(64); },
    (f: ReturnType<typeof fixture>) => { f.attachment.sizeBytes = 0; },
    (f: ReturnType<typeof fixture>) => { f.attachment.sizeBytes = 32 * 1024 * 1024 + 1; },
  ]) {
    const f = fixture(), documentId = f.document.id; change(f);
    await assert.rejects(openStoredPdfSource(f.storage, documentId), code('SOURCE_FAILED'));
    assert.equal(f.calls.some(call => call.operation === 'readBlobTransfer'), false);
  }
  const f = fixture(), source = await openStoredPdfSource(f.storage, f.document.id);
  for (const [offset, length] of [[-1, 1], [0, 0], [0, 65537], [131072, 1], [0.5, 1], [0, NaN], [Number.MAX_SAFE_INTEGER, 2]])
    await assert.rejects(source.readRange(offset!, length!, live()), code('SOURCE_FAILED'));
  assert.equal(f.calls.some(call => call.operation === 'sliceBlobTransfer'), false);
  assert.deepEqual(await source.readRange(65536, 65536, live()), expected(65536, 65536));
  await source.close();
});

test('four active ranges are admitted; a fifth is rejected without an unbounded queue', async () => {
  const f = fixture(), gate = deferred(), entered = deferred(); let count = 0;
  const source = await openStoredPdfSource(f.storage, f.document.id);
  f.knobs.allocate = async operation => { if (operation === 'sliceBlobTransfer') { if (++count === 4) entered.resolve(); await gate.promise; } };
  const reads = Array.from({ length: 4 }, (_, offset) => source.readRange(offset, 1, live()));
  await entered.promise;
  await assert.rejects(source.readRange(4, 1, live()), code('CAPACITY'));
  assert.equal(count, 4); gate.resolve();
  await Promise.all(reads); assert.equal(f.pins.size, 1); await source.close();
});

test('range cancellation drains a pending creation and releases its known child without cancelling another read', async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), controller = new AbortController();
  const source = await openStoredPdfSource(f.storage, f.document.id);
  f.knobs.allocate = async operation => { if (operation === 'sliceBlobTransfer') { entered.resolve(); await gate.promise; } };
  const read = source.readRange(0, 8, controller.signal); const rejected = assert.rejects(read, code('CANCELLED'));
  await entered.promise; controller.abort();
  assert.equal(f.discarded.length, 0); gate.resolve(); await rejected;
  assert.equal(f.pins.size, 1);
  delete f.knobs.allocate;
  assert.deepEqual(await source.readRange(7, 2, live()), expected(7, 2));
  await source.close(); assert.equal(f.pins.size, 0);
});

test('close waits in-flight chunk cleanup and releases the base after its child', async () => {
  const f = fixture(), gate = deferred(), entered = deferred();
  const source = await openStoredPdfSource(f.storage, f.document.id);
  f.knobs.beforeChunk = async () => { entered.resolve(); await gate.promise; };
  const read = source.readRange(0, 8, live()); const rejected = assert.rejects(read, code('CANCELLED'));
  await entered.promise;
  let closed = false; const closing = source.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.equal(f.discarded.length, 0);
  await assert.rejects(source.readRange(8, 8, live()), code('CANCELLED'));
  gate.resolve(); await rejected; await closing;
  const base = f.calls.find(call => call.operation === 'readBlobTransfer')!.id;
  const child = f.calls.find(call => call.operation === 'sliceBlobTransfer')!.id;
  assert.deepEqual(f.discarded, [child, base]); assert.equal(f.pins.size, 0);
});

test('opening cancellation releases the reserved base ID after its pending creation settles', async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), controller = new AbortController();
  f.knobs.allocate = async () => { entered.resolve(); await gate.promise; };
  const opening = openStoredPdfSource(f.storage, f.document.id, controller.signal);
  const rejected = assert.rejects(opening, code('CANCELLED'));
  await entered.promise; controller.abort(); assert.equal(f.discarded.length, 0);
  gate.resolve(); await rejected; assert.equal(f.pins.size, 0);
  assert.deepEqual(f.discarded, [f.calls.find(call => call.operation === 'readBlobTransfer')!.id]);
});

test('source lifetime cancellation closes idle pins and prohibits further range admission', async () => {
  const f = fixture(), controller = new AbortController();
  const source = await openStoredPdfSource(f.storage, f.document.id, controller.signal);
  controller.abort(); await source.close(); assert.equal(f.pins.size, 0);
  await assert.rejects(source.readRange(0, 1, live()), code('CANCELLED'));
  const before = f.calls.length;
  await assert.rejects(openStoredPdfSource(f.storage, f.document.id, controller.signal), code('CANCELLED'));
  assert.equal(f.calls.length, before);
});

test('malformed base descriptors release only the known requested ID', async () => {
  for (const damage of [{ transferId: id() }, { sha256: 'b'.repeat(64) }, { byteLength: 2 }]) {
    const f = fixture();
    f.knobs.descriptor = (operation, result) => operation === 'readBlobTransfer' ? { ...result as object, ...damage } : result;
    await assert.rejects(openStoredPdfSource(f.storage, f.document.id), code('SOURCE_FAILED'));
    assert.deepEqual(f.discarded, [f.calls.find(call => call.operation === 'readBlobTransfer')!.id]);
    assert.equal(f.pins.size, 0);
  }
});

test('malformed child digest, size, ID and range fail the source and release all known pins', async () => {
  for (const damage of [{ transferId: id() }, { sha256: 'b'.repeat(64) }, { byteLength: 2 }, { range: { offset: 1, byteLength: 8 } }, { range: { offset: 0, byteLength: 9 } }]) {
    const f = fixture(), source = await openStoredPdfSource(f.storage, f.document.id);
    f.knobs.descriptor = (operation, result) => operation === 'sliceBlobTransfer' ? { ...result as object, ...damage } : result;
    await assert.rejects(source.readRange(0, 8, live()), code('SOURCE_FAILED')); await source.close();
    assert.equal(f.pins.size, 0); assert.equal(f.calls.some(call => call.operation === 'readChunk'), false);
    await assert.rejects(source.readRange(0, 8, live()), code('SOURCE_FAILED'));
  }
});

test('malformed chunk ID, sequence, offset, final and payload never receive acknowledgement', async () => {
  for (const damage of [{ transferId: id() }, { sequence: 1 }, { offset: 1 }, { final: false }, { bytes: new Uint8Array(0) }, { bytes: new Uint8Array(9) }, { bytes: [] as unknown as Uint8Array }]) {
    const f = fixture(), source = await openStoredPdfSource(f.storage, f.document.id);
    f.knobs.chunk = chunk => ({ ...chunk, ...damage });
    await assert.rejects(source.readRange(0, 8, live()), code('SOURCE_FAILED')); await source.close();
    assert.equal(f.calls.some(call => call.operation === 'acknowledgeChunk'), false); assert.equal(f.pins.size, 0);
  }
});

for (const operation of ['readBlobTransfer', 'sliceBlobTransfer'] as const) test(`lost ${operation} creation reply still releases its request-reserved ID without retry or shared-client close`, async () => {
  const f = fixture(), lost = Object.assign(new Error('Owner reply was lost'), { code: 'UNKNOWN_OUTCOME' });
  f.knobs.allocate = async kind => { if (kind === operation) throw lost; };
  if (operation === 'readBlobTransfer') await assert.rejects(openStoredPdfSource(f.storage, f.document.id), error => error === lost);
  else {
    const source = await openStoredPdfSource(f.storage, f.document.id);
    await assert.rejects(source.readRange(0, 8, live()), error => error === lost); await source.close();
    await assert.rejects(source.readRange(0, 8, live()), code('SOURCE_FAILED'));
  }
  assert.equal(f.calls.filter(call => call.operation === operation).length, 1);
  assert.ok(f.discarded.includes(f.calls.find(call => call.operation === operation)!.id));
  assert.equal(f.pins.size, 0); assert.equal(f.knobs.closed, 0);
});

test('unknown acknowledgment outcome releases child/base and never retries the original', async () => {
  const f = fixture(), source = await openStoredPdfSource(f.storage, f.document.id);
  f.knobs.acknowledgeError = Object.assign(new Error('ACK outcome lost'), { code: 'UNKNOWN_OUTCOME' });
  await assert.rejects(source.readRange(0, 8, live()), code('UNKNOWN_OUTCOME')); await source.close();
  assert.equal(f.pins.size, 0); assert.equal(f.calls.filter(call => call.operation === 'readBlobTransfer').length, 1);
});

test('unconfirmed pin release is surfaced and repeated close does not silently retry', async () => {
  const f = fixture(), source = await openStoredPdfSource(f.storage, f.document.id);
  f.knobs.discardError = Object.assign(new Error('Owner gone'), { code: 'UNKNOWN_OUTCOME' });
  const closing = source.close(); await assert.rejects(closing, /release is unconfirmed/);
  assert.equal(source.close(), closing); await assert.rejects(source.close(), /release is unconfirmed/);
  assert.equal(f.discarded.length, 1); assert.equal(f.knobs.closed, 0);
});

test('controlled Web Locks serialize producers and retain an aborted granted lease until explicit release', async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const held = new Set<string>(); const requests: { name: string; options: LockOptions }[] = [];
  const locks = {
    async request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<T>): Promise<T> {
      requests.push({ name, options });
      if (held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name, mode: 'exclusive' } as Lock); }
      finally { held.delete(name); }
    },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  try {
    const documentId = id(), controller = new AbortController();
    const first = await acquireStoredPdfProducerLease('default', documentId, controller.signal);
    await assert.rejects(acquireStoredPdfProducerLease('default', documentId), code('CAPACITY'));
    const other = await acquireStoredPdfProducerLease(id(), documentId);
    assert.equal(held.size, 2); await other.release(); controller.abort();
    await assert.rejects(acquireStoredPdfProducerLease('default', documentId), code('CAPACITY'));
    assert.equal(held.size, 1); await first.release(); assert.equal(held.size, 0);
    const replacement = await acquireStoredPdfProducerLease('default', documentId); await replacement.release(); await replacement.release();
    assert.ok(requests.every(request => request.options.ifAvailable === true && request.options.mode === 'exclusive'));
    await assert.rejects(acquireStoredPdfProducerLease('default', documentId, controller.signal), code('CANCELLED'));
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
