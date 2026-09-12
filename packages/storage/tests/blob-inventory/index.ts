import { createIsolatedStorageClient } from '../isolated-client.ts';
import { setupBlobInventoryFixture, fingerprintBlobInventoryFixture, cleanupBlobInventoryFixture, corruptBlobInventoryReference } from './fixture.ts';
import type { StorageOperations } from '@quixi/core/contracts';
import type { ThreadState } from '@quixi/core/model';
let storage: ReturnType<typeof createIsolatedStorageClient> | undefined, archiveId = '';
const id = () => crypto.randomUUID();
let ticks = 0;
setInterval(() => ticks++, 1);
Object.assign(window, { blobInventoryProof: {
  setup: setupBlobInventoryFixture,
  async open(value: string) { if (storage) throw new Error('Close the current owner first'); archiveId = value; storage = createIsolatedStorageClient({ archiveId }); return storage.request(id(), 'archiveWorkspace', null); },
  async close() { const previous = storage; storage = undefined; await previous?.close(); },
  async fingerprint(value: string) { if (storage) throw new Error('Close the owner before fingerprinting'); return fingerprintBlobInventoryFixture(value); },
  cleanup: cleanupBlobInventoryFixture,
  corruptReference: corruptBlobInventoryReference,
  request(operation: keyof StorageOperations, args: StorageOperations[keyof StorageOperations]['args']) { if (!storage) throw new Error('No storage owner'); return storage.request(id(), operation, args); },
  async mutateTitle(threadId: string) {
    if (!storage) throw new Error('No storage owner');
    const page = await storage.request(id(), 'readEntities', { collection: 'threadStates', threadId, page: { maxItems: 2, maxBytes: 10000, cursor: null } });
    const state = page.items[0] as unknown as ThreadState;
    return storage.request(id(), 'commit', { transactionId: id(), expectedThreadRevisions: [{ threadId, revision: state.revision }], stagedBlobIds: [], mutations: [{ version: 1, operationId: id(), kind: 'SetTitle', recordedAt: Date.now(), payload: { threadId, value: 'Synthetic intentional mutation between inventory slices' } }] });
  },
  async activeTransfer() {
    if (!storage) throw new Error('No storage owner');
    const transfer = await storage.request(id(), 'beginBlobTransfer', { operationId: id(), purpose: 'attachment', expectedBytes: 4, expectedSha256: null });
    await storage.sendChunk({ transferId: transfer.transferId, sequence: 0, offset: 0, bytes: new Uint8Array([1, 2]), final: false });
    return transfer;
  },
  async appendActiveTransfer(transferId: string) {
    if (!storage) throw new Error('No storage owner');
    return storage.sendChunk({ transferId, sequence: 1, offset: 2, bytes: new Uint8Array([3]), final: false });
  },
  ticks: () => ticks,
  archive: () => archiveId,
} });
