import { assertProducerArgs } from './producers.ts';
import { assertBlobInventoryArgs } from './blob-inventory.ts';
import type { BlobInventoryOperations } from './blob-inventory.ts';
import { assertDiagnosticsArgs } from './diagnostics.ts';
import { assertDoctorAuditArgs } from './doctor-audit.ts';
import { assertBlobHashAuditArgs } from './blob-hash-audit.ts';
import { assertPortabilityArgs } from './portability.ts';
import type { PortabilityOperations } from './portability.ts';
import type { BlobHashAuditOperations } from './blob-hash-audit.ts';
import type { DoctorAuditOperations } from './doctor-audit.ts';
import type { DiagnosticsOperations } from './diagnostics.ts';
import { assertPreferenceArgs } from './preferences.ts';
import { assertRoutingAliasArgs } from './routing-aliases.ts';
import type { RoutingAliasOperations } from './routing-aliases.ts';
import type { PreferenceOperations } from './preferences.ts';
import { assertExtractionArgs } from './extraction.ts';
import type { ExtractionOperations } from './extraction.ts';
import { assertArchiveActivationArgs } from './selection.ts';
import type { ArchiveSelectionOperations } from './selection.ts';
import type { ProducerOperations } from './producers.ts';
import { assertViewArgs } from './views.ts';
import type { ViewOperations } from './views.ts';
import { assertArchivesArgs } from './archives.ts';
import type { ArchivesOperations } from './archives.ts';
import { assertSearchArgs } from './search.ts';
import type { SearchOperations } from './search.ts';
import { assertImportWorkArgs } from './import-work.ts';
import type { ImportWorkOperations } from './import-work.ts';
import { assertNormalizedImportArgs } from './imports.ts';
import type { NormalizedImportOperations } from './imports.ts';
import { isJsonValue, isQuixiId } from "../model/validation.ts";
import type { Attachment, SummaryProposal, CanonicalHistory, ContentPart, ContextSnapshot, Document, EntityReference, Generation, ImportSource, JsonObject, JsonValue, Message, Provenance, QuixiId, RawObject, SourceIdentity, Thread, ThreadEvent, ThreadState, Tombstone } from "../model/types.ts";
import { MAX_PENDING_REQUESTS, MAX_TRANSFER_BYTES, validateImportBundle } from "./transfer.ts";
import { jsonByteLength } from "./serialization.ts";
import { previewMutation } from "./mutations.ts";
import type { BoundaryError, ByteChunk, CancellationResult, ChunkAcknowledgement, ImportBundle, Progress } from "./transfer.ts";

