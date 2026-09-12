import test from 'node:test';
import assert from 'node:assert/strict';
import type { DiagnosticsReport, SearchIndexStatus, StorageClient } from '@quixi/core/contracts';
import { createDiagnosticsController } from '../../src/features/diagnostics/report-controller.ts';

const report = (): DiagnosticsReport => ({ version: 1, producedAt: 1, backend: 'sqlite-wasm-opfs-sahpool', sqliteVersion: '3.53.4', schemaVersion: 12, ownerId: 'o', bounds: { referenceRecords: 4096, referenceFiles: 64 }, contentPolicy: 'operational-metadata-only',
  checks: [{ id: 'sqlite_integrity', outcome: 'ok', summary: 'fine', measured: { errors: 0 } }] });
const status = (rebuildingEpoch: number | null): SearchIndexStatus => ({ state: 'rebuilding', version: 'v', indexedChunks: 1234, pendingSources: 1, failedSources: 0, activeEpoch: 3, rebuildingEpoch, revision: 9, semantic: { state: 'ready', reason: null }, activeSource: null, lastFailure: null });
function fixture() {
  const calls: string[] = [];
  let fail = false;
  const storage = {
    async request(_id: string, operation: string, args: unknown) {
      calls.push(operation);
      if (fail) throw Object.assign(new Error('Archive owner is closing'), { code: 'CLOSED' });
      if (operation === 'diagnosticsReport') { assert.equal(args, null); return report(); }
      if (operation === 'rebuildSearch') { assert.match(String((args as { operationId: string }).operationId), /^[0-9a-f-]{36}$/); return status(4); }
      throw new Error(`Unexpected ${operation}`);
    },
  } as unknown as StorageClient;
  return { storage, calls, setFail: (value: boolean) => { fail = value; } };
}
test('run requests one report and publishes it; a second run while running is ignored', async () => {
  const { storage, calls } = fixture(), controller = createDiagnosticsController(storage);
  let notified = 0; controller.subscribe(() => notified++);
  const first = controller.run(); const second = controller.run();
  assert.equal(controller.getSnapshot().running, true);
  await first; await second;
  assert.deepEqual(calls, ['diagnosticsReport']);
  assert.equal(controller.getSnapshot().report?.checks[0]?.outcome, 'ok');
  assert.equal(controller.getSnapshot().running, false);
  assert.ok(notified >= 2);
});
test('rebuildSearchIndex sends rebuildSearch with a fresh operation id, describes the epoch switch and refreshes the report', async () => {
  const { storage, calls } = fixture(), controller = createDiagnosticsController(storage);
  await controller.rebuildSearchIndex();
  assert.deepEqual(calls, ['rebuildSearch', 'diagnosticsReport']);
  assert.match(controller.getSnapshot().notice ?? '', /epoch 4; the current index \(1,234 chunks\) stays searchable/);
  assert.ok(controller.getSnapshot().report);
});
test('a boundary error becomes a plain error message and leaves the last report in place', async () => {
  const { storage, setFail } = fixture(), controller = createDiagnosticsController(storage);
  await controller.run();
  setFail(true);
  await controller.run();
  assert.equal(controller.getSnapshot().error, 'Archive owner is closing');
  assert.ok(controller.getSnapshot().report, 'the previous report stays visible');
  assert.equal(controller.getSnapshot().running, false);
});
test('invalidate clears the report and a late result from before it is dropped; dispose stops publication', async () => {
  const { storage, calls } = fixture();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const gated = { ...storage, request: async (id: string, operation: 'diagnosticsReport', args: null) => { await gate; return storage.request(id, operation, args); } } as unknown as StorageClient;
  const controller = createDiagnosticsController(gated);
  const pending = controller.run();
  controller.invalidate();
  release(); await pending;
  assert.equal(controller.getSnapshot().report, null);
  assert.equal(controller.getSnapshot().running, false);
  controller.dispose();
  await controller.run();
  assert.equal(calls.length, 1);
});
