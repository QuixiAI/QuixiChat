import { isQuixiId } from "../model/validation.ts";
import type { QuixiId } from "../model/types.ts";
import { jsonByteLength } from "./serialization.ts";

export const MAX_TRANSFER_BYTES = 1_048_576;
export const MAX_IN_FLIGHT_CHUNKS = 4;
export const MAX_PENDING_REQUESTS = 64;
export interface ByteChunk { transferId: QuixiId; sequence: number; offset: number; bytes: Uint8Array; final: boolean }
export interface ChunkAcknowledgement { transferId: QuixiId; sequence: number; committedOffset: number }
export interface Progress {
  operationId: QuixiId; phase: string; status: "queued" | "running" | "waiting" | "complete" | "cancelled" | "failed";
  completedUnits: number; totalUnits: number | null; processedBytes: number; totalBytes: number | null;
}
export type CancellationOutcome = "not_dispatched" | "cancelled_before_commit" | "committed" | "unknown_outcome";
export interface CancellationResult { requestId: QuixiId; operationId: QuixiId | null; outcome: CancellationOutcome }
export type BoundaryErrorCode = "INVALID_REQUEST" | "UNSUPPORTED" | "OVERLOADED" | "CLOSED" | "NOT_FOUND" | "CONFLICT" | "CANCELLED" | "UNKNOWN_OUTCOME" | "QUOTA_EXCEEDED" | "IO_ERROR" | "MIGRATION_FAILED" | "INTERNAL";
export interface BoundaryError {
  code: BoundaryErrorCode; message: string; requestId: QuixiId; operationId: QuixiId | null;
  retry: "never" | "same_operation_id" | "after_user_action"; details: Record<string, string | number | boolean | null>;
}
export interface ImportBundle {
  version: 1; id: QuixiId; provider: string; method: "file_export" | "extension" | "provider_api" | "archive";
  capturedAt: number; sourceFormatVersion: string | null;
  entries: { id: QuixiId; path: string; mediaType: string; byteLength: number | null; sha256: string | null; availability: "available" | "missing" | "unavailable" }[];
}

/** Metadata-only backpressure window. Producers retain payloads until acknowledged. */
export class TransferWindow {
  private nextSequence = 0;
  private nextOffset = 0;
  private readonly pending = new Map<number, { end: number; bytes: number }>();
  private ended = false;
  constructor(readonly transferId: QuixiId, readonly maxBytes = MAX_TRANSFER_BYTES, readonly maxInFlight = MAX_IN_FLIGHT_CHUNKS) {
    if (!isQuixiId(transferId) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TRANSFER_BYTES || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > MAX_IN_FLIGHT_CHUNKS) throw new Error("Invalid transfer window");
  }
  reserve(chunk: ByteChunk): void {
    if (this.ended || chunk.transferId !== this.transferId || chunk.sequence !== this.nextSequence || chunk.offset !== this.nextOffset || !(chunk.bytes instanceof Uint8Array) || typeof chunk.final !== "boolean") throw new Error("Invalid transfer sequence, offset, ID, or payload");
    if (chunk.bytes.byteLength > this.maxBytes || (chunk.bytes.byteLength === 0 && !chunk.final)) throw new Error("Invalid transfer chunk size");
    if (this.pending.size >= this.maxInFlight) throw new Error("Transfer backpressure: await acknowledgement");
    const end = this.nextOffset + chunk.bytes.byteLength;
    if (!Number.isSafeInteger(end)) throw new Error("Transfer offset exceeds safe integer range");
    this.pending.set(chunk.sequence, {end,bytes:chunk.bytes.byteLength});
    this.nextSequence++; this.nextOffset = end; this.ended = chunk.final;
  }
  acknowledge(ack: ChunkAcknowledgement): void {
    const expected = this.pending.get(ack.sequence);
    if (ack.transferId !== this.transferId || !expected || ack.committedOffset !== expected.end) throw new Error("Acknowledgement does not match an in-flight chunk");
    this.pending.delete(ack.sequence);
  }
  get pendingBytes(): number { return [...this.pending.values()].reduce((sum, item) => sum + item.bytes, 0); }
  get complete(): boolean { return this.ended && this.pending.size === 0; }
}

export function validateImportBundle(value: unknown): value is ImportBundle {
  try { jsonByteLength(value,MAX_TRANSFER_BYTES); } catch { return false; }
  if (!value || typeof value !== "object") return false;
  const bundle = value as ImportBundle;
  if (bundle.version !== 1 || !isQuixiId(bundle.id) || typeof bundle.provider !== "string" || !bundle.provider || !["file_export","extension","provider_api","archive"].includes(bundle.method) || !Number.isSafeInteger(bundle.capturedAt) || bundle.capturedAt < 0 || !(bundle.sourceFormatVersion === null || typeof bundle.sourceFormatVersion === "string") || !Array.isArray(bundle.entries) || bundle.entries.length > 10_000) return false;
  const ids = new Set<string>(); const paths = new Set<string>();
  return bundle.entries.every(entry => {
    if (!entry || !isQuixiId(entry.id) || ids.has(entry.id) || typeof entry.path !== "string" || !entry.path || paths.has(entry.path) || entry.path.startsWith("/") || entry.path.includes("\\") || entry.path.split("/").some(segment => [".","..",""].includes(segment)) || typeof entry.mediaType !== "string" || !entry.mediaType || !["available","missing","unavailable"].includes(entry.availability)) return false;
    if (!(entry.byteLength === null || (Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0)) || !(entry.sha256 === null || (typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256))) || (entry.availability === "available" && (entry.byteLength === null || entry.sha256 === null))) return false;
    ids.add(entry.id); paths.add(entry.path); return true;
  });
}