export interface MutationPayloads {
  RegisterSummaryProposal: { proposal: SummaryProposal };
  CreateThread: { thread: Thread; state: ThreadState; context: ContextSnapshot };
  CreateMessage: { message: Message; parts: ContentPart[] };
  EditMessage: { previousId: QuixiId; message: Message; parts: ContentPart[] };
  CreateGeneration: { generation: Generation; output: Message; parts: ContentPart[] };
  AppendGenerationOutput: { generationId: QuixiId; sequence: number; newParts: ContentPart[]; textAppend: { partId: QuixiId; text: string } | null };
  CompleteGeneration: { generationId: QuixiId; status: Exclude<Generation["status"],"streaming">; completedAt: number | null; tokensIn: number | null; tokensOut: number | null; cachedTokens: number | null; estimatedCost: Generation["estimatedCost"]; reportedCost: Generation["reportedCost"]; rawResponseId: QuixiId | null };
  CreateThreadEvent: { event: ThreadEvent };
  SetTitle: { threadId: QuixiId; value: string };
  SetTags: { threadId: QuixiId; value: string[] };
  SetPinned: { threadId: QuixiId; value: boolean };
  SetArchived: { threadId: QuixiId; value: boolean };
  SetActiveBranch: { threadId: QuixiId; value: QuixiId | null };
  SetRoutingProfile: { threadId: QuixiId; value: JsonObject | null };
  CreateContextSnapshot: { context: ContextSnapshot; select: boolean };
  RegisterRawObject: { rawObject: RawObject };
  RegisterImportSource: { source: ImportSource; rawObjects: RawObject[] };
  AttachProvenance: { provenance: Provenance[]; identities: SourceIdentity[] };
  RegisterAttachment: { attachment: Attachment };
  RegisterDocument: { document: Document };
  SetDocumentTitle: { documentId: QuixiId; value: string };
  AttachContent: { messageId: QuixiId; sequence: number; parts: ContentPart[] };
  ResolveAttachment: { attachmentId: QuixiId; blobSha256: string; sizeBytes: number; provenance: Provenance[] };
  TombstoneThread: { tombstone: Tombstone; state: ThreadState };
  TombstoneBranch: { tombstone: Tombstone; state: ThreadState };
}
export type MutationKind = keyof MutationPayloads;
export const MUTATION_KINDS = ["RegisterSummaryProposal","CreateThread","CreateMessage","EditMessage","CreateGeneration","AppendGenerationOutput","CompleteGeneration","CreateThreadEvent","SetTitle","SetTags","SetPinned","SetArchived","SetActiveBranch","SetRoutingProfile","CreateContextSnapshot","RegisterImportSource","RegisterRawObject","AttachProvenance","RegisterAttachment","RegisterDocument","SetDocumentTitle","AttachContent","ResolveAttachment","TombstoneThread","TombstoneBranch"] as const satisfies readonly MutationKind[];
/** ID is assigned before dispatch and MUST be reused after timeout/unknown outcome. */
export type CanonicalMutation = { [K in MutationKind]: { version: 1; operationId: QuixiId; kind: K; recordedAt: number; payload: MutationPayloads[K] } }[MutationKind];
export interface MutationBatch {
  transactionId: QuixiId; mutations: CanonicalMutation[];
  expectedThreadRevisions: { threadId: QuixiId; revision: number }[];
  stagedBlobIds: QuixiId[];
}
export interface CommitResult { transactionId: QuixiId; operations: { operationId: QuixiId; outcome: "committed" | "already_committed"; result: JsonValue }[] }
export interface SyncOperation { version: 1; operationId: QuixiId; kind: MutationKind | 'ImportRecord' | 'PublishImport'; recordedAt: number; payload: JsonValue; affects: EntityReference[] }

/** Exact local write coverage. Derived indexes and raw file I/O are excluded. */
export function mutationEffects(mutation: CanonicalMutation, history: CanonicalHistory): EntityReference[] {
  const ref = (kind: EntityReference["kind"], id: string): EntityReference => ({kind,id});
  const parts = (items: ContentPart[]) => items.map(part => ref("part",part.id));
  const provenance = (items: Provenance[]) => items.map(item=>ref("provenance",item.id));
  const output = (id: string): string => {
    const generation = history.generations.find(item=>item.id===id);
    if (!generation) throw new Error("Mutation requires an existing generation");
    return generation.outputMessageId;
  };
  switch (mutation.kind) {
    case "RegisterSummaryProposal": return [ref("summaryProposal",mutation.payload.proposal.id)];
    case "CreateThread": return [ref("thread",mutation.payload.thread.id),ref("threadState",mutation.payload.state.threadId),ref("context",mutation.payload.context.id)];
    case "CreateMessage": case "EditMessage": return [ref("message",mutation.payload.message.id),...parts(mutation.payload.parts)];
    case "CreateGeneration": return [ref("generation",mutation.payload.generation.id),ref("message",mutation.payload.output.id),...parts(mutation.payload.parts)];
    case "AppendGenerationOutput": return [ref("generation",mutation.payload.generationId),ref("message",output(mutation.payload.generationId)),...parts(mutation.payload.newParts),...(mutation.payload.textAppend ? [ref("part",mutation.payload.textAppend.partId)] : [])];
    case "CompleteGeneration": return [ref("generation",mutation.payload.generationId),ref("message",output(mutation.payload.generationId))];
    case "CreateThreadEvent": return [ref("event",mutation.payload.event.id)];
    case "SetTitle": case "SetTags": case "SetPinned": case "SetArchived": case "SetActiveBranch": case "SetRoutingProfile": return [ref("threadState",mutation.payload.threadId)];
    case "CreateContextSnapshot": return [ref("context",mutation.payload.context.id),...(mutation.payload.select ? [ref("threadState",mutation.payload.context.threadId)] : [])];
    case "RegisterRawObject": return [ref("rawObject",mutation.payload.rawObject.id)];
    case "RegisterImportSource": return [ref("importSource",mutation.payload.source.id),...mutation.payload.rawObjects.map(item=>ref("rawObject",item.id))];
    case "AttachProvenance": return [...provenance(mutation.payload.provenance),...mutation.payload.identities.map(item=>ref("sourceIdentity",item.id))];
    case "RegisterAttachment": return [ref("attachment",mutation.payload.attachment.id)];
    case "RegisterDocument": return [ref("document",mutation.payload.document.id)];
    case "SetDocumentTitle": return [ref("document",mutation.payload.documentId)];
    case "AttachContent": {
      const message = history.messages.find(item=>item.id===mutation.payload.messageId);
      if (!message?.generationId) throw new Error("Content attachment requires an unfinished generation output");
      return [ref("message",message.id),ref("generation",message.generationId),...parts(mutation.payload.parts)];
    }
    case "ResolveAttachment": return [ref("attachment",mutation.payload.attachmentId),...provenance(mutation.payload.provenance)];
    case "TombstoneThread": case "TombstoneBranch": return [ref("tombstone",mutation.payload.tombstone.id),ref("threadState",mutation.payload.state.threadId)];
  }
}

