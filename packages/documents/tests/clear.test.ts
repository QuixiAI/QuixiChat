/** Controlled helper/Web Locks protocol tests; no OPFS or browser durability claim. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '@quixi/core/contracts';
import type { StorageClient, StorageOperations } from '@quixi/core/contracts';
import type { JsonValue } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { clearStoredPdfExtraction } from '../src/clear.ts';
import type { ClearPdfExtractionOptions, ClearPdfExtractionTarget } from '../src/clear.ts';
import { acquireStoredPdfProducerLease } from '../src/storage-source.ts';
import { PendingExtractionOperationError } from '../src/persist-mutation.ts';
const id = () => crypto.randomUUID();
const target = (): ClearPdfExtractionTarget => ({ documentId: id(), expectedRunId: id(), expectedDocumentRevision: 7 });
const error = (code: string) => Object.assign(new Error(code), { code });
const hasCode = (code: string) => (e: unknown) => (e as { code?: string }).code === code;
const digest = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value as JsonValue))));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type Call = { requestId: string; operation: keyof StorageOperations; args: unknown };
function client(handler: (call: Call) => unknown | Promise<unknown>, archiveId = 'default') {
  const calls: Call[] = [], cancellations: { requestId: string; operationId: string | null }[] = [];
  let closed = 0;
  const storage: StorageClient & { readonly archiveId: string } = {
    archiveId,
    async request<K extends keyof StorageOperations>(requestId: string, operation: K, args: StorageOperations[K]['args']): Promise<StorageOperations[K]['result']> {
      const call = { requestId, operation, args }; calls.push(call); return await handler(call) as StorageOperations[K]['result'];
    },
    async cancel(requestId, operationId) { cancellations.push({ requestId, operationId }); return { requestId, operationId, outcome: 'unknown_outcome' }; },
    async close() { closed++; },
    async sendChunk() { throw new Error('Clear must not transfer original bytes'); },
    async readChunk() { throw new Error('Clear must not read original bytes'); },
    async acknowledgeChunk() { throw new Error('Clear must not acknowledge byte reads'); },
    onProgress() { throw new Error('Clear must not change borrowed subscriptions'); },
    onChange() { throw new Error('Clear must not change borrowed subscriptions'); },
  };
  return { storage, calls, cancellations, get closed() { return closed; } };
}
function locks() {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const held = new Set<string>(), calls: { name: string; options: LockOptions }[] = [], requested = deferred();
  let delay: Promise<void> | undefined, releaseFailure: unknown;
  const manager = { async request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<T>): Promise<T> {
    calls.push({ name, options }); requested.resolve();
    assert.equal(options.ifAvailable, true); assert.equal(options.mode, 'exclusive');
    await delay;
    if (held.has(name)) return callback(null);
    held.add(name);
    try { const result = await callback({ name, mode: 'exclusive' } as Lock); if (releaseFailure) throw releaseFailure; return result; }
    finally { held.delete(name); }
  } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: manager } });
  return { held, calls, requested: requested.promise, delay(value: Promise<void>) { delay = value; }, failRelease(value: unknown) { releaseFailure = value; }, restore() { assert.equal(held.size, 0, 'Helper leaked a producer lock'); if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator'); } };
}
const success = (review: ClearPdfExtractionTarget) => ({ documentId: review.documentId, documentRevision: review.expectedDocumentRevision + 1, cleared: true as const });
function pending(e: unknown, call: Call, cause: string) {
  assert.ok(e instanceof PendingExtractionOperationError);
  assert.equal(e.pending.operation, 'clearDocumentExtraction');
  assert.strictEqual(e.pending.args, call.args);
  assert.equal(e.pending.requestDigest, digest({ operation: call.operation, args: call.args }));
  assert.equal((e.cause as { code: string }).code, cause);
  return e;
}

test('reviewed document/run/revision and borrowed client are snapshotted before the lease await', async () => {
  const l = locks(), gate = deferred(); l.delay(gate.promise);
  const review = target(), expected = { ...review }, result = success(expected);
  const first = client(call => { assert.equal(call.operation, 'clearDocumentExtraction'); assert.deepEqual(call.args, { ...expected, operationId: (call.args as { operationId: string }).operationId }); return result; });
  const replacement = client(() => { throw new Error('Retargeted borrowed client'); }, id());
  try {
    const options: ClearPdfExtractionOptions = { storage: first.storage, target: review };
    const clearing = clearStoredPdfExtraction(options); await l.requested;
    Object.assign(review, target()); options.target = target(); options.storage = replacement.storage;
    gate.resolve(); assert.deepEqual(await clearing, result);
    assert.equal(l.calls[0]!.name, `quixi:pdf-producer:v1:${JSON.stringify(['default', expected.documentId])}`);
    assert.equal(first.calls.length, 1); assert.equal(replacement.calls.length, 0);
    assert.equal(first.closed, 0); assert.equal(replacement.closed, 0);
  } finally { gate.resolve(); l.restore(); }
});

test('an active real helper producer lease refuses clear without mutation or releasing the other owner', async () => {
  const l = locks(), review = target(), c = client(() => { throw new Error('Producer collision dispatched a clear'); });
  const producer = await acquireStoredPdfProducerLease('default', review.documentId);
  try {
    await assert.rejects(clearStoredPdfExtraction({ storage: c.storage, target: review }), hasCode('CAPACITY'));
    assert.equal(c.calls.length, 0); assert.equal(c.closed, 0); assert.equal(l.held.size, 1);
  } finally { await producer.release(); l.restore(); }
});

test('unknown clear keeps its exact identity when receipt recovery and lease release fail', async () => {
  const l = locks(), releaseError = new Error('Controlled release failure'); l.failRelease(releaseError);
  const c = client(call => { if (call.operation === 'clearDocumentExtraction') throw error('UNKNOWN_OUTCOME'); assert.equal(call.operation, 'getExtractionOperation'); throw error('CONFLICT'); });
  try {
    await assert.rejects(clearStoredPdfExtraction({ storage: c.storage, target: target() }), e => {
      const p = pending(e, c.calls[0]!, 'CONFLICT'); assert.deepEqual(p.cleanupFailures, [releaseError]); return true;
    });
    assert.equal(c.calls.length, 2); assert.equal(c.closed, 0);
    assert.ok(c.calls.every(call => call.operation !== 'interruptDocumentExtraction'));
  } finally { l.restore(); }
});

test('a matching committed clear receipt remains authoritative despite cancellation during recovery', async () => {
  const l = locks(), controller = new AbortController(), review = target(), result = success(review);
  let first!: Call;
  const c = client(call => {
    if (call.operation === 'clearDocumentExtraction') { first = call; throw error('UNKNOWN_OUTCOME'); }
    assert.equal(call.operation, 'getExtractionOperation'); controller.abort();
    return { status: 'committed', requestDigest: digest({ operation: first.operation, args: first.args }), result };
  });
  try {
    assert.deepEqual(await clearStoredPdfExtraction({ storage: c.storage, target: review, signal: controller.signal }), result);
    assert.equal(c.calls.length, 2); assert.equal(c.closed, 0);
    assert.deepEqual(c.cancellations, [{ requestId: first.requestId, operationId: (first.args as { operationId: string }).operationId }]);
  } finally { l.restore(); }
});

test('not-found recovery followed by cancellation preserves pending clear and performs no replacement mutation', async () => {
  const l = locks(), controller = new AbortController();
  const c = client(call => { if (call.operation === 'clearDocumentExtraction') throw error('UNKNOWN_OUTCOME'); assert.equal(call.operation, 'getExtractionOperation'); controller.abort(); return { status: 'not_found' }; });
  try {
    await assert.rejects(clearStoredPdfExtraction({ storage: c.storage, target: target(), signal: controller.signal }), e => { pending(e, c.calls[0]!, 'CANCELLED'); return true; });
    assert.equal(c.calls.length, 2); assert.equal(c.closed, 0);
  } finally { l.restore(); }
});

test('predispatch cancellation and cancellation while lease callback is pending do not clear', async () => {
  for (const when of ['before', 'pending'] as const) {
    const l = locks(), gate = deferred(), controller = new AbortController(), c = client(() => { throw new Error('Cancelled clear was dispatched'); });
    try {
      if (when === 'before') controller.abort(); else l.delay(gate.promise);
      const clearing = clearStoredPdfExtraction({ storage: c.storage, target: target(), signal: controller.signal });
      const rejected = assert.rejects(clearing, hasCode('CANCELLED'));
      if (when === 'pending') { await l.requested; controller.abort(); gate.resolve(); }
      await rejected; assert.equal(c.calls.length, 0); assert.equal(c.closed, 0);
      if (when === 'before') assert.equal(l.calls.length, 0);
    } finally { gate.resolve(); l.restore(); }
  }
});

test('invalid reviewed target refuses before lease acquisition or storage use', async () => {
  const l = locks(), c = client(() => { throw new Error('Invalid target dispatched'); });
  try {
    await assert.rejects(clearStoredPdfExtraction({ storage: c.storage, target: { ...target(), expectedDocumentRevision: -1 } }), hasCode('INVALID_REQUEST'));
    assert.equal(l.calls.length, 0); assert.equal(c.calls.length, 0); assert.equal(c.closed, 0);
  } finally { l.restore(); }
});

test('successful clear with unconfirmed lease release reports cleanup failure and never closes the borrowed client', async () => {
  const l = locks(), releaseError = new Error('Unconfirmed lock completion'), review = target(); l.failRelease(releaseError);
  const c = client(() => success(review));
  try {
    await assert.rejects(clearStoredPdfExtraction({ storage: c.storage, target: review }), e => { assert.ok(e instanceof AggregateError); assert.deepEqual(e.errors, [releaseError]); return true; });
    assert.equal(c.calls.length, 1); assert.equal(c.closed, 0);
  } finally { l.restore(); }
});
