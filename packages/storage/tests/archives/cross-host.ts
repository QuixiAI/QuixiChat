/** Plan 09 cross-host restore helpers shared by the web harness (export side)
 * and the native Tauri harness (restore side). Both sides reduce an archive
 * to per-collection record digests and per-file blob hashes so a bounded
 * report can prove the restored candidate equals the exported archive. */
import { canonicalJson } from '@quixi/core/contracts';
import type { EntityPage, StorageOperations } from '@quixi/core/contracts';
import type { CanonicalHistory, JsonValue } from '@quixi/core/model';

export const CROSS_HOST_COLLECTIONS = ['threads', 'threadStates', 'contexts', 'messages', 'generations', 'parts', 'events', 'attachments', 'documents', 'rawObjects', 'importSources', 'sourceIdentities', 'provenance', 'tombstones', 'summaryProposals'] as const;
export type CrossHostCollection = typeof CROSS_HOST_COLLECTIONS[number];
export interface CollectionDigest { count: number; sha256: string }
export interface BlobHash { path: string; sha256: string; bytes: number }
export interface CrossHostDump { collections: Record<CrossHostCollection, CollectionDigest>; records: number; blobs: BlobHash[] }
type Read = <K extends 'readEntities'>(operation: K, args: StorageOperations[K]['args']) => Promise<StorageOperations[K]['result']>;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return hex(await crypto.subtle.digest('SHA-256', data));
}
/** Every record of every collection, sorted by identity, reduced to a count and a canonical-JSON digest. */
export async function dumpCollections(read: Read): Promise<{ collections: Record<CrossHostCollection, CollectionDigest>; records: number }> {
  const collections = {} as Record<CrossHostCollection, CollectionDigest>;
  let records = 0;
  for (const collection of CROSS_HOST_COLLECTIONS) {
    const items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 10_000; pageIndex++) {
      const page: EntityPage = await read('readEntities', { collection: collection as Exclude<keyof CanonicalHistory, 'version'>, threadId: null, page: { maxItems: 64, maxBytes: 900_000, cursor } });
      items.push(...(page.items as Record<string, unknown>[]));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    items.sort((a, b) => String(a.id ?? a.threadId).localeCompare(String(b.id ?? b.threadId)));
    collections[collection] = { count: items.length, sha256: await sha256Hex(canonicalJson(items as unknown as JsonValue)) };
    records += items.length;
  }
  return { collections, records };
}
/** Hashes every managed blob file under `<archiveDirectory>/blobs/xx/<digest>` from the page's OPFS root. */
export async function hashBlobDirectory(archiveDirectory: string): Promise<BlobHash[]> {
  const root = await navigator.storage.getDirectory();
  const out: BlobHash[] = [];
  let archive: FileSystemDirectoryHandle;
  try { archive = await root.getDirectoryHandle(archiveDirectory); } catch { return out; }
  let blobs: FileSystemDirectoryHandle;
  try { blobs = await archive.getDirectoryHandle('blobs'); } catch { return out; }
  for await (const [prefix, entry] of (blobs as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    if (entry.kind !== 'directory') continue;
    for await (const [name, file] of (entry as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (file.kind !== 'file') continue;
      const blob = await (file as FileSystemFileHandle).getFile();
      out.push({ path: `blobs/${prefix}/${name}`, sha256: await sha256Hex(new Uint8Array(await blob.arrayBuffer())), bytes: blob.size });
      if (out.length > 4096) throw new Error('Cross-host blob hash exceeded its bound');
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
/** Sends portable bytes into an isolated restore candidate and validates it; never activates or releases it. */
export async function restorePortable(storage: { request<K extends keyof StorageOperations>(id: string, operation: K, args: StorageOperations[K]['args']): Promise<StorageOperations[K]['result']>; sendChunk(chunk: { transferId: string; sequence: number; offset: number; bytes: Uint8Array; final: boolean }): Promise<unknown> }, bytes: Uint8Array) {
  const id = () => crypto.randomUUID();
  const jobId = id(), digest = await sha256Hex(bytes);
  const begun = await storage.request(id(), 'beginArchiveRestore', { operationId: jobId, expectedBytes: bytes.length, expectedSha256: digest });
  let offset = 0, sequence = 0;
  while (offset < bytes.length) {
    const part = bytes.subarray(offset, offset + begun.inputTransfer.maxChunkBytes);
    await storage.sendChunk({ transferId: begun.inputTransfer.transferId, sequence: sequence++, offset, bytes: part, final: offset + part.length === bytes.length });
    offset += part.length;
  }
  let job = await storage.request(id(), 'finishArchiveRestore', { operationId: id(), jobId, byteLength: bytes.length, sha256: digest });
  let advances = 0; const phases: string[] = [];
  while (job.state === 'working') {
    job = await storage.request(id(), 'advanceArchiveJob', { operationId: id(), jobId, maxRecords: 128, maxBytes: 1_048_576 });
    advances++;
    if (phases.at(-1) !== job.phase) phases.push(job.phase);
    if (advances > 1_000_000) throw new Error('Restore validation did not finish');
  }
  return { jobId, digest, job, advances, phases };
}
