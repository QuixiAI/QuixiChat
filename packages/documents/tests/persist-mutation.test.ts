/** Controlled protocol tests: these prove retry/error identity, not OPFS durability. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '@quixi/core/contracts';
import type { StorageClient, StorageOperations } from '@quixi/core/contracts';
import type { JsonValue } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PendingExtractionOperationError, writeExtractionMutation } from '../src/persist-mutation.ts';

const failure = (code: string) => Object.assign(new Error(code), { code });
const digest = (value: unknown) => bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value as JsonValue))));
const input = () => ({ runId: crypto.randomUUID(), writerEpoch: 1, pageAttemptId: crypto.randomUUID(), sequence: 0, expectedUTF16Offset: 0, text: '日本語\u0000😀', spans: [] });
type Call = { requestId: string; operation: keyof StorageOperations; args: unknown };
type Step = (call: Call) => unknown | Promise<unknown>;
function fixture(steps: Step[]) {
  const calls: Call[] = [], cancellations: { requestId: string; operationId: string | null }[] = [];
  const storage: Pick<StorageClient, 'request' | 'cancel'> = {
    async request<K extends keyof StorageOperations>(requestId: string, operation: K, args: StorageOperations[K]['args']): Promise<StorageOperations[K]['result']> {
      const call = { requestId, operation, args };
      calls.push(call);
      const step = steps.shift(); assert.ok(step, `Unexpected ${operation}`);
      return await step(call) as StorageOperations[K]['result'];
    },
    async cancel(requestId, operationId) { cancellations.push({ requestId, operationId }); return { requestId, operationId, outcome: 'unknown_outcome' }; },
  };
  return { storage, calls, cancellations, steps };
}
const lost: Step = call => { assert.equal(call.operation, 'stagePageText'); throw failure('UNKNOWN_OUTCOME'); };
const absent: Step = call => { assert.equal(call.operation, 'getExtractionOperation'); return { status: 'not_found' }; };
function exactPending(calls: Call[], expectedCause: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PendingExtractionOperationError);
    assert.equal(error.code, 'UNKNOWN_OUTCOME');
    assert.equal(error.pending.operation, 'stagePageText');
    assert.strictEqual(error.pending.args, calls[0]!.args, 'Keep the original dispatched payload');
    assert.equal(error.pending.requestDigest, digest({ operation: 'stagePageText', args: calls[0]!.args }));
    assert.equal((error.cause as { code?: string }).code, expectedCause);
    assert.deepEqual(error.cleanupFailures, []);
    for (const call of calls.filter(call => call.operation === 'stagePageText')) assert.strictEqual(call.args, error.pending.args);
    assert.equal(new Set(calls.map(call => call.requestId)).size, calls.length, 'Transport request IDs stay distinct');
    assert.ok(calls.every(call => call.operation !== 'interruptDocumentExtraction'));
    return true;
  };
}

test('abort after a not-found receipt preserves unresolved dispatch before any retry', async () => {
  const controller = new AbortController();
  const f = fixture([lost, call => { controller.abort(); return absent(call); }]);
  await assert.rejects(writeExtractionMutation(f.storage, 'stagePageText', input(), controller.signal), exactPending(f.calls, 'CANCELLED'));
  assert.equal(f.calls.length, 2);
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.cancellations[0]!.operationId, (f.calls[0]!.args as { operationId: string }).operationId);
});

for (const code of ['CONFLICT', 'CANCELLED', 'CLOSED']) {
  test(`later ${code} refusal cannot erase an earlier unknown dispatch`, async () => {
    const f = fixture([lost, absent, () => { throw failure(code); }]);
    await assert.rejects(writeExtractionMutation(f.storage, 'stagePageText', input()), exactPending(f.calls, code));
    assert.equal(f.calls.length, 3);
  });
}

test('abort during overload backoff preserves the original pending identity', async () => {
  const controller = new AbortController();
  const f = fixture([lost, absent, () => { setTimeout(() => controller.abort(), 0); throw failure('OVERLOADED'); }]);
  await assert.rejects(writeExtractionMutation(f.storage, 'stagePageText', input(), controller.signal), exactPending(f.calls, 'CANCELLED'));
  assert.equal(f.calls.length, 3);
});

test('a matching committed receipt remains authoritative even after cancellation', async () => {
  let original: Call;
  const result = { pageAttemptId: crypto.randomUUID(), sequence: 0, committedUTF16Offset: 8, committedMapCount: 0 };
  const controller = new AbortController();
  const f = fixture([call => { original = call; return lost(call); }, call => {
    assert.equal(call.operation, 'getExtractionOperation'); controller.abort();
    return { status: 'committed', requestDigest: digest({ operation: original.operation, args: original.args }), result };
  }]);
  assert.strictEqual(await writeExtractionMutation(f.storage, 'stagePageText', input(), controller.signal), result);
  assert.equal(f.calls.length, 2);
});

test('same-operation retry may resolve uncertainty through a successful response', async () => {
  const result = { pageAttemptId: crypto.randomUUID(), sequence: 0, committedUTF16Offset: 8, committedMapCount: 0 };
  const f = fixture([lost, absent, () => result]);
  assert.strictEqual(await writeExtractionMutation(f.storage, 'stagePageText', input()), result);
  assert.strictEqual(f.calls[0]!.args, f.calls[2]!.args);
});

test('second not-found receipt exhausts the bounded retry while retaining pending payload', async () => {
  const f = fixture([lost, absent, lost, absent]);
  await assert.rejects(writeExtractionMutation(f.storage, 'stagePageText', input()), exactPending(f.calls, 'UNKNOWN_OUTCOME'));
  assert.equal(f.calls.length, 4);
});

test('lookup refusal and mismatched receipt cannot resolve the original dispatch', async () => {
  const f = fixture([lost, () => { throw failure('CONFLICT'); }]);
  await assert.rejects(writeExtractionMutation(f.storage, 'stagePageText', input()), exactPending(f.calls, 'CONFLICT'));
  const mismatch = fixture([lost, () => ({ status: 'committed', requestDigest: '0'.repeat(64), result: {} })]);
  await assert.rejects(writeExtractionMutation(mismatch.storage, 'stagePageText', input()), (error: unknown) => {
    assert.ok(error instanceof PendingExtractionOperationError);
    assert.strictEqual(error.pending.args, mismatch.calls[0]!.args);
    assert.match(String(error.cause), /receipt identity differs/);
    return true;
  });
});

test('predispatch cancellation and certain refusal keep their ordinary error behavior', async () => {
  const controller = new AbortController(); controller.abort();
  const untouched = fixture([]);
  await assert.rejects(writeExtractionMutation(untouched.storage, 'stagePageText', input(), controller.signal), (error: unknown) => {
    assert.ok(!(error instanceof PendingExtractionOperationError));
    assert.equal((error as { code: string }).code, 'CANCELLED'); return true;
  });
  assert.equal(untouched.calls.length, 0);
  const refusal = failure('CONFLICT'), f = fixture([() => { throw refusal; }]);
  await assert.rejects(writeExtractionMutation(f.storage, 'stagePageText', input()), error => error === refusal);
});

test('control mutations still ignore an already-aborted user signal', async () => {
  const controller = new AbortController(); controller.abort();
  const result = { runId: crypto.randomUUID(), state: 'interrupted' };
  const f = fixture([call => { assert.equal(call.operation, 'interruptDocumentExtraction'); return result; }]);
  assert.strictEqual(await writeExtractionMutation(f.storage, 'interruptDocumentExtraction', { runId: crypto.randomUUID(), writerEpoch: 1, reason: 'user_cancelled' }, controller.signal, true), result);
  assert.equal(f.cancellations.length, 0);
});