export function syncOperationFor(mutation: CanonicalMutation, history: CanonicalHistory): SyncOperation {
  if (!isQuixiId(mutation.operationId) || mutation.version !== 1 || !MUTATION_KINDS.includes(mutation.kind) || !Number.isSafeInteger(mutation.recordedAt) || mutation.recordedAt < 0 || !isJsonValue(mutation.payload)) throw new Error("Invalid canonical mutation envelope");
  const payload: unknown = mutation.payload;
  if (!isJsonValue(payload)) throw new Error("Mutation payload is not JSON");
  previewMutation(history,mutation);
  return {version:1,operationId:mutation.operationId,kind:mutation.kind,recordedAt:mutation.recordedAt,payload,affects:mutationEffects(mutation,history)};
}

/** Compare complete effects before committing, so canonical writes cannot silently omit sync. */
export function assertAtomicSyncCoverage(changes: EntityReference[], operations: SyncOperation[]): void {
  const expected = new Set(changes.map(item=>`${item.kind}:${item.id}`));
  const actual = new Set(operations.flatMap(operation=>operation.affects.map(item=>`${item.kind}:${item.id}`)));
  if (expected.size !== actual.size || [...expected].some(key=>!actual.has(key))) throw new Error("Canonical changes and atomic sync-op coverage disagree");
  if (new Set(operations.map(operation=>operation.operationId)).size !== operations.length) throw new Error("Duplicate operation ID in atomic commit");
}

/** Stable payload comparison for operation-ID idempotency; not an encryption/hash format. */
export function canonicalJson(value: JsonValue): string {
  if (!isJsonValue(value)) throw new Error("Value is not serializable JSON");
  const visit = (item: JsonValue): string => {
    if (Array.isArray(item)) return `[${item.map(visit).join(",")}]`;
    if (item && typeof item === "object") return `{${Object.keys(item).sort().map(key=>`${JSON.stringify(key)}:${visit(item[key]!)}`).join(",")}}`;
    return JSON.stringify(item);
  };
  return visit(value);
}
export function assertSameOperation(previous: SyncOperation, next: SyncOperation): void {
  if (previous.operationId !== next.operationId || previous.kind !== next.kind || previous.recordedAt !== next.recordedAt || canonicalJson(previous.payload) !== canonicalJson(next.payload)) throw new Error("Operation identity conflicts with previously committed payload");
}

