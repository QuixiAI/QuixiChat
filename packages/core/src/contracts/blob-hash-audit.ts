import { isQuixiId } from '../model/validation.ts';
import type { PageBudget } from './storage.ts';

/** Product §101 "verify blob hashes" (plan 23): every catalogued file's bytes
 * are re-read through the production verified-read path and compared with
 * its SHA-256, in bounded, cancellable slices. Findings name digests and
 * sizes only. */
export const BLOB_HASH_AUDIT_MAX_ITEMS = 64;
export const BLOB_HASH_AUDIT_KINDS = ['hash_mismatch', 'size_mismatch', 'missing_blob', 'read_error'] as const;
export type BlobHashAuditFindingKind = typeof BLOB_HASH_AUDIT_KINDS[number];
export interface BlobHashAuditStatus {
  scanId: string;
  state: 'running' | 'complete' | 'cancelled' | 'stale' | 'failed';
  phase: 'preparing' | 'hashing' | 'finished';
  startedAt: number;
  updatedAt: number;
  /** Catalogued files at start and how many have been examined. */
  totalFiles: number;
  scannedFiles: number;
  totalBytes: number;
  verifiedBytes: number;
  counts: Record<BlobHashAuditFindingKind, number>;
  message: string | null;
}
export interface BlobHashAuditFinding {
  sequence: number;
  kind: BlobHashAuditFindingKind;
  sha256: string;
  /** Managed digest path only; never an original filename. */
  path: string;
  expectedBytes: number;
  actualBytes: number | null;
}
export interface BlobHashAuditPage { items: BlobHashAuditFinding[]; nextCursor: string | null; bytes: number }
export interface BlobHashAuditOperations {
  beginBlobHashAudit: { args: { scanId: string }; result: BlobHashAuditStatus };
  advanceBlobHashAudit: { args: { scanId: string; maxItems: number }; result: BlobHashAuditStatus };
  blobHashAuditStatus: { args: { scanId: string }; result: BlobHashAuditStatus };
  readBlobHashAuditFindings: { args: { scanId: string; page: PageBudget }; result: BlobHashAuditPage };
  cancelBlobHashAudit: { args: { scanId: string }; result: BlobHashAuditStatus };
}
export function assertBlobHashAuditArgs(operation: keyof BlobHashAuditOperations, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid blob hash audit arguments');
  const args = value as Record<string, unknown>;
  const keys = operation === 'advanceBlobHashAudit' ? ['scanId', 'maxItems'] : operation === 'readBlobHashAuditFindings' ? ['scanId', 'page'] : ['scanId'];
  if (!isQuixiId(args.scanId) || Object.keys(args).length !== keys.length || !keys.every(key => Object.hasOwn(args, key))) throw new Error('Invalid blob hash audit identity or argument fields');
  if (operation === 'advanceBlobHashAudit' && (!Number.isSafeInteger(args.maxItems) || Number(args.maxItems) < 1 || Number(args.maxItems) > BLOB_HASH_AUDIT_MAX_ITEMS)) throw new Error('Blob hash audit work exceeds its item bound');
  if (operation === 'readBlobHashAuditFindings') {
    const page = args.page as Partial<PageBudget> | null;
    if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).length !== 3 || !Number.isSafeInteger(page.maxItems) || page.maxItems! < 1 || page.maxItems! > BLOB_HASH_AUDIT_MAX_ITEMS || !Number.isSafeInteger(page.maxBytes) || page.maxBytes! < 1 || page.maxBytes! > 65_536 || (page.cursor !== null && typeof page.cursor !== 'string')) throw new Error('Invalid blob hash audit page budget');
  }
}
