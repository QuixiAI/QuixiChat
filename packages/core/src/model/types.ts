/** Pure, serializable canonical records. Quixi IDs are injected lowercase UUIDv4 strings. */
export type QuixiId = string;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Timestamp = number;
export type Role = "system" | "user" | "assistant" | "tool";
export type GenerationStatus = "streaming" | "complete" | "stopped" | "failed" | "cancelled" | "partial";
export type Availability = "available" | "missing" | "unavailable";

export interface Thread {
  id: QuixiId; workspaceId: QuixiId; createdAt: Timestamp | null; recordedAt: Timestamp;
  systemPrompt: string | null; preferredRoute: JsonObject | null; importSourceId: QuixiId | null;
}
export interface ThreadState {
  threadId: QuixiId; title: string; tags: string[]; pinned: boolean; archived: boolean;
  activeLeafMessageId: QuixiId | null; contextSnapshotId: QuixiId; routingProfile: JsonObject | null; revision: number;
}
export interface ContextSnapshot {
  id: QuixiId; threadId: QuixiId; previousId: QuixiId | null; version: number;
  systemPrompt: string | null; preferredRoute: JsonObject | null; recordedAt: Timestamp;
  compaction?: ContextCompaction;
}
export interface AttachmentCompaction { version: 1; excludedPartIds: QuixiId[] }
export interface ReviewedSummary { proposalId: QuixiId; throughMessageId: QuixiId; reviewedText: string; reviewedTextSha256: string }
export type ContextCompaction = AttachmentCompaction | { version: 2; excludedPartIds: QuixiId[]; summary: ReviewedSummary | null };
export interface SummaryProposal {
  version: 1; id: QuixiId; threadId: QuixiId; recordedAt: Timestamp; generationId: QuixiId;
  sourceContextSnapshotId: QuixiId; requestContextSnapshotId: QuixiId; throughMessageId: QuixiId;
  sourceLeafMessageId: QuixiId; sourceThreadRevision: number;
  baseSummaryProposalId: QuixiId | null; baseSummaryContextId: QuixiId | null;
  sourceMessageCount: number; sourcePartCount: number; sourceFingerprint: string;
  inputRawObjectId: QuixiId; inputSha256: string; inputByteLength: number; promptTemplateVersion: 1;
}
export interface Message {
  id: QuixiId; threadId: QuixiId; parentId: QuixiId | null; role: Role;
  createdAt: Timestamp | null; recordedAt: Timestamp; generationId: QuixiId | null;
  editedFromMessageId: QuixiId | null; partCount: number; sealed: boolean;
}
export interface Cost { amount: string; currency: string }
export interface Generation {
  purpose?: "context_summary";
  id: QuixiId; threadId: QuixiId; parentMessageId: QuixiId; outputMessageId: QuixiId; contextSnapshotId: QuixiId;
  provider: string | null; providerAccountId: string | null; model: string | null; parameters: JsonObject;
  status: GenerationStatus; createdAt: Timestamp | null; recordedAt: Timestamp; completedAt: Timestamp | null;
  tokensIn: number | null; tokensOut: number | null; cachedTokens: number | null;
  estimatedCost: Cost | null; reportedCost: Cost | null;
  lastSequence: number; rawResponseId: QuixiId | null; compatibility: string[];
}
export interface TextBlob { sha256: string; byteLength: number; encoding: "utf-8" }
export type TextData = { text: string; textBlob?: never } | { text?: never; textBlob: TextBlob };
export const MAX_INLINE_TEXT_CHARS = 16_384;
interface PartBase { id: QuixiId; messageId: QuixiId; order: number }
export type ContentPart = PartBase & (
  | { kind: "Text"; data: TextData }
  | { kind: "Image" | "File" | "Audio"; data: { attachmentId: QuixiId; description: string | null } }
  | { kind: "Citation"; data: { url: string | null; label: string | null; sourcePartId: QuixiId | null } }
  | { kind: "ToolCall"; data: { name: string; input: JsonValue; providerCallId: string | null } }
  | { kind: "ToolResult"; data: { callPartId: QuixiId | null; unresolvedProviderCallId: string | null; content: JsonValue; isError: boolean } }
  | { kind: "ReasoningMetadata"; data: { redacted: boolean; summary: string | null } }
  | { kind: "StructuredData"; data: { value: JsonValue } }
  | { kind: "ProviderArtifact"; data: { providerKind: string; rawObjectId: QuixiId; locator: string } }
  | { kind: "Note"; data: TextData }
);
export type ThreadEventType = "ProviderSwitch" | "AutomaticFallback" | "ContextCompaction" | "ImportWarning" | "Migration" | "UserNote";
export interface ThreadEvent {
  id: QuixiId; threadId: QuixiId; type: ThreadEventType; createdAt: Timestamp | null; recordedAt: Timestamp;
  messageId: QuixiId | null; generationId: QuixiId | null; details: JsonObject;
}
export interface Attachment {
  id: QuixiId; availability: Availability; filename: string | null; mimeType: string | null; sizeBytes: number | null;
  blobSha256: string | null; rawObjectId: QuixiId | null;
}
/** Canonical document identity and user metadata; extraction/chunks are derived separately. */
export interface Document {
  id: QuixiId; workspaceId: QuixiId; attachmentId: QuixiId; title: string;
  createdAt: Timestamp | null; recordedAt: Timestamp; importSourceId: QuixiId | null;
}
export interface RawObject {
  id: QuixiId; availability: Availability; sha256: string | null; byteLength: number | null;
  mediaType: string; storageRef: string | null;
}
export interface ImportSource {
  id: QuixiId; provider: string; method: string; sourceThreadId: string | null; sourceUrl: string | null;
  importerName: string; importerVersion: string; sourceFormatVersion: string | null;
  sourceFingerprint: string | null; importedAt: Timestamp;
}
export type SourceEntityKind = "thread" | "message" | "generation" | "part" | "attachment" | "document" | "event";
export interface SourceIdentity {
  id: QuixiId; provider: string; accountScope: string; sourceThreadId: string | null; sourceContainerKey: string;
  entityKind: SourceEntityKind; nativeId: string; quixiId: QuixiId;
}
export interface Provenance {
  id: QuixiId; entityKind: SourceEntityKind; entityId: QuixiId; importSourceId: QuixiId;
  rawObjectId: QuixiId | null; locator: string | null; sourceCreatedAtText: string | null; compatibility: string[];
}
export interface Tombstone {
  id: QuixiId; threadId: QuixiId; rootMessageId: QuixiId | null;
  createdAt: Timestamp; reason: string | null;
}
/** A bounded logical graph snapshot, not an archive or a bulk-transfer envelope. */
export interface CanonicalHistory {
  summaryProposals?: SummaryProposal[];
  version: 1; threads: Thread[]; threadStates: ThreadState[]; contexts: ContextSnapshot[];
  messages: Message[]; generations: Generation[]; parts: ContentPart[]; events: ThreadEvent[];
  attachments: Attachment[]; documents: Document[]; rawObjects: RawObject[]; importSources: ImportSource[];
  sourceIdentities: SourceIdentity[]; provenance: Provenance[]; tombstones: Tombstone[];
}
/** Derived data: never required to validate or retain canonical conversation text. */
export interface SearchChunk {
  id: string; sourceType: "message" | "document" | "ocr" | "code" | "tool_output"; sourceId: string; partIds: QuixiId[];
  chunkIndex: number; text: string; contextPrefix: string; sourceDigest: string; chunkerVersion: string;
  tokenizerVersion: string | null; tokenStart: number | null; tokenEnd: number | null;
  embeddingModelId: string | null; embeddingStatus: "not_indexed" | "queued" | "indexing" | "ready" | "failed" | "stale";
}
export type EntityKind = SourceEntityKind | "summaryProposal" | "threadState" | "context" | "rawObject" | "importSource" | "sourceIdentity" | "provenance" | "tombstone";
export interface EntityReference { kind: EntityKind; id: QuixiId }
export type ValidationCode = "INVALID_VALUE" | "INVALID_ID" | "DUPLICATE_ID" | "MISSING_REFERENCE" | "CROSS_THREAD" | "CYCLE" | "GENERATION_LINK" | "PART_OWNERSHIP" | "EDIT_RELATIONSHIP" | "ACTIVE_PATH" | "TOOL_REFERENCE" | "ATTACHMENT_STATE" | "SOURCE_IDENTITY_CONFLICT" | "CONTEXT_VERSION" | "TOMBSTONE_CLOSURE" | "INVALID_TRANSITION" | "OUTPUT_SEQUENCE" | "SEALED_CONTENT";
export interface ValidationIssue { code: ValidationCode; path: string; message: string }
export class ModelValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ModelValidationError";
  }
}
