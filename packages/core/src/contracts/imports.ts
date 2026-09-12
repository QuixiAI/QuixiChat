import type { CanonicalHistory, JsonValue, QuixiId } from '../model/types.ts';
import { isQuixiId, validateEntityShape } from '../model/validation.ts';
import { jsonByteLength } from './serialization.ts';
import type { EntityPage, PageBudget } from './storage.ts';

export type ImportCollection = Exclude<keyof CanonicalHistory, 'version' | 'tombstones'>;
/** Original normalized records; blob bytes use the independent verified transfer lifecycle. */
export type StagedImportRecord = { [C in ImportCollection]: {
  collection: C; record: NonNullable<CanonicalHistory[C]>[number]; operationId: QuixiId; recordedAt: number;
} }[ImportCollection];
export interface NormalizedImportStatus {
  importId: QuixiId; threadId: QuixiId; mode: 'create' | 'extend';
  state: 'staging' | 'validating' | 'ready' | 'published' | 'cancelled';
  nextSequence: number; recordCount: number; validatedRecords: number;
  manifestDigest: string; publicationOperationId: QuixiId | null;
}
export interface NormalizedImportOperations {
  prepareImportBlobs: { args: {operationId:QuixiId;importId:QuixiId;stagedBlobIds:QuixiId[]}; result:NormalizedImportStatus };
  beginNormalizedImport: { args: { operationId: QuixiId; importId: QuixiId; threadId: QuixiId; mode: 'create' | 'extend'; expectedThreadRevision: number | null; recordedAt: number }; result: NormalizedImportStatus };
  stageImportRecords: { args: { operationId: QuixiId; importId: QuixiId; sequence: number; records: StagedImportRecord[] }; result: NormalizedImportStatus };
  /** Freezes staging. Each call advances at most maxRecords topology/record checks. Revalidation is required after owner restart or a concurrent canonical commit. */
  validateImportStep: { args: { operationId: QuixiId; importId: QuixiId; maxRecords: number; stagedBlobIds: QuixiId[] }; result: NormalizedImportStatus };
  /** Cancellation is honored before the final SQL transaction. Unknown outcomes must query/retry these same identities. */
  finalizeNormalizedImport: { args: { operationId: QuixiId; importId: QuixiId; recordedAt: number; expectedRecordCount: number; expectedManifestDigest: string }; result: NormalizedImportStatus };
  cancelNormalizedImport: { args: { operationId: QuixiId; importId: QuixiId }; result: NormalizedImportStatus };
  normalizedImportStatus: { args: { importId: QuixiId }; result: NormalizedImportStatus };
  /** Items are StagedImportRecord envelopes, ordered by staging ordinal. Only unpublished records are retained here. */
  readStagedImportRecords: { args: { importId: QuixiId; page: PageBudget }; result: EntityPage };
}
/** Sync receivers retain these records in a hidden group until the matching PublishImport count/digest is verified. */
export interface ImportRecordPayload { importId: QuixiId; ordinal: number; collection: ImportCollection; record: JsonValue }
export interface PublishImportPayload {
  importId: QuixiId; threadId: QuixiId; mode: 'create' | 'extend'; recordCount: number;
  /** SHA256 chain: initial 64 zeroes; next = SHA256(canonicalJson([previous, record operation identity hash])). */
  manifestDigest: string;
}
export const NORMALIZED_IMPORT_LIMITS = Object.freeze({ maxRecordsPerRequest:128, maxRecordBytes:262_144, maxActiveJobs:8 });
const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
export function assertNormalizedImportArgs(operation: keyof NormalizedImportOperations, value: unknown): void {
  jsonByteLength(value);
  if (!value || typeof value !== 'object') throw new Error('Invalid normalized import arguments');
  const args=value as Record<string, unknown>;
  if (!isQuixiId(args.importId)) throw new Error('Invalid import identity');
  if (operation === 'normalizedImportStatus' || operation === 'readStagedImportRecords') return;
  if (!isQuixiId(args.operationId)) throw new Error('Invalid import operation identity');
  switch(operation) {
    case 'beginNormalizedImport':
      if (!isQuixiId(args.threadId) || !['create','extend'].includes(String(args.mode)) || !count(args.recordedAt) || (args.mode === 'create' ? args.expectedThreadRevision !== null : !count(args.expectedThreadRevision))) throw new Error('Invalid normalized import declaration');
      break;
    case 'stageImportRecords': {
      if (!count(args.sequence) || !Array.isArray(args.records) || args.records.length < 1 || args.records.length > NORMALIZED_IMPORT_LIMITS.maxRecordsPerRequest) throw new Error('Invalid bounded import batch');
      const ids=new Set<string>();
      for (const entry of args.records as StagedImportRecord[]) {
        if (!entry || !isQuixiId(entry.operationId) || entry.operationId===args.operationId || ids.has(entry.operationId) || !count(entry.recordedAt) || !['threads','threadStates','contexts','messages','generations','parts','events','attachments','documents','rawObjects','importSources','sourceIdentities','provenance'].includes(entry.collection)) throw new Error('Invalid imported record envelope');
        ids.add(entry.operationId); jsonByteLength(entry.record,NORMALIZED_IMPORT_LIMITS.maxRecordBytes);
        if (validateEntityShape(entry.collection,entry.record).length) throw new Error('Invalid normalized record shape');
      }
      break;
    }
    case 'prepareImportBlobs':
      if(!Array.isArray(args.stagedBlobIds)||args.stagedBlobIds.length>128||!args.stagedBlobIds.every(isQuixiId)||new Set(args.stagedBlobIds).size!==args.stagedBlobIds.length)throw new Error('Invalid import blob preparation');break;
    case 'validateImportStep':
      if (!count(args.maxRecords) || Number(args.maxRecords)<1 || Number(args.maxRecords)>NORMALIZED_IMPORT_LIMITS.maxRecordsPerRequest || !Array.isArray(args.stagedBlobIds) || args.stagedBlobIds.length>128 || !args.stagedBlobIds.every(isQuixiId) || new Set(args.stagedBlobIds).size!==args.stagedBlobIds.length) throw new Error('Invalid bounded validation step');
      break;
    case 'finalizeNormalizedImport':
      if (!count(args.recordedAt) || !count(args.expectedRecordCount) || !/^[0-9a-f]{64}$/.test(String(args.expectedManifestDigest))) throw new Error('Invalid publication manifest');
      break;
    case 'cancelNormalizedImport': break;
  }
}
