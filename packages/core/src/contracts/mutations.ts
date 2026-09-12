import { appendGenerationOutput, createMessageEdit, finalizeGeneration, planBranchTombstone, selectActiveBranch, resolveMessagePath } from "../model/branches.ts";
import { assertHistory, isJsonValue, isQuixiId } from "../model/validation.ts";
import type { CanonicalHistory, ThreadState } from "../model/types.ts";
import type { CanonicalMutation, MutationBatch } from "./storage.ts";

/** Pure transition preview. Storage remains responsible for SQL atomicity and idempotent replay. */
export function previewMutation(history: CanonicalHistory, mutation: CanonicalMutation): CanonicalHistory {
  assertHistory(history);
  if (!mutation || mutation.version !== 1 || !isQuixiId(mutation.operationId) || !Number.isSafeInteger(mutation.recordedAt) || mutation.recordedAt < 0 || !mutation.payload || !isJsonValue(mutation.payload)) throw new Error("Invalid canonical mutation envelope");
  const stateUpdate = (threadId: string, transform: (state: ThreadState) => ThreadState) => {
    if (!history.threadStates.some(state=>state.threadId===threadId)) throw new Error("Unknown thread state");
    return {...history,threadStates:history.threadStates.map(state=>state.threadId===threadId?{...transform(state),revision:state.revision+1}:state)};
  };
  let next: CanonicalHistory;
  switch (mutation.kind) {
    case "RegisterSummaryProposal": next={...history,summaryProposals:[...(history.summaryProposals ?? []),mutation.payload.proposal]};break;
    case "CreateThread": next = {...history,threads:[...history.threads,mutation.payload.thread],threadStates:[...history.threadStates,mutation.payload.state],contexts:[...history.contexts,mutation.payload.context]}; break;
    case "CreateMessage": {
      if (mutation.payload.message.editedFromMessageId !== null || mutation.payload.message.generationId !== null) throw new Error("Use EditMessage or CreateGeneration for linked output");
      if(history.tombstones.some(item=>item.threadId===mutation.payload.message.threadId&&item.rootMessageId===null))throw new Error("Thread is deleted");
      resolveMessagePath(history,mutation.payload.message.threadId,mutation.payload.message.parentId);
      next={...history,messages:[...history.messages,mutation.payload.message],parts:[...history.parts,...mutation.payload.parts]}; break;
    }
    case "EditMessage": {
      const {message,parts,previousId}=mutation.payload;
      next=createMessageEdit(history,previousId,message.id,parts,mutation.recordedAt);
      const projected=next.messages.at(-1)!;
      for (const key of Object.keys(projected) as (keyof typeof projected)[]) if (JSON.stringify(projected[key])!==JSON.stringify(message[key])) throw new Error(`EditMessage ${key} disagrees with immutable sibling construction`);
      break;
    }
    case "CreateGeneration": resolveMessagePath(history,mutation.payload.generation.threadId,mutation.payload.generation.parentMessageId); next={...history,generations:[...history.generations,mutation.payload.generation],messages:[...history.messages,mutation.payload.output],parts:[...history.parts,...mutation.payload.parts]}; break;
    case "AppendGenerationOutput": next=appendGenerationOutput(history,mutation.payload); break;
    case "CompleteGeneration": {
      const {generationId,status,completedAt,tokensIn,tokensOut,cachedTokens,estimatedCost,reportedCost,rawResponseId}=mutation.payload;
      const metadata={tokensIn,tokensOut,cachedTokens,estimatedCost,reportedCost,rawResponseId};
      next=finalizeGeneration(history,generationId,status,completedAt);
      next={...next,generations:next.generations.map(item=>item.id===generationId?{...item,...metadata}:item)};break;
    }
    case "CreateThreadEvent": next={...history,events:[...history.events,mutation.payload.event]};break;
    case "SetTitle": next=stateUpdate(mutation.payload.threadId,state=>({...state,title:mutation.payload.value}));break;
    case "SetTags": next=stateUpdate(mutation.payload.threadId,state=>({...state,tags:mutation.payload.value}));break;
    case "SetPinned": next=stateUpdate(mutation.payload.threadId,state=>({...state,pinned:mutation.payload.value}));break;
    case "SetArchived": next=stateUpdate(mutation.payload.threadId,state=>({...state,archived:mutation.payload.value}));break;
    case "SetActiveBranch": next=selectActiveBranch(history,mutation.payload.threadId,mutation.payload.value);break;
    case "SetRoutingProfile": next=stateUpdate(mutation.payload.threadId,state=>({...state,routingProfile:mutation.payload.value}));break;
    case "CreateContextSnapshot": {
      next=mutation.payload.select?stateUpdate(mutation.payload.context.threadId,state=>({...state,contextSnapshotId:mutation.payload.context.id})):history;
      next={...next,contexts:[...next.contexts,mutation.payload.context]};break;
    }
    case "RegisterRawObject": next={...history,rawObjects:[...history.rawObjects,mutation.payload.rawObject]};break;
    case "RegisterImportSource": next={...history,importSources:[...history.importSources,mutation.payload.source],rawObjects:[...history.rawObjects,...mutation.payload.rawObjects]};break;
    case "AttachProvenance": next={...history,provenance:[...history.provenance,...mutation.payload.provenance],sourceIdentities:[...history.sourceIdentities,...mutation.payload.identities]};break;
    case "RegisterAttachment": next={...history,attachments:[...history.attachments,mutation.payload.attachment]};break;
    case "RegisterDocument": next={...history,documents:[...history.documents,mutation.payload.document]};break;
    case "SetDocumentTitle": {
      if (!history.documents.some(item=>item.id===mutation.payload.documentId)) throw new Error("Unknown document");
      next={...history,documents:history.documents.map(item=>item.id===mutation.payload.documentId?{...item,title:mutation.payload.value}:item)};break;
    }
    case "AttachContent": {
      const message=history.messages.find(item=>item.id===mutation.payload.messageId);
      if (!message?.generationId || message.sealed) throw new Error("SEALED_CONTENT: New attachment parts require an edit of sealed history");
      next=appendGenerationOutput(history,{generationId:message.generationId,sequence:mutation.payload.sequence,newParts:mutation.payload.parts,textAppend:null});break;
    }
    case "ResolveAttachment": {
      const attachment=history.attachments.find(item=>item.id===mutation.payload.attachmentId);
      if (!attachment) throw new Error("Unknown attachment");
      if (attachment.availability==='available' && (attachment.blobSha256!==mutation.payload.blobSha256 || attachment.sizeBytes!==mutation.payload.sizeBytes)) throw new Error("Available attachment bytes are immutable; create a new logical reference for replacement");
      next={...history,attachments:history.attachments.map(item=>item.id===attachment.id?{...item,availability:"available",blobSha256:mutation.payload.blobSha256,sizeBytes:mutation.payload.sizeBytes}:item),provenance:[...history.provenance,...mutation.payload.provenance]};break;
    }
    case "TombstoneThread": case "TombstoneBranch": {
      const {tombstone,state}=mutation.payload;
      if ((mutation.kind==='TombstoneThread')!==(tombstone.rootMessageId===null)) throw new Error("Tombstone command and root scope disagree");
      const proposed=planBranchTombstone(history,tombstone.threadId,tombstone.rootMessageId,tombstone.id,tombstone.createdAt);
      for (const key of Object.keys(proposed.state) as (keyof ThreadState)[]) if(JSON.stringify(proposed.state[key])!==JSON.stringify(state[key])) throw new Error("Tombstone state update must only select the nearest retained ancestor");
      next={...history,tombstones:[...history.tombstones,tombstone],threadStates:history.threadStates.map(item=>item.threadId===state.threadId?state:item)};break;
    }
    default: throw new Error("Unknown canonical mutation");
  }
  assertHistory(next); return next;
}

