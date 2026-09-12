/** Synthetic corruption helpers. Never imported by a production entry point. */
export interface BlobInventoryFingerprint {
  canonicalSha256: string;
  operationsSha256: string;
  blobOperationsSha256: string;
  blobCatalogSha256: string;
  blobTransfersSha256: string;
  blobsSha256: string;
  canonicalRecords: number;
  syncOperations: number;
  physicalFiles: number;
  sqliteTemporaryStore: number;
  sqliteTemporaryCacheKiB: number;
}
export interface BlobInventoryFixture {
  archiveId: string;
  threadId: string;
  orphanCount: number;
  digests: Record<string, string>;
  transferIds: Record<string, string>;
  baseline: BlobInventoryFingerprint;
}
async function fixtureCall<T>(operation: string, archiveId: string, orphanCount?: number): Promise<T> {
  if (!/^test-[A-Za-z0-9_-]{1,59}$/.test(archiveId)) throw new Error('Blob fixture requires an explicit isolated test-* archive.');
  const worker = new Worker(new URL('./fixture-worker.ts', import.meta.url), { type: 'module' });
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bounded blob fixture worker timed out; close archive owners before fixture access.')), 60000);
      worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.onmessage = event => { clearTimeout(timer); event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result); };
      worker.postMessage({ operation, archiveId, orphanCount });
    });
  } finally { worker.terminate(); }
}
export const setupBlobInventoryFixture = (archiveId: string, orphanCount = 96) => fixtureCall<BlobInventoryFixture>('setup', archiveId, orphanCount);
/** Close all production archive owners first. Checks canonical rows, operations,
 * and every managed/unrecognized test file without hashing the mutable DB. */
export const fingerprintBlobInventoryFixture = (archiveId: string) => fixtureCall<BlobInventoryFingerprint>('fingerprint', archiveId);
export const cleanupBlobInventoryFixture = (archiveId: string) => fixtureCall<void>('cleanup', archiveId);
/** Deliberately invalid canonical input, available only to isolated tests. */
export const corruptBlobInventoryReference = (archiveId: string) => fixtureCall<BlobInventoryFingerprint>('malformed-reference', archiveId);
/** Plan 23 diagnostics faults, available only to isolated tests, applied
 * while no production owner holds the archive. `derived-failure` rewrites the
 * derived search ledger's checksum so the next owner refuses the derived index
 * (a rebuildable derived-index failure). `corrupt-database` creates an index
 * and removes only its sqlite_master row through writable_schema, leaving its
 * b-tree pages allocated but unreferenced, which SQLite's integrity_check
 * reports as pages that are never used (real file-level corruption). */
/** `doctor-faults` plants branch, provenance and sync-coverage damage as raw
 * rows: a message with a missing parent, a message whose part count differs
 * from its parts, a provenance row for a missing import source, and a sync
 * operation whose affects name a missing record. */
export type BlobInventoryFault = 'derived-failure' | 'corrupt-database' | 'doctor-faults';
export const injectBlobInventoryFault = (archiveId: string, fault: BlobInventoryFault) => fixtureCall<{ fault: BlobInventoryFault }>(fault, archiveId);
