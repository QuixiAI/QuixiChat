import { openActiveStorageClient } from '@quixi/storage/client';
import type { ArchiveStorageClient } from '@quixi/storage/client';
import type { Document } from '@quixi/core/model';
import { openStoredPdfSource } from '@quixi/documents/storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Hold one already-committed page-index reply to exercise real early search and
// Stop while the producer awaits its ordinary downstream credit. No SQL/result
// is fabricated. The test must explicitly release the held reply.
let arm = false, heldId: string | null = null;
let held: { worker: Worker; data: unknown } | null = null;
const NativeWorker = Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener('message', event => {
      if (heldId && event.data?.type === 'reply' && event.data.id === heldId) {
        heldId = null;
        held = { worker: this, data: event.data };
        event.stopImmediatePropagation();
      }
    });
  }
  override postMessage(message: unknown, transfer: Transferable[] | StructuredSerializeOptions = []) {
    const data = message as { call?: { id: string; request?: { operation: string; args?: { pageRef?: { page: number } } } } };
    if (arm && data?.call?.request?.operation === 'advanceExtractionPageIndex' && data.call.request.args?.pageRef?.page === 1) {
      arm = false; heldId = data.call.id;
    }
    if (Array.isArray(transfer)) super.postMessage(message, transfer);
    else super.postMessage(message, transfer);
  }
};
const id = () => crypto.randomUUID();
async function use<T>(action: (client: ArchiveStorageClient) => Promise<T>) {
  const client = await openActiveStorageClient();
  try { return await action(client); } finally { await client.close(); }
}
const api = {
  arm: () => { arm = true; },
  held: () => held !== null,
  release: () => { const value = held; held = null; value?.worker.dispatchEvent(new MessageEvent('message', { data: value.data })); },
  snapshot: () => use(async client => {
    const documents = await client.request(id(), 'readEntities', { threadId: null, collection: 'documents', page: { maxItems: 24, maxBytes: 200000, cursor: null } });
    const runs = await Promise.all((documents.items as unknown as Document[]).map(document => client.request(id(), 'getDocumentExtraction', { documentId: document.id })));
    return { documents: documents.items, runs, diagnostics: await client.request(id(), 'diagnostics', null) };
  }),
  verifyOriginal: (documentId: string) => use(async client => {
    const source = await openStoredPdfSource(client, documentId), hash = sha256.create();
    try {
      for (let offset = 0; offset < source.byteLength; offset += 65536) hash.update(await source.readRange(offset, Math.min(65536, source.byteLength - offset), new AbortController().signal));
      return bytesToHex(hash.digest());
    } finally { await source.close(); }
  }),
  clear: (documentId: string) => use(async client => {
    const run = await client.request(id(), 'getDocumentExtraction', { documentId });
    if (!run) throw new Error('Expected extraction');
    return client.request(id(), 'clearDocumentExtraction', { operationId: id(), documentId, expectedRunId: run.runId, expectedDocumentRevision: run.documentRevision });
  }),
};
Object.assign(window, { documentAcceptance: api });
await import('../../../../../../../apps/web/src/main.ts');