export function previewMutationBatch(history: CanonicalHistory, batch: MutationBatch): CanonicalHistory {
  assertHistory(history);
  if (!batch || !isQuixiId(batch.transactionId) || !Array.isArray(batch.mutations) || batch.mutations.length<1 || batch.mutations.length>128 || !Array.isArray(batch.expectedThreadRevisions) || !Array.isArray(batch.stagedBlobIds) || !batch.stagedBlobIds.every(isQuixiId) || new Set(batch.stagedBlobIds).size !== batch.stagedBlobIds.length || new Set(batch.expectedThreadRevisions.map(item=>item.threadId)).size !== batch.expectedThreadRevisions.length) throw new Error("Invalid mutation batch");
  for (const expected of batch.expectedThreadRevisions) if(!isQuixiId(expected.threadId) || !Number.isSafeInteger(expected.revision) || expected.revision < 0 || history.threadStates.find(state=>state.threadId===expected.threadId)?.revision!==expected.revision) throw new Error("CONFLICT: Thread revision changed before commit");
  const operationIds=new Set<string>();
  let next=history;
  for(const mutation of batch.mutations){
    if(operationIds.has(mutation.operationId)) throw new Error("Duplicate operation ID in mutation batch");
    operationIds.add(mutation.operationId);next=previewMutation(next,mutation);
  }
  return next;
}