export interface LocalSyncOperation extends SyncOperation { sequence: number }
export interface SyncOperationPage { items: LocalSyncOperation[]; nextCursor: string | null; bytes: number; lastSequence: number; highWaterSequence: number }
export interface PageBudget { maxItems: number; maxBytes: number; cursor: string | null }
export interface EntityPage { items: JsonValue[]; nextCursor: string | null; bytes: number }
export interface StorageOperations extends DiagnosticsOperations, DoctorAuditOperations, BlobHashAuditOperations, PortabilityOperations, NormalizedImportOperations, ImportWorkOperations, SearchOperations, ProducerOperations, ViewOperations, ArchivesOperations, ArchiveSelectionOperations, ExtractionOperations, PreferenceOperations, RoutingAliasOperations, BlobInventoryOperations {
  diagnostics: { args: null; result: {backend:'sqlite-wasm-opfs-sahpool';ownerId:string;schemaVersion:number;integrity:string;canonicalRecords:number;syncOperations:number;persisted:boolean|null;usage:number|null;quota:number|null} };
  commit: { args: MutationBatch; result: CommitResult };
  readEntities: { args: { threadId: QuixiId | null; collection: Exclude<keyof CanonicalHistory,"version">; page: PageBudget }; result: EntityPage };
  readSyncOperations: { args: { afterSequence: number; page: PageBudget }; result: SyncOperationPage };
  readMessageParts: { args: { messageId: QuixiId; page: PageBudget }; result: EntityPage };
  /** Committed identifies this control or mutation acknowledgment, not necessarily final import publication. */
  operationStatus: { args: { operationId: QuixiId }; result: { status: "not_found" | "committed"; result: JsonValue } };
  beginImport: { args: { operationId: QuixiId; bundle: ImportBundle }; result: { importId: QuixiId; transferIds: QuixiId[] } };
  search: { args: { query: string; mode: "lexical" | "hybrid"; page: PageBudget }; result: EntityPage };
  indexingStatus: { args: { sourceId: string | null }; result: { queued: number; ready: number; failed: number; enabled: boolean } };
  beginBlobTransfer: { args: { operationId: QuixiId; purpose: BlobPurpose; expectedBytes: number | null; expectedSha256: string | null }; result: { transferId: QuixiId; maxChunkBytes: number; maxInFlight: number } };
  finishBlobTransfer: { args: { operationId: QuixiId; transferId: QuixiId; expectedBytes: number; expectedSha256: string }; result: { transferId: QuixiId; sha256: string; byteLength: number; state: "verified_staged" } };
  /** Read/slice transfer IDs equal their requestId, so callers can release a
   * known resource even when its creation reply is lost. Never retry creation
   * with a new identity before releasing the original reservation. */
  sliceBlobTransfer: { args: {transferId:QuixiId;offset:number;byteLength:number}; result: {transferId:QuixiId;sha256:string;byteLength:number;range:{offset:number;byteLength:number}} };
  readBlobTransfer: { args: { sha256: string }; result: { transferId: QuixiId; sha256: string; byteLength: number } };
  discardBlobTransfer: { args: { transferId: QuixiId }; result: { discarded: boolean } };
}
export type BlobPurpose = "attachment" | "raw_source" | "archive" | "document" | "canonical_text";
export type StorageRequest = { [K in keyof StorageOperations]: { version: 1; requestId: QuixiId; operation: K; args: StorageOperations[K]["args"] } }[keyof StorageOperations];
export type StorageResponse = { version: 1; requestId: QuixiId; ok: true; result: JsonValue } | { version: 1; requestId: QuixiId; ok: false; error: BoundaryError };
export interface StorageClient {
  request<K extends keyof StorageOperations>(requestId: QuixiId, operation: K, args: StorageOperations[K]["args"]): Promise<StorageOperations[K]["result"]>;
  sendChunk(chunk: ByteChunk): Promise<ChunkAcknowledgement>;
  readChunk(transferId: QuixiId): Promise<ByteChunk>;
  acknowledgeChunk(ack: ChunkAcknowledgement): Promise<void>;
  cancel(requestId: QuixiId, operationId: QuixiId | null): Promise<CancellationResult>;
  onProgress(listener: (progress: Progress) => void): () => void;
  onChange(listener: (operationIds: QuixiId[]) => void): () => void;
  close(): Promise<void>;
}
export const STORAGE_BOUNDARIES = Object.freeze({ maxRequestBytes:MAX_TRANSFER_BYTES,maxResponseBytes:MAX_TRANSFER_BYTES,maxPendingRequests:MAX_PENDING_REQUESTS,maxBatchMutations:128,maxPageItems:1000 });

