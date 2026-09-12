import { isQuixiId } from '../model/validation.ts';
import type { PageBudget } from './storage.ts';

/** Product §101 Quixi Doctor audits (plan 23): branch invariants, import
 * provenance and sync-operation coverage as one bounded, cancellable,
 * read-only scan over canonical rows. Findings name managed identifiers
 * (record ids, collections, counts) and never record content. */
export const DOCTOR_AUDIT_MAX_ITEMS = 64;
export const DOCTOR_AUDIT_KINDS = [
  'missing_parent', 'cross_thread_parent', 'self_reference', 'part_count_mismatch', 'generation_link_mismatch', 'edited_from_missing',
  'dangling_active_leaf', 'missing_context', 'thread_without_state', 'context_chain_break',
  'missing_import_source', 'missing_provenance_entity', 'missing_raw_object', 'dangling_source_identity',
  'sync_affects_missing', 'sync_affects_malformed',
] as const;
export type DoctorAuditFindingKind = typeof DOCTOR_AUDIT_KINDS[number];
export type DoctorAuditPhase = 'preparing' | 'branches' | 'provenance' | 'sync' | 'finished';
export interface DoctorAuditStatus {
  scanId: string;
  state: 'running' | 'complete' | 'cancelled' | 'stale' | 'failed';
  phase: DoctorAuditPhase;
  startedAt: number;
  updatedAt: number;
  scannedRecords: number;
  scannedOperations: number;
  counts: Record<DoctorAuditFindingKind, number>;
  message: string | null;
}
export interface DoctorAuditFinding {
  sequence: number;
  kind: DoctorAuditFindingKind;
  /** The canonical collection and record id, or `sync_ops` with the operation id. */
  collection: string;
  id: string;
  relatedCollection: string | null;
  relatedId: string | null;
  expected: number | null;
  actual: number | null;
}
export interface DoctorAuditPage { items: DoctorAuditFinding[]; nextCursor: string | null; bytes: number }
export interface DoctorAuditOperations {
  beginDoctorAudit: { args: { scanId: string }; result: DoctorAuditStatus };
  advanceDoctorAudit: { args: { scanId: string; maxItems: number }; result: DoctorAuditStatus };
  doctorAuditStatus: { args: { scanId: string }; result: DoctorAuditStatus };
  readDoctorAuditFindings: { args: { scanId: string; page: PageBudget }; result: DoctorAuditPage };
  cancelDoctorAudit: { args: { scanId: string }; result: DoctorAuditStatus };
}
export function assertDoctorAuditArgs(operation: keyof DoctorAuditOperations, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Doctor audit arguments');
  const args = value as Record<string, unknown>;
  const keys = operation === 'advanceDoctorAudit' ? ['scanId', 'maxItems'] : operation === 'readDoctorAuditFindings' ? ['scanId', 'page'] : ['scanId'];
  if (!isQuixiId(args.scanId) || Object.keys(args).length !== keys.length || !keys.every(key => Object.hasOwn(args, key))) throw new Error('Invalid Doctor audit identity or argument fields');
  if (operation === 'advanceDoctorAudit' && (!Number.isSafeInteger(args.maxItems) || Number(args.maxItems) < 1 || Number(args.maxItems) > DOCTOR_AUDIT_MAX_ITEMS)) throw new Error('Doctor audit work exceeds its item bound');
  if (operation === 'readDoctorAuditFindings') {
    const page = args.page as Partial<PageBudget> | null;
    if (!page || typeof page !== 'object' || Array.isArray(page) || Object.keys(page).length !== 3 || !Number.isSafeInteger(page.maxItems) || page.maxItems! < 1 || page.maxItems! > DOCTOR_AUDIT_MAX_ITEMS || !Number.isSafeInteger(page.maxBytes) || page.maxBytes! < 1 || page.maxBytes! > 65_536 || (page.cursor !== null && typeof page.cursor !== 'string')) throw new Error('Invalid Doctor audit page budget');
  }
}
