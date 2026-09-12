import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlobInventoryFinding, StorageClient } from '@quixi/core/contracts';
import { createCleanupController } from '../../src/features/diagnostics/cleanup-controller.ts';
import type { StorageHealthController } from '../../src/features/diagnostics/controller.ts';

const finding = (index: number, kind: BlobInventoryFinding['kind'] = 'orphan_blob'): BlobInventoryFinding => ({ sequence: index, kind, sha256: index.toString(16).padStart(64, '0'), path: null, expectedBytes: null, actualBytes: 10 * index, references: 0 });
function fixture() {
  const listeners = new Set<() => void>();
  let scan: string | null = 'scan-1', state: 'running' | 'complete' | 'stale' = 'complete', refreshed = 0;
  const health = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => ({ status: scan ? { state } : null, findings: [], nextCursor: null, loading: false, error: null }),
    scanId: () => scan,
    refresh: async () => { refreshed++; },
  } as unknown as StorageHealthController;
  const calls: { operation: string; args: unknown }[] = [];
  const storage = { async request(_id: string, operation: string, args: { scanId: string; sha256s: string[] }) { calls.push({ operation, args }); return { scanId: args.scanId, deleted: args.sha256s.slice(0, 1).map(sha256 => ({ sha256, byteLength: 10, catalogRemoved: false })), refused: args.sha256s.slice(1).map(sha256 => ({ sha256, reason: 'referenced' })), status: { state: 'stale' } }; } } as unknown as StorageClient;
  const notify = () => { for (const listener of listeners) listener(); };
  return { health, storage, calls, notify, setScan: (value: string | null) => { scan = value; }, setState: (value: typeof state) => { state = value; }, refreshed: () => refreshed };
}
test('only orphan findings can be selected, at most thirty-two, and the review shows before anything is sent', async () => {
  const f = fixture(), controller = createCleanupController(f.storage, f.health);
  controller.toggle(finding(1, 'missing_blob'));
  assert.deepEqual(controller.getSnapshot().selected, {});
  for (let index = 1; index <= 40; index++) controller.toggle(finding(index));
  assert.equal(Object.keys(controller.getSnapshot().selected).length, 32);
  await controller.confirm();
  assert.equal(f.calls.length, 0, 'nothing is sent without a review');
  controller.review(); assert.equal(controller.getSnapshot().reviewing, true);
  controller.cancelReview(); assert.equal(controller.getSnapshot().reviewing, false); assert.equal(f.calls.length, 0);
});
test('confirming sends exactly the reviewed digests bound to the scan, records deletions and refusals, and refreshes the scan', async () => {
  const f = fixture(), controller = createCleanupController(f.storage, f.health);
  controller.toggle(finding(1)); controller.toggle(finding(2)); controller.toggle(finding(1));
  controller.toggle(finding(3)); controller.review();
  await controller.confirm();
  assert.deepEqual(f.calls, [{ operation: 'deleteOrphanBlobs', args: { scanId: 'scan-1', sha256s: [finding(2).sha256, finding(3).sha256] } }]);
  const result = controller.getSnapshot().result!;
  assert.equal(result.deleted.length, 1); assert.deepEqual(result.refused.map(item => item.reason), ['referenced']);
  assert.deepEqual(controller.getSnapshot().selected, {}); assert.equal(f.refreshed(), 1);
});
test('a new or stale scan drops the selection; a boundary error is shown plainly; dispose stops everything', async () => {
  const f = fixture(), controller = createCleanupController(f.storage, f.health);
  controller.toggle(finding(1)); f.setScan('scan-2'); f.notify();
  assert.deepEqual(controller.getSnapshot().selected, {});
  controller.toggle(finding(1)); f.setState('stale'); f.notify();
  assert.deepEqual(controller.getSnapshot().selected, {});
  f.setState('complete'); controller.toggle(finding(1)); controller.review();
  const failing = createCleanupController({ async request() { throw Object.assign(new Error('Archive owner is closing'), { code: 'CLOSED' }); } } as unknown as StorageClient, f.health);
  failing.toggle(finding(1)); failing.review(); await failing.confirm();
  assert.equal(failing.getSnapshot().error, 'Archive owner is closing'); assert.equal(failing.getSnapshot().busy, false);
  controller.dispose(); await controller.confirm(); assert.equal(f.calls.length, 0);
});