export function assertPageBudget(page: PageBudget): void {
  if (!page || !Number.isSafeInteger(page.maxItems) || page.maxItems < 1 || page.maxItems > STORAGE_BOUNDARIES.maxPageItems || !Number.isSafeInteger(page.maxBytes) || page.maxBytes < 1 || page.maxBytes > MAX_TRANSFER_BYTES || !(page.cursor === null || typeof page.cursor === "string")) throw new Error("Invalid bounded page request");
}
/** Envelope/size checks precede dispatch; model/command validation also runs in storage before SQL. */
export function assertStorageRequest(request: StorageRequest): void {
  if (!request || request.version !== 1 || !isQuixiId(request.requestId) || jsonByteLength(request) > MAX_TRANSFER_BYTES) throw new Error("Invalid or oversized storage request");
  switch (request.operation) {
    case 'beginBlobInventory': case 'advanceBlobInventory': case 'blobInventoryStatus': case 'readBlobInventoryFindings': case 'cancelBlobInventory': case 'deleteOrphanBlobs': assertBlobInventoryArgs(request.operation, request.args); break;
    case 'readLocalPreferences': case 'setSendKey': case 'setInteractionPreferences': case 'setOnboardingState': case 'setTheme': assertPreferenceArgs(request.operation, request.args); break;
    case 'readRoutingAliases': case 'putRoutingAlias': case 'removeRoutingAlias': assertRoutingAliasArgs(request.operation, request.args); break;
    case 'beginDocumentExtraction': case 'resumeDocumentExtraction': case 'beginExtractionPage': case 'stagePageText': case 'publishExtractionPage': case 'completeDocumentExtraction': case 'interruptDocumentExtraction': case 'getDocumentExtraction': case 'getExtractionOperation': case 'getPublishedExtractionPage': case 'readExtractedPageText': case 'readExtractedPageMap': case 'clearDocumentExtraction': case 'advanceExtractionPageIndex': assertExtractionArgs(request.operation, request.args); break;
    case 'listArchiveJobs': case 'beginArchiveExport': case 'advanceArchiveJob': case 'archiveJobStatus': case 'openArchiveExport': case 'beginArchiveRestore': case 'finishArchiveRestore': case 'cancelArchiveJob': case 'releaseArchiveJob': case 'prepareArchiveActivation': assertArchivesArgs(request.operation,request.args);break;
    case 'archiveWorkspace': case 'readSummarySourceInfo': case 'readThreadView': assertViewArgs(request.operation,request.args);break;
    case 'listLibrary': case 'readConversationWindow': case 'readMessageChildren': assertViewArgs(request.operation,request.args);assertPageBudget(request.args.page);if(request.args.page.maxItems>64)throw new Error('View page exceeds 64 items');break;
    case 'registerGenerationProducer': case 'releaseGenerationProducer': case 'reconcileGenerationProducers': assertProducerArgs(request.operation,request.args);break;
    case 'searchArchive': assertSearchArgs(request.operation,request.args);assertPageBudget(request.args.page);break;
    case 'searchStatus': case 'rebuildSearch': case 'advanceSearchIndex': case 'resolveDocumentSearchHit': case 'resolveConversationSearchHit': case 'semanticStatus': case 'enrollSemantic': case 'setSemanticState': case 'claimSemanticChunks': case 'publishSemanticVectors': case 'deleteSemanticIndex': assertSearchArgs(request.operation,request.args);break;
    case 'resolveSourceIdentity': case 'readEntity': case 'importRunBegin': case 'importRunStatus': case 'importRunSetState': case 'importAllocateIds': case 'importWorkStage': case 'importWorkSeal': case 'importWorkGroupStatus': case 'importWorkGet': case 'importWorkCheckpoint': case 'importWorkResolve': case 'importGroupFinish': assertImportWorkArgs(request.operation,request.args);break;
    case 'importRunList': case 'importWorkRead': case 'importRunReadGroups': assertImportWorkArgs(request.operation,request.args);assertPageBudget(request.args.page);if(request.args.page.maxItems>128)throw new Error('Import work page is too large');break;
    case 'diagnosticsReport': assertDiagnosticsArgs(request.operation, request.args); break;
    case 'beginBlobHashAudit': case 'advanceBlobHashAudit': case 'blobHashAuditStatus': case 'readBlobHashAuditFindings': case 'cancelBlobHashAudit': assertBlobHashAuditArgs(request.operation, request.args); break;
    case 'recordPortabilityAssessments': case 'portabilityCoverage': assertPortabilityArgs(request.operation, request.args); break;
    case 'beginDoctorAudit': case 'advanceDoctorAudit': case 'doctorAuditStatus': case 'readDoctorAuditFindings': case 'cancelDoctorAudit': assertDoctorAuditArgs(request.operation, request.args); break;
    case 'diagnostics': case 'readArchiveActivationContext': if(request.args!==null)throw new Error('Operation requires null args');break;
    case 'activateRestoredArchive': assertArchiveActivationArgs(request.args);break;
    case 'prepareImportBlobs': case 'beginNormalizedImport': case 'stageImportRecords': case 'validateImportStep': case 'finalizeNormalizedImport': case 'cancelNormalizedImport': case 'normalizedImportStatus': assertNormalizedImportArgs(request.operation,request.args);break;
    case 'readStagedImportRecords': assertNormalizedImportArgs(request.operation,request.args);assertPageBudget(request.args.page);break;
    case "commit": {
      const batch = request.args;
      if (!isQuixiId(batch.transactionId) || !Array.isArray(batch.mutations) || batch.mutations.length < 1 || batch.mutations.length > STORAGE_BOUNDARIES.maxBatchMutations || !Array.isArray(batch.expectedThreadRevisions) || !Array.isArray(batch.stagedBlobIds) || !batch.stagedBlobIds.every(isQuixiId) || new Set(batch.stagedBlobIds).size !== batch.stagedBlobIds.length || new Set(batch.expectedThreadRevisions.map(item=>item.threadId)).size !== batch.expectedThreadRevisions.length) throw new Error("Invalid canonical mutation batch");
      const seen = new Set<string>();
      for (const mutation of batch.mutations) {
        if (!mutation || !isQuixiId(mutation.operationId) || seen.has(mutation.operationId) || mutation.version !== 1 || !MUTATION_KINDS.includes(mutation.kind) || !Number.isSafeInteger(mutation.recordedAt) || mutation.recordedAt < 0 || !isJsonValue(mutation.payload)) throw new Error("Invalid or duplicate canonical mutation identity");
        seen.add(mutation.operationId);
      }
      for (const expected of batch.expectedThreadRevisions) if (!isQuixiId(expected.threadId) || !Number.isSafeInteger(expected.revision) || expected.revision < 0) throw new Error("Invalid optimistic thread revision");
      break;
    }
    case "readEntities": assertPageBudget(request.args.page); if ((request.args.threadId !== null && !isQuixiId(request.args.threadId)) || !["summaryProposals","threads","threadStates","contexts","messages","generations","parts","events","attachments","documents","rawObjects","importSources","sourceIdentities","provenance","tombstones"].includes(request.args.collection)) throw new Error("Invalid thread ID or canonical collection"); break;
    case "search": assertPageBudget(request.args.page); if (typeof request.args.query !== "string" || request.args.query.length > 16_384 || !["lexical","hybrid"].includes(request.args.mode)) throw new Error("Invalid search request"); break;
    case "readSyncOperations": assertPageBudget(request.args.page); if(!Number.isSafeInteger(request.args.afterSequence)||request.args.afterSequence<0)throw new Error("Invalid local sync sequence");break;
    case "readMessageParts": assertPageBudget(request.args.page); if(!isQuixiId(request.args.messageId))throw new Error("Invalid message ID");break;
    case "operationStatus": if (!isQuixiId(request.args.operationId)) throw new Error("Invalid operation ID"); break;
    case "beginImport": if (!isQuixiId(request.args.operationId) || !validateImportBundle(request.args.bundle)) throw new Error("Invalid import operation or bundle"); break;
    case "indexingStatus": if (!(request.args.sourceId === null || typeof request.args.sourceId === "string")) throw new Error("Invalid source ID"); break;
    case "beginBlobTransfer": {
      const args=request.args;
      if(!isQuixiId(args.operationId)||!["attachment","raw_source","archive","document","canonical_text"].includes(args.purpose)||!(args.expectedBytes===null||(Number.isSafeInteger(args.expectedBytes)&&args.expectedBytes>=0))||!(args.expectedSha256===null||/^[0-9a-f]{64}$/.test(args.expectedSha256)))throw new Error("Invalid blob transfer declaration");break;
    }
    case "finishBlobTransfer": {
      const args=request.args;if(!isQuixiId(args.operationId)||!isQuixiId(args.transferId)||!Number.isSafeInteger(args.expectedBytes)||args.expectedBytes<0||!/^[0-9a-f]{64}$/.test(args.expectedSha256))throw new Error("Invalid verified blob finalization");break;
    }
    case "sliceBlobTransfer": {
      const args=request.args;if(!isQuixiId(args.transferId)||!Number.isSafeInteger(args.offset)||args.offset<0||!Number.isSafeInteger(args.byteLength)||args.byteLength<0||!Number.isSafeInteger(args.offset+args.byteLength))throw new Error("Invalid blob range");break;
    }
    case "readBlobTransfer": if(!/^[0-9a-f]{64}$/.test(request.args.sha256))throw new Error("Invalid blob digest");break;
    case "discardBlobTransfer": if(!isQuixiId(request.args.transferId))throw new Error("Invalid transfer ID");break;
    default: throw new Error("Unknown storage operation");
  }
}

