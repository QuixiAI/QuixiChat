import type { ArchiveActivationReview } from './archives.ts';
import { isQuixiId } from '../model/validation.ts';
import { jsonByteLength } from './serialization.ts';

/** Host-local selection revision, distinct from an archive's sync high water. */
export interface ArchiveSelection { archiveId: string; selectionRevision: number }
export interface ArchiveActivationArgs {
  operationId: string;
  expectedSelection: ArchiveSelection;
  review: ArchiveActivationReview;
}
export interface ArchiveActivationReceipt {
  operationId: string;
  payloadSha256: string;
  previous: ArchiveSelection;
  selected: ArchiveSelection;
  review: ArchiveActivationReview;
}
export type ArchiveActivationStatus =
  | { status: 'not_found' }
  | { status: 'prepared' | 'interrupted' | 'failed'; payloadSha256: string; reason: string | null }
  | { status: 'committed'; payloadSha256: string; receipt: ArchiveActivationReceipt };
export interface ArchiveSelectionOperations {
  readArchiveActivationContext: { args: null; result: { selection: ArchiveSelection; expectedRevision: number } };
  activateRestoredArchive: { args: ArchiveActivationArgs; result: ArchiveActivationReceipt };
}

function exactKeys(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(','))
    throw new Error('Invalid archive activation fields');
}
export function assertArchiveActivationArgs(value: unknown): asserts value is ArchiveActivationArgs {
  jsonByteLength(value, 16_384);
  exactKeys(value, ['operationId', 'expectedSelection', 'review']);
  if (!isQuixiId(value.operationId)) throw new Error('Invalid activation operation identity');
  assertArchiveSelection(value.expectedSelection);
  exactKeys(value.review, ['token', 'jobId', 'candidate', 'expectedActiveArchiveId', 'expectedRevision']);
  const review = value.review;
  if (!isQuixiId(review.token) || !isQuixiId(review.jobId) || review.expectedActiveArchiveId !== value.expectedSelection.archiveId ||
      typeof review.expectedRevision !== 'number' || !Number.isSafeInteger(review.expectedRevision) || review.expectedRevision < 0)
    throw new Error('Invalid activation source review');
  exactKeys(review.candidate, ['archiveId', 'schemaVersion', 'canonicalRecords', 'syncOperations', 'blobCount', 'blobBytes', 'streamingGenerations', 'defaultWorkspaceId', 'manifestSha256']);
  const candidate = review.candidate;
  if (!isQuixiId(candidate.archiveId) || candidate.archiveId === value.expectedSelection.archiveId ||
      !(candidate.defaultWorkspaceId === null || isQuixiId(candidate.defaultWorkspaceId)) ||
      typeof candidate.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.manifestSha256)) throw new Error('Invalid activation candidate identity');
  for (const key of ['schemaVersion', 'canonicalRecords', 'syncOperations', 'blobCount', 'blobBytes', 'streamingGenerations'])
    if (typeof candidate[key] !== 'number' || !Number.isSafeInteger(candidate[key]) || candidate[key] < (key === 'schemaVersion' ? 1 : 0)) throw new Error('Invalid activation candidate count');
}

export function assertArchiveSelection(value: unknown): asserts value is ArchiveSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'archiveId,selectionRevision' ||
      !('archiveId' in value) || typeof value.archiveId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.archiveId) ||
      !('selectionRevision' in value) || typeof value.selectionRevision !== 'number' ||
      !Number.isSafeInteger(value.selectionRevision) || value.selectionRevision < 0) {
    throw new Error('Invalid archive selection fence');
  }
}

export function sameArchiveSelection(a: ArchiveSelection, b: ArchiveSelection): boolean {
  return a.archiveId === b.archiveId && a.selectionRevision === b.selectionRevision;
}
