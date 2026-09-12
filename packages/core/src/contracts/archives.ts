import type { QuixiId } from "../model/types.ts";
import { isQuixiId } from "../model/validation.ts";
import { jsonByteLength } from "./serialization.ts";

export type ArchiveExportFormat = "portable" | "open";
export interface ArchiveJobStatus {
  jobId: QuixiId;
  kind: "export" | "restore";
  format: ArchiveExportFormat;
  state: "working" | "ready" | "cancelled" | "failed" | "released";
  phase:
    | "snapshot"
    | "encoding"
    | "receiving"
    | "container_validation"
    | "schema_validation"
    | "record_validation"
    | "blob_validation"
    | "ready"
    | "cleanup";
  completedBytes: number;
  totalBytes: number | null;
  completedRecords: number;
  totalRecords: number | null;
  entryCount: number;
  /** Restore only: the migration ledger length the received database carried,
   * read from its own ledger. When it is below the candidate's schema, the
   * isolated candidate was upgraded through the fresh-schema copy before
   * validation; the received bytes are never changed. Null until read. */
  sourceSchemaVersion?: number | null;
  failure: { code: string; reason: string } | null;
  /** Set only for an export after its complete output has been flushed. */
  output: {
    name: string;
    mediaType: "application/x-tar";
    byteLength: number;
    sha256: string;
  } | null;
  /** Ready restore is isolated and does not change the active archive. */
  candidate: ArchiveCandidateSummary | null;
}
export interface ArchiveCandidateSummary {
  archiveId: QuixiId;
  schemaVersion: number;
  canonicalRecords: number;
  syncOperations: number;
  blobCount: number;
  blobBytes: number;
  streamingGenerations: number;
  defaultWorkspaceId: QuixiId | null;
  manifestSha256: string;
}
export interface ArchiveTransfer {
  transferId: QuixiId;
  maxChunkBytes: number;
  maxInFlight: number;
}
/** A review token is not user consent. Activation is a separate, host-wide
 * operation whose UI must explicitly review the exact replacement candidate. */
export interface ArchiveActivationReview {
  token: QuixiId;
  jobId: QuixiId;
  candidate: ArchiveCandidateSummary;
  expectedActiveArchiveId: string;
  expectedRevision: number;
}
export interface ArchivesOperations {
  listArchiveJobs: {
    args: { afterJobId: QuixiId | null; maxItems: number };
    result: { items: ArchiveJobStatus[]; nextJobId: QuixiId | null };
  };
  beginArchiveExport: {
    args: { operationId: QuixiId; format: ArchiveExportFormat };
    result: ArchiveJobStatus;
  };
  advanceArchiveJob: {
    args: {
      operationId: QuixiId;
      jobId: QuixiId;
      maxRecords: number;
      maxBytes: number;
    };
    result: ArchiveJobStatus;
  };
  archiveJobStatus: { args: { jobId: QuixiId }; result: ArchiveJobStatus };
  openArchiveExport: {
    args: { jobId: QuixiId };
    result: ArchiveTransfer & { byteLength: number; sha256: string };
  };
  beginArchiveRestore: {
    args: {
      operationId: QuixiId;
      expectedBytes: number | null;
      expectedSha256: string | null;
    };
    result: { job: ArchiveJobStatus; inputTransfer: ArchiveTransfer };
  };
  finishArchiveRestore: {
    args: {
      operationId: QuixiId;
      jobId: QuixiId;
      byteLength: number;
      sha256: string;
    };
    result: ArchiveJobStatus;
  };
  cancelArchiveJob: {
    args: { operationId: QuixiId; jobId: QuixiId };
    result: ArchiveJobStatus;
  };
  releaseArchiveJob: {
    args: { operationId: QuixiId; jobId: QuixiId };
    result: ArchiveJobStatus;
  };
  prepareArchiveActivation: {
    args: {
      operationId: QuixiId;
      jobId: QuixiId;
      expectedActiveArchiveId: string;
      expectedRevision: number;
    };
    result: ArchiveActivationReview;
  };
}
export const ARCHIVE_LIMITS = Object.freeze({
  chunkBytes: 65_536,
  maxInFlight: 4,
  maxActiveJobs: 2,
  maxRecordsPerStep: 128,
  maxBytesPerStep: 1_048_576,
  maxMetadataBytes: 65_536,
  maxEntryBytes: Number.MAX_SAFE_INTEGER,
  maxEntries: 1_000_000,
});
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function assertArchivesArgs(
  operation: keyof ArchivesOperations,
  value: unknown,
): void {
  jsonByteLength(value, ARCHIVE_LIMITS.maxMetadataBytes);
  if (!value || typeof value !== "object")
    throw new Error("Invalid archive arguments.");
  const args = value as Record<string, unknown>;
  if (
    !["beginArchiveExport", "beginArchiveRestore", "listArchiveJobs"].includes(
      operation,
    ) &&
    !isQuixiId(args.jobId)
  )
    throw new Error("Invalid archive job ID.");
  if (
    !["archiveJobStatus", "openArchiveExport", "listArchiveJobs"].includes(
      operation,
    ) &&
    !isQuixiId(args.operationId)
  )
    throw new Error("Invalid archive operation ID.");
  switch (operation) {
    case "listArchiveJobs":
      if (
        !(args.afterJobId === null || isQuixiId(args.afterJobId)) ||
        !count(args.maxItems) ||
        args.maxItems < 1 ||
        args.maxItems > 16
      )
        throw new Error("Invalid archive job page.");
      break;
    case "beginArchiveExport":
      if (!["portable", "open"].includes(String(args.format)))
        throw new Error("Unsupported archive export format.");
      break;
    case "advanceArchiveJob":
      if (
        !count(args.maxRecords) ||
        args.maxRecords < 1 ||
        args.maxRecords > ARCHIVE_LIMITS.maxRecordsPerStep ||
        !count(args.maxBytes) ||
        args.maxBytes < 512 ||
        args.maxBytes > ARCHIVE_LIMITS.maxBytesPerStep
      )
        throw new Error("Invalid bounded archive step.");
      break;
    case "beginArchiveRestore":
      if (
        !(args.expectedBytes === null || count(args.expectedBytes)) ||
        !(args.expectedSha256 === null || digest(args.expectedSha256))
      )
        throw new Error("Invalid archive input declaration.");
      break;
    case "finishArchiveRestore":
      if (!count(args.byteLength) || !digest(args.sha256))
        throw new Error("Invalid archive input completion.");
      break;
    case "prepareArchiveActivation":
      if (
        typeof args.expectedActiveArchiveId !== "string" ||
        args.expectedActiveArchiveId.length < 1 ||
        args.expectedActiveArchiveId.length > 128 ||
        !count(args.expectedRevision)
      )
        throw new Error("Invalid active archive review fence.");
      break;
  }
}
