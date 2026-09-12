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
