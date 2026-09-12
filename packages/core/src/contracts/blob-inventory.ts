import { isQuixiId } from '../model/validation.ts';
import type { PageBudget } from './storage.ts';

export const BLOB_INVENTORY_MAX_ITEMS = 64;
export const BLOB_INVENTORY_KINDS = ['missing_blob', 'missing_catalog', 'orphan_blob', 'size_mismatch', 'protected_blob', 'staged_file', 'unrecognized_entry'] as const;
export type BlobInventoryFindingKind = typeof BLOB_INVENTORY_KINDS[number];
export interface BlobInventoryStatus {
  scanId: string;
  state: 'running' | 'complete' | 'cancelled' | 'stale' | 'failed';
  phase: 'preparing' | 'references' | 'transfers' | 'catalog' | 'files' | 'finished';
  startedAt: number;
  updatedAt: number;
  scannedRecords: number;
  scannedTransfers: number;
  scannedCatalogEntries: number;
  scannedFiles: number;
  counts: Record<BlobInventoryFindingKind, number>;
  message: string | null;
}
export interface BlobInventoryFinding {
  sequence: number;
  kind: BlobInventoryFindingKind;
  sha256: string | null;
  /** Only managed digest/UUID paths; never original uploaded names or content. */
  path: string | null;
  expectedBytes: number | null;
  actualBytes: number | null;
  references: number;
}
export interface BlobInventoryPage {
  items: BlobInventoryFinding[];
  nextCursor: string | null;
  bytes: number;
}
export const BLOB_CLEANUP_MAX_ITEMS = 32;
export type BlobCleanupRefusal = 'not_a_finding' | 'referenced' | 'protected' | 'in_use' | 'missing' | 'stale';
/** Plan 23 reviewed cleanup: only digests the user selected from a complete,
 * current scan's orphan findings are deleted, each re-checked at deletion. */
export interface BlobCleanupResult {
  scanId: string;
  deleted: { sha256: string; byteLength: number | null; catalogRemoved: boolean }[];
  refused: { sha256: string; reason: BlobCleanupRefusal }[];
  status: BlobInventoryStatus;
}
export interface BlobInventoryOperations {
  beginBlobInventory: { args: { scanId: string }; result: BlobInventoryStatus };
  advanceBlobInventory: { args: { scanId: string; maxItems: number }; result: BlobInventoryStatus };
  blobInventoryStatus: { args: { scanId: string }; result: BlobInventoryStatus };
  readBlobInventoryFindings: { args: { scanId: string; page: PageBudget }; result: BlobInventoryPage };
  cancelBlobInventory: { args: { scanId: string }; result: BlobInventoryStatus };
  /** Deletes the selected unreferenced files (and their catalog rows) reported by this complete, current scan; the scan then reads stale. */
  deleteOrphanBlobs: { args: { scanId: string; sha256s: string[] }; result: BlobCleanupResult };
}
export function assertBlobInventoryArgs(operation: keyof BlobInventoryOperations, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid blob inventory arguments');
  const args = value as Record<string, unknown>;
  const keys = operation === 'advanceBlobInventory' ? ['scanId', 'maxItems'] : operation === 'readBlobInventoryFindings' ? ['scanId', 'page'] : operation === 'deleteOrphanBlobs' ? ['scanId', 'sha256s'] : ['scanId'];
  if (!isQuixiId(args.scanId) || Object.keys(args).length !== keys.length || !keys.every(key => Object.hasOwn(args, key))) throw new Error('Invalid blob inventory identity or argument fields');
  if (operation === 'advanceBlobInventory' && (!Number.isSafeInteger(args.maxItems) || Number(args.maxItems) < 1 || Number(args.maxItems) > BLOB_INVENTORY_MAX_ITEMS)) throw new Error('Blob inventory work exceeds its item bound');
  if (operation === 'deleteOrphanBlobs') {
    const digests = args.sha256s;
    if (!Array.isArray(digests) || digests.length < 1 || digests.length > BLOB_CLEANUP_MAX_ITEMS || new Set(digests).size !== digests.length || !digests.every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value))) throw new Error('Blob cleanup needs one to thirty-two distinct digests');
  }
  if (operation === 'readBlobInventoryFindings') {
    const page = args.page as Partial<PageBudget> | null;
    if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).length !== 3 || !Number.isSafeInteger(page.maxItems) || page.maxItems! < 1 || page.maxItems! > BLOB_INVENTORY_MAX_ITEMS || !Number.isSafeInteger(page.maxBytes) || page.maxBytes! < 1024 || page.maxBytes! > 65_536 || !(page.cursor === null || typeof page.cursor === 'string' && page.cursor.length <= 256)) throw new Error('Invalid bounded blob inventory page');
  }
}
