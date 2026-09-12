import { assertStorageRequest, jsonByteLength, MAX_TRANSFER_BYTES } from "@quixi/core/contracts";
import type { ArchiveSelection, BoundaryError, ByteChunk, ChunkAcknowledgement, Progress, SearchIndexStatus, StorageRequest } from "@quixi/core/contracts";
import { isQuixiId } from "@quixi/core/model";

export type ArchiveCall =
  | { id: string; kind: "request"; request: StorageRequest }
  | { id: string; kind: "upload"; chunk: ByteChunk }
  | { id: string; kind: "read"; transferId: string }
  | { id: string; kind: "ack"; acknowledgement: ChunkAcknowledgement }
  | { id: string; kind: "cancel"; targetRequestId: string; operationId: string | null };
export type ArchiveReply = { type: "reply"; id: string; ok: true; result: unknown } | { type: "reply"; id: string; ok: false; error: BoundaryError };
// The transport version is independent of StorageRequest's canonical contract
// version. Old followers can forward requests without opening SQLite, so schema
// rejection alone cannot prevent an old client from using a new owner.
export const ARCHIVE_PROTOCOL_VERSION = 4 as const;
export type ArchiveInput = ({ type: "init"; selection: ArchiveSelection } | { type: "call"; selection: ArchiveSelection; call: ArchiveCall } | { type: "close" }) & { version: typeof ARCHIVE_PROTOCOL_VERSION };
export type ArchiveOutputPayload = ArchiveReply | { type: "closed" } | { type: "fatal"; error: BoundaryError } | { type: "changed"; operationIds: string[] } | { type: "progress"; progress: Progress } | { type: "search"; status: SearchIndexStatus } | { type: 'selection'; selection: ArchiveSelection };
export type ArchiveOutput = ArchiveOutputPayload & { version: typeof ARCHIVE_PROTOCOL_VERSION };
export function hasArchiveProtocolVersion(value: unknown): value is { version: typeof ARCHIVE_PROTOCOL_VERSION; type: string } {
  return !!value && typeof value === "object" && "version" in value && value.version === ARCHIVE_PROTOCOL_VERSION && "type" in value && typeof value.type === "string";
}
export function archiveChannelName(archiveId: string): string {
  if (!validArchiveId(archiveId)) throw new Error("Invalid archive ID");
  return `quixi:archive:${archiveId}:v${ARCHIVE_PROTOCOL_VERSION}`;
}
export const ARCHIVE_MAX_PENDING = 64;
export const ARCHIVE_MAX_CANCEL_PENDING = 8;
export const validArchiveId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(id);
export function validateChunk(chunk: ByteChunk): void {
  if (!chunk || !isQuixiId(chunk.transferId) || !Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || !(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength > MAX_TRANSFER_BYTES || (!chunk.bytes.byteLength && !chunk.final) || typeof chunk.final !== "boolean" || !Number.isSafeInteger(chunk.offset + chunk.bytes.byteLength)) throw new Error("Invalid bounded byte chunk");
}
export function validateAck(ack: ChunkAcknowledgement): void {
  if (!ack || !isQuixiId(ack.transferId) || !Number.isSafeInteger(ack.sequence) || ack.sequence < 0 || !Number.isSafeInteger(ack.committedOffset) || ack.committedOffset < 0) throw new Error("Invalid byte acknowledgement");
}
export function validateArchiveCall(call: ArchiveCall): void {
  if (!call || !isQuixiId(call.id)) throw new Error("Invalid storage call identity");
  if (call.kind === "upload") { validateChunk(call.chunk); return; }
  jsonByteLength(call, MAX_TRANSFER_BYTES + 256);
  switch (call.kind) {
    case "request": assertStorageRequest(call.request); if (call.id !== call.request.requestId) throw new Error("Storage call/request identity mismatch"); break;
    case "read": if (!isQuixiId(call.transferId)) throw new Error("Invalid read transfer identity"); break;
    case "ack": validateAck(call.acknowledgement); break;
    case "cancel": if (!isQuixiId(call.targetRequestId) || !(call.operationId === null || isQuixiId(call.operationId))) throw new Error("Invalid cancellation identity"); break;
    default: throw new Error("Unknown storage call");
  }
}
export function callOperationId(call: ArchiveCall): string | null {
  if (call.kind !== "request") return call.kind === "cancel" ? call.operationId : null;
  const args = call.request.args;
  return args && typeof args === "object" && "operationId" in args && isQuixiId(args.operationId) ? args.operationId : null;
}
export function archiveError(error: unknown, id: string, operationId: string | null = null, fallback: BoundaryError["code"] = "IO_ERROR"): BoundaryError {
  const codes: BoundaryError["code"][] = ["INVALID_REQUEST", "UNSUPPORTED", "OVERLOADED", "CLOSED", "NOT_FOUND", "CONFLICT", "CANCELLED", "UNKNOWN_OUTCOME", "QUOTA_EXCEEDED", "IO_ERROR", "MIGRATION_FAILED", "INTERNAL"];
  const candidate = error as { code?: string; resultCode?: number; name?: string; message?: string; cause?: unknown } | null;
  const causeName = (candidate?.cause as { name?: unknown } | null)?.name;
  const denied = (name: unknown) => name === "NotAllowedError" || name === "SecurityError";
  const sqliteCode = typeof candidate?.resultCode === "number" ? candidate.resultCode & 255 : null;
  const extractionCode = candidate?.name === 'ExtractionStorageError' ? candidate.code : undefined;
  const mapped: BoundaryError['code'] | undefined = extractionCode === 'CAPACITY' ? 'QUOTA_EXCEEDED' : extractionCode === 'STALE_WRITER' ? 'CONFLICT' : extractionCode === 'SOURCE_UNAVAILABLE' ? 'IO_ERROR' : undefined;
  const code = mapped ?? (candidate?.code && codes.includes(candidate.code as BoundaryError['code']) ? candidate.code as BoundaryError['code'] : candidate?.name === "QuotaExceededError" || sqliteCode === 13 ? "QUOTA_EXCEEDED" : denied(candidate?.name) || denied(causeName) ? "UNSUPPORTED" : sqliteCode === 19 ? "CONFLICT" : candidate?.name === "ModelValidationError" ? "INVALID_REQUEST" : fallback);
  const message = (typeof candidate?.message === "string" ? candidate.message : String(error)).slice(0, 4096);
  return { code, message, requestId: id, operationId, retry: code === "UNKNOWN_OUTCOME" ? "same_operation_id" : ["QUOTA_EXCEEDED", "IO_ERROR", "MIGRATION_FAILED"].includes(code) ? "after_user_action" : "never", details: extractionCode ? { extractionCode } : {} };
}
export class ArchiveStorageError extends Error {
  readonly code: BoundaryError["code"];
  constructor(readonly detail: BoundaryError) { super(detail.message); this.name = "ArchiveStorageError"; this.code = detail.code; }
}
