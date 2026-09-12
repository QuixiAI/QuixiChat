import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlobInventoryStatus, StorageClient } from '@quixi/core/contracts';
import { createStorageHealthController, INVENTORY_PAGE } from '../../src/features/diagnostics/controller.ts';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function until(read: () => boolean) { for (let at = 0; at < 200; at++) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Test condition timed out'); }
function fixture() {
  const scans = new Map<string, BlobInventoryStatus>(), calls: { operation: string; args: any }[] = [], cancelledRequests: string[] = [], listeners = new Set<() => void>();
  let hook = async (_operation: string, _args: any) => {}, inFlight = 0, maxInFlight = 0;
  const storage = {
    async request(_id: string, operation: string, args: any) {
      calls.push({ operation, args });
      const ordinary = operation !== 'cancelBlobInventory'; if (ordinary) { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); }
      try {
        await hook(operation, args);
        if (operation === 'beginBlobInventory') {
          const status: BlobInventoryStatus = { scanId: args.scanId, state: 'running', phase: 'references', startedAt: 1, updatedAt: 1, scannedRecords: 0, scannedTransfers: 0, scannedCatalogEntries: 0, scannedFiles: 0, counts: { missing_blob: 0, missing_catalog: 0, orphan_blob: 64, size_mismatch: 0, protected_blob: 0, staged_file: 0, unrecognized_entry: 0 }, message: null };
          scans.set(args.scanId, status); return structuredClone(status);
        }
        const status = scans.get(args.scanId); if (!status) throw { code: 'NOT_FOUND' };
        if (operation === 'advanceBlobInventory') { assert.equal(args.maxItems, 64); status.scannedRecords += 64; if (status.scannedRecords >= 128) { status.state = 'complete'; status.phase = 'finished'; } return structuredClone(status); }
        if (operation === 'blobInventoryStatus') return structuredClone(status);
        if (operation === 'cancelBlobInventory') { status.state = 'cancelled'; return structuredClone(status); }
        if (operation === 'readBlobInventoryFindings') {
          assert.deepEqual({ maxItems: args.page.maxItems, maxBytes: args.page.maxBytes }, INVENTORY_PAGE);
          const offset = args.page.cursor ? 32 : 0;
          return { items: Array.from({ length: 32 }, (_, index) => ({ sequence: offset + index + 1, kind: 'orphan_blob', sha256: 'a'.repeat(64), path: null, expectedBytes: null, actualBytes: 1, references: 0 })), nextCursor: offset ? null : 'next', bytes: 6000 };
        }
        throw new Error(`Unexpected test operation ${operation}`);
      } finally { if (ordinary) inFlight--; }
    },
    cancel: async (requestId: string) => { cancelledRequests.push(requestId); return { status: 'cancelled' }; },
    onChange(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  } as unknown as StorageClient;
  return { storage, calls, scans, cancelledRequests, get maxInFlight() { return maxInFlight; }, setHook(value: typeof hook) { hook = value; }, changed() { for (const listener of listeners) listener(); } };
}

test('inventory starts explicitly, serializes bounded work and replaces one findings page', async () => {
  const f = fixture(), controller = createStorageHealthController(f.storage);
  await controller.refresh(); assert.equal(f.calls.length, 0);
  const run = controller.start(); await controller.start(); await run;
  assert.equal(f.calls.filter(value => value.operation === 'beginBlobInventory').length, 1);
  assert.equal(f.maxInFlight, 1); assert.equal(controller.getSnapshot().findings.length, 32);
  await controller.page(); assert.equal(controller.getSnapshot().findings.length, 32); assert.equal(controller.getSnapshot().findings[0]?.sequence, 33);
  await controller.page(true); assert.equal(controller.getSnapshot().findings[0]?.sequence, 1);
  await controller.dispose();
});

test('a begin reply arriving after Stop is retired and cannot resume advancing', async () => {
  const f = fixture(), gate = deferred(); f.setHook(async operation => { if (operation === 'beginBlobInventory') await gate.promise; });
  const controller = createStorageHealthController(f.storage), run = controller.start();
  await until(() => f.calls.some(value => value.operation === 'beginBlobInventory'));
  const stopping = controller.stop(); await controller.start();
  gate.resolve(); await Promise.all([run, stopping]);
  assert.equal(f.calls.filter(value => value.operation === 'beginBlobInventory').length, 1);
  assert.equal(f.calls.filter(value => value.operation === 'advanceBlobInventory').length, 0);
  assert.equal([...f.scans.values()][0]?.state, 'cancelled'); assert.equal(controller.getSnapshot().status?.state, 'cancelled');
  await controller.start(); assert.equal(controller.getSnapshot().status?.state, 'complete'); await controller.dispose();
});

test('disposing during advance hides late replies and releases the scan after the pending task', async () => {
  const f = fixture(), gate = deferred(); f.setHook(async operation => { if (operation === 'advanceBlobInventory') await gate.promise; });
  const controller = createStorageHealthController(f.storage); let notifications = 0; controller.subscribe(() => notifications++);
  const run = controller.start(); await until(() => f.calls.some(value => value.operation === 'advanceBlobInventory'));
  const disposing = controller.dispose(), before = notifications; gate.resolve(); await Promise.all([run, disposing]);
  assert.equal(notifications, before); assert.equal([...f.scans.values()][0]?.state, 'cancelled'); assert.equal(controller.getSnapshot().findings.length, 0);
});

test('canonical change hides complete results and a pending page cannot restore them', async () => {
  const f = fixture(), controller = createStorageHealthController(f.storage); await controller.start();
  const gate = deferred(); f.setHook(async operation => { if (operation === 'readBlobInventoryFindings') await gate.promise; });
  const next = controller.page(); await until(() => f.calls.filter(value => value.operation === 'readBlobInventoryFindings').length === 2);
  f.changed(); assert.equal(controller.getSnapshot().status?.state, 'stale'); assert.equal(controller.getSnapshot().findings.length, 0);
  gate.resolve(); await next;
  assert.equal(controller.getSnapshot().status?.state, 'stale'); assert.equal(controller.getSnapshot().nextCursor, null); assert.equal(controller.getSnapshot().findings.length, 0);
  await controller.start(); assert.equal(controller.getSnapshot().status?.state, 'complete'); await controller.dispose();
});

test('owner loss discards cached findings and requires a new explicit scan', async () => {
  const f = fixture(), controller = createStorageHealthController(f.storage); await controller.start(); f.scans.clear();
  await controller.refresh(); assert.equal(controller.getSnapshot().status?.state, 'failed'); assert.equal(controller.getSnapshot().findings.length, 0);
  assert.match(controller.getSnapshot().error!, /Start a new scan/);
  await controller.start(); assert.equal(controller.getSnapshot().status?.state, 'complete'); await controller.dispose();
});

test('authoritative stale status after a page read hides findings without a change notification', async () => {
  const f = fixture(), controller = createStorageHealthController(f.storage); await controller.start();
  f.setHook(async (operation, args) => { if (operation === 'readBlobInventoryFindings') f.scans.get(args.scanId)!.state = 'stale'; });
  await controller.page();
  assert.equal(controller.getSnapshot().status?.state, 'stale'); assert.equal(controller.getSnapshot().findings.length, 0); assert.equal(controller.getSnapshot().nextCursor, null);
  await controller.dispose();
});

test('late retirement of a stale scan cannot cancel the next scan pending request', async () => {
  const f = fixture(), controller = createStorageHealthController(f.storage); await controller.start();
  const oldId = controller.getSnapshot().status!.scanId, cancelGate = deferred(), beginGate = deferred();
  f.setHook(async (operation, args) => {
    if (operation === 'cancelBlobInventory' && args.scanId === oldId) await cancelGate.promise;
    if (operation === 'beginBlobInventory' && args.scanId !== oldId) await beginGate.promise;
  });
  f.changed(); await until(() => f.calls.some(value => value.operation === 'cancelBlobInventory' && value.args.scanId === oldId));
  const next = controller.start(); await until(() => f.calls.filter(value => value.operation === 'beginBlobInventory').length === 2);
  cancelGate.resolve(); await until(() => f.calls.filter(value => value.operation === 'cancelBlobInventory' && value.args.scanId === oldId).length === 2);
  assert.deepEqual(f.cancelledRequests, []);
  beginGate.resolve(); await next;
  assert.equal(controller.getSnapshot().status?.state, 'complete'); assert.notEqual(controller.getSnapshot().status?.scanId, oldId);
  await controller.dispose();
});