/** Validate a bounded reply envelope before correlation. Operation-specific results remain adapter-validated. */
export function assertStorageResponse(value: unknown, expectedRequestId: QuixiId): asserts value is StorageResponse {
  jsonByteLength(value,STORAGE_BOUNDARIES.maxResponseBytes);
  if (!value || typeof value !== "object") throw new Error("Invalid storage response");
  const response=value as StorageResponse;
  if (response.version!==1 || !isQuixiId(response.requestId) || response.requestId!==expectedRequestId || typeof response.ok!=="boolean") throw new Error("Mismatched storage response identity");
  if (response.ok) {
    if (!Object.hasOwn(response,"result")) throw new Error("Storage response lacks result");
  } else {
    const error=response.error;
    if (!error || !["INVALID_REQUEST","UNSUPPORTED","OVERLOADED","CLOSED","NOT_FOUND","CONFLICT","CANCELLED","UNKNOWN_OUTCOME","QUOTA_EXCEEDED","IO_ERROR","MIGRATION_FAILED","INTERNAL"].includes(error.code) || typeof error.message!=="string" || error.requestId!==expectedRequestId || !(error.operationId===null || isQuixiId(error.operationId)) || !["never","same_operation_id","after_user_action"].includes(error.retry) || !error.details || Array.isArray(error.details) || typeof error.details!=="object" || !Object.values(error.details).every(item=>item===null||["string","number","boolean"].includes(typeof item))) throw new Error("Invalid storage error");
  }
}
/** bytes measures the serialized items array; the enclosing reply also obeys maxResponseBytes. */
export function assertEntityPage(value: unknown, budget: PageBudget): asserts value is EntityPage {
  assertPageBudget(budget);
  jsonByteLength(value,STORAGE_BOUNDARIES.maxResponseBytes);
  if (!value || typeof value!=="object") throw new Error("Invalid entity page");
  const page=value as EntityPage;
  if (!Array.isArray(page.items) || page.items.length>budget.maxItems || !(page.nextCursor===null||typeof page.nextCursor==="string") || page.bytes!==jsonByteLength(page.items,budget.maxBytes)) throw new Error("Entity page violates requested budget");
}
