import { mountApp } from '@quixi/app';
import type { StorageClient, StorageOperations } from '@quixi/core/contracts';
import { createWebHost } from '../../../../../apps/web/src/host/index.ts';
import { createIsolatedStorageClient } from '../../../../storage/tests/isolated-client.ts';
import { setupBlobInventoryFixture, fingerprintBlobInventoryFixture, cleanupBlobInventoryFixture, injectBlobInventoryFault } from '../../../../storage/tests/blob-inventory/fixture.ts';
import type { BlobInventoryFault } from '../../../../storage/tests/blob-inventory/fixture.ts';

// Headless engines cancel the native save picker; saving then takes the download path, as in the shared-app proof.
Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
const archiveId = new URL(location.href).searchParams.get('archive')!;
// `reuse`: the archive was seeded by an earlier page on this origin (diagnostics faults reopen it).
const fixture = new URL(location.href).searchParams.get('fixture') === 'reuse' ? null : await setupBlobInventoryFixture(archiveId, 96);
let current = createIsolatedStorageClient({ archiveId }), closed = false;
const changes = new Set<(ids: string[]) => void>(), progress = new Set<Parameters<StorageClient['onProgress']>[0]>();
let unchanges = current.onChange(ids => { for (const listener of changes) listener(ids); });
let unprogress = current.onProgress(value => { for (const listener of progress) listener(value); });
const calls: { operation: string; scanId: string; maxItems?: number; maxBytes?: number; responseItems?: number; responseBytes?: number; state?: string }[] = [];
/** Every operation name in order, for proofs that need to see what a panel sent. */
const log: { operation: string; ok: boolean; error?: string }[] = [];
// Observe bounds without replacing worker results. The owner-loss case alone
// closes/reopens this real fixture client while retaining the AppRoot controller.
const storage: StorageClient = {
  async request<K extends keyof StorageOperations>(requestId: string, operation: K, args: StorageOperations[K]['args']): Promise<StorageOperations[K]['result']> {
    let call: (typeof calls)[number] | undefined;
    if (['beginBlobInventory', 'advanceBlobInventory', 'blobInventoryStatus', 'readBlobInventoryFindings', 'cancelBlobInventory'].includes(operation)) {
      if (calls.length >= 2048) throw new Error('Inventory proof exceeded its bounded operation log');
      const value = args as { scanId: string; maxItems?: number; page?: { maxItems: number; maxBytes: number } };
      call = { operation, scanId: value.scanId, ...(value.maxItems === undefined ? {} : { maxItems: value.maxItems }), ...(value.page ? { maxItems: value.page.maxItems, maxBytes: value.page.maxBytes } : {}) }; calls.push(call);
    }
    let result: StorageOperations[K]['result'];
    try { result = await current.request(requestId, operation, args); if (log.length < 4096) log.push({ operation, ok: true }); }
    catch (error) { if (log.length < 4096) log.push({ operation, ok: false, error: String((error as { message?: unknown })?.message ?? error) }); throw error; }
    if (call) {
      const value = result as { items?: unknown[]; bytes?: number; state?: string };
      if (value.items) call.responseItems = value.items.length;
      if (value.bytes !== undefined) call.responseBytes = value.bytes;
      if (value.state !== undefined) call.state = value.state;
    }
    return result;
  },
  sendChunk: chunk => current.sendChunk(chunk), readChunk: transferId => current.readChunk(transferId), acknowledgeChunk: ack => current.acknowledgeChunk(ack),
  cancel: (requestId, operationId) => current.cancel(requestId, operationId),
  onChange(listener) { changes.add(listener); return () => { changes.delete(listener); }; },
  onProgress(listener) { progress.add(listener); return () => { progress.delete(listener); }; },
  close: () => current.close(),
};
const host = createWebHost({ destinations: [], fileStagingNamespace: archiveId });
const unmount = mountApp(document.getElementById('app')!, { archiveId, storage, host });
async function close() { if (closed) return; closed = true; await unmount(); unchanges(); unprogress(); await current.close(); await host.dispose(); }
Object.assign(window, { storageHealthAcceptance: {
  fixture, calls: () => calls, log: () => log,
  async restartOwner() {
    unchanges(); unprogress(); await current.close(); current = createIsolatedStorageClient({ archiveId });
    unchanges = current.onChange(ids => { for (const listener of changes) listener(ids); });
    unprogress = current.onProgress(value => { for (const listener of progress) listener(value); });
    await current.request(crypto.randomUUID(), 'diagnostics', null);
  },
  /** Plan 23: applies one fixture fault with no production owner open, then replaces the owner (as after a restart). */
  async fault(kind: BlobInventoryFault) {
    unchanges(); unprogress(); await current.close();
    const result = await injectBlobInventoryFault(archiveId, kind);
    current = createIsolatedStorageClient({ archiveId });
    unchanges = current.onChange(ids => { for (const listener of changes) listener(ids); });
    unprogress = current.onProgress(value => { for (const listener of progress) listener(value); });
    await current.request(crypto.randomUUID(), 'diagnostics', null);
    return result;
  },
  report: () => current.request(crypto.randomUUID(), 'diagnosticsReport', null),
  /** Direct worker request for proofs that inspect a repair path. */
  request: <K extends keyof StorageOperations>(operation: K, args: StorageOperations[K]['args']) => current.request(crypto.randomUUID(), operation, args),
  /** Plan 23 cleanup refusals: direct worker requests with digests the panel would never offer. */
  deleteOrphans: (scanId: string, sha256s: string[]) => current.request(crypto.randomUUID(), 'deleteOrphanBlobs', { scanId, sha256s }),
  scanId: () => calls.filter(call => call.operation === 'beginBlobInventory').at(-1)?.scanId ?? null,
  searchStatus: () => current.request(crypto.randomUUID(), 'searchStatus', null),
  semanticStatus: () => current.request(crypto.randomUUID(), 'semanticStatus', null),
  counts: async () => { const value = await current.request(crypto.randomUUID(), 'diagnostics', null); return { canonicalRecords: value.canonicalRecords, syncOperations: value.syncOperations }; },
  async fingerprint() { await close(); return fingerprintBlobInventoryFixture(archiveId); },
  async cleanup() { await close(); await cleanupBlobInventoryFixture(archiveId); },
} });
