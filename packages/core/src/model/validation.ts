import { SUMMARY_INSTRUCTION, summaryOutputText } from './summaries.ts';
import { assertAttachmentCompaction, contextSummary, isAttachmentPart } from './compaction.ts';
import { MAX_INLINE_TEXT_CHARS, ModelValidationError } from "./types.ts";
import type { CanonicalHistory, ContentPart, Message, EntityKind, GenerationStatus, JsonValue, SearchChunk, ValidationCode, ValidationIssue } from "./types.ts";

type Check = (value: unknown) => boolean;
const object: Check = value => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string: Check = value => typeof value === "string";
const nonempty: Check = value => typeof value === "string" && value.length > 0;
const integer: Check = value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const positive: Check = value => integer(value) && Number(value) > 0;
const boolean: Check = value => typeof value === "boolean";
const nullable = (check: Check): Check => value => value === null || check(value);
const choices = (...values: unknown[]): Check => value => values.includes(value);
const array = (check: Check): Check => value => Array.isArray(value) && value.every(check);
export const isQuixiId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const hash: Check = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const entityKinds = ["thread", "message", "generation", "part", "attachment", "document", "event"];
const status = choices("streaming", "complete", "stopped", "failed", "cancelled", "partial");
const availability = choices("available", "missing", "unavailable");

export function isJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 128) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (!Array.isArray(item) && !object(item)) return false;
    if (ancestors.has(item as object)) return false;
    ancestors.add(item as object);
    const valid = Object.values(item as object).every(child => visit(child, depth + 1));
    ancestors.delete(item as object);
    return valid;
  };
  return visit(value, 0);
}
function equalJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item,index)=>equalJson(item,right[index]));
  const a=left as Record<string,JsonValue>; const b=right as Record<string,JsonValue>;
  const keys=Object.keys(a); return keys.length===Object.keys(b).length && keys.every(key=>Object.hasOwn(b,key)&&equalJson(a[key],b[key]));
}
const jsonObject: Check = value => object(value) && isJsonValue(value);
const cost: Check = value => object(value) && typeof (value as { amount?: unknown }).amount === "string"
  && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test((value as { amount: string }).amount)
  && typeof (value as { currency?: unknown }).currency === "string"
  && /^[A-Z]{3}$/.test((value as { currency: string }).currency);

const schemas: Record<Exclude<keyof CanonicalHistory, "version">, Record<string, Check>> = {
  summaryProposals: { version: choices(1), id: isQuixiId, threadId: isQuixiId, recordedAt: integer, generationId: isQuixiId, sourceContextSnapshotId: isQuixiId, requestContextSnapshotId: isQuixiId, throughMessageId: isQuixiId, sourceLeafMessageId: isQuixiId, sourceThreadRevision: integer, baseSummaryProposalId: nullable(isQuixiId), baseSummaryContextId: nullable(isQuixiId), sourceMessageCount: value => positive(value) && Number(value) <= 2047, sourcePartCount: value => integer(value) && Number(value) <= 4096, sourceFingerprint: hash, inputRawObjectId: isQuixiId, inputSha256: hash, inputByteLength: value => positive(value) && Number(value) <= 4194304, promptTemplateVersion: choices(1) },
  threads: { id: isQuixiId, workspaceId: isQuixiId, createdAt: nullable(integer), recordedAt: integer, systemPrompt: nullable(string), preferredRoute: nullable(jsonObject), importSourceId: nullable(isQuixiId) },
  threadStates: { threadId: isQuixiId, title: string, tags: array(nonempty), pinned: boolean, archived: boolean, activeLeafMessageId: nullable(isQuixiId), contextSnapshotId: isQuixiId, routingProfile: nullable(jsonObject), revision: integer },
  contexts: { id: isQuixiId, threadId: isQuixiId, previousId: nullable(isQuixiId), version: positive, systemPrompt: nullable(string), preferredRoute: nullable(jsonObject), recordedAt: integer },
  messages: { id: isQuixiId, threadId: isQuixiId, parentId: nullable(isQuixiId), role: choices("system", "user", "assistant", "tool"), createdAt: nullable(integer), recordedAt: integer, generationId: nullable(isQuixiId), editedFromMessageId: nullable(isQuixiId), partCount: integer, sealed: boolean },
  generations: { id: isQuixiId, threadId: isQuixiId, parentMessageId: isQuixiId, outputMessageId: isQuixiId, contextSnapshotId: isQuixiId, provider: nullable(nonempty), providerAccountId: nullable(nonempty), model: nullable(nonempty), parameters: jsonObject, status, createdAt: nullable(integer), recordedAt: integer, completedAt: nullable(integer), tokensIn: nullable(integer), tokensOut: nullable(integer), cachedTokens: nullable(integer), estimatedCost: nullable(cost), reportedCost: nullable(cost), lastSequence: integer, rawResponseId: nullable(isQuixiId), compatibility: array(nonempty) },
  parts: { id: isQuixiId, messageId: isQuixiId, order: integer, kind: choices("Text", "Image", "File", "Audio", "Citation", "ToolCall", "ToolResult", "ReasoningMetadata", "StructuredData", "ProviderArtifact", "Note"), data: jsonObject },
  events: { id: isQuixiId, threadId: isQuixiId, type: choices("ProviderSwitch", "AutomaticFallback", "ContextCompaction", "ImportWarning", "Migration", "UserNote", "Compare", "Critique"), createdAt: nullable(integer), recordedAt: integer, messageId: nullable(isQuixiId), generationId: nullable(isQuixiId), details: jsonObject },
  attachments: { id: isQuixiId, availability, filename: nullable(string), mimeType: nullable(string), sizeBytes: nullable(integer), blobSha256: nullable(hash), rawObjectId: nullable(isQuixiId) },
  documents: { id: isQuixiId, workspaceId: isQuixiId, attachmentId: isQuixiId, title: string, createdAt: nullable(integer), recordedAt: integer, importSourceId: nullable(isQuixiId) },
  rawObjects: { id: isQuixiId, availability, sha256: nullable(hash), byteLength: nullable(integer), mediaType: nonempty, storageRef: nullable(nonempty) },
  importSources: { id: isQuixiId, provider: nonempty, method: nonempty, sourceThreadId: nullable(nonempty), sourceUrl: nullable(string), importerName: nonempty, importerVersion: nonempty, sourceFormatVersion: nullable(string), sourceFingerprint: nullable(string), importedAt: integer },
  sourceIdentities: { id: isQuixiId, provider: nonempty, accountScope: nonempty, sourceThreadId: nullable(nonempty), sourceContainerKey: nonempty, entityKind: choices(...entityKinds), nativeId: nonempty, quixiId: isQuixiId },
  provenance: { id: isQuixiId, entityKind: choices(...entityKinds), entityId: isQuixiId, importSourceId: isQuixiId, rawObjectId: nullable(isQuixiId), locator: nullable(string), sourceCreatedAtText: nullable(string), compatibility: array(nonempty) },
  tombstones: { id: isQuixiId, threadId: isQuixiId, rootMessageId: nullable(isQuixiId), createdAt: integer, reason: nullable(string) },
};
const partSchemas: Record<ContentPart["kind"], Record<string, Check>> = {
  Text: {}, Note: {},
  Image: { attachmentId: isQuixiId, description: nullable(string) }, File: { attachmentId: isQuixiId, description: nullable(string) }, Audio: { attachmentId: isQuixiId, description: nullable(string) },
  Citation: { url: nullable(string), label: nullable(string), sourcePartId: nullable(isQuixiId) },
  ToolCall: { name: nonempty, input: isJsonValue, providerCallId: nullable(string) },
  ToolResult: { callPartId: nullable(isQuixiId), unresolvedProviderCallId: nullable(nonempty), content: isJsonValue, isError: boolean },
  ReasoningMetadata: { redacted: boolean, summary: nullable(string) }, StructuredData: { value: isJsonValue },
  ProviderArtifact: { providerKind: nonempty, rawObjectId: isQuixiId, locator: string },
};

const textData: Check = value => {
  if(!object(value))return false;
  const data=value as Record<string,unknown>;
  if(Object.hasOwn(data,'text'))return !Object.hasOwn(data,'textBlob')&&typeof data.text==='string'&&data.text.length<=MAX_INLINE_TEXT_CHARS;
  if(!object(data.textBlob))return false;
  const blob=data.textBlob as Record<string,unknown>;
  return hash(blob.sha256)&&integer(blob.byteLength)&&blob.encoding==='utf-8';
};

/** Field-only validation for bounded repository records; referential checks remain mandatory. */
export function validateEntityShape(collection: Exclude<keyof CanonicalHistory,"version">, entry: unknown): ValidationIssue[] {
  const issues: ValidationIssue[]=[]; const path=`$.${collection}`;
  if (!Object.hasOwn(schemas,collection) || !object(entry) || !isJsonValue(entry)) return [{code:"INVALID_VALUE",path,message:"Expected a known collection and finite JSON object"}];
  const record=entry as Record<string,unknown>;
  if (collection === 'generations' && Object.hasOwn(record, 'purpose') && record.purpose !== 'context_summary') issues.push({code:'INVALID_VALUE',path:`${path}.purpose`,message:'Unknown generation purpose'});
  if (collection === 'summaryProposals' && Object.keys(record).some(key => !Object.hasOwn(schemas.summaryProposals,key))) issues.push({code:'INVALID_VALUE',path,message:'Unknown summary proposal field'});
  if (collection === 'contexts' && Object.hasOwn(record, 'compaction')) {
    try { assertAttachmentCompaction(record.compaction); }
    catch { issues.push({ code: 'INVALID_VALUE', path: `${path}.compaction`, message: 'Invalid context compaction policy' }); }
  }
  for(const [key,check] of Object.entries(schemas[collection]))if(!check(record[key]))issues.push({code:check===isQuixiId?"INVALID_ID":"INVALID_VALUE",path:`${path}.${key}`,message:`Invalid ${key}`});
  if(collection==='messages'&&Object.hasOwn(record,'partIds'))issues.push({code:'INVALID_VALUE',path,message:'Use bounded partCount and ordered part records, not an inline manifest'});
  if(collection==='tombstones'&&Object.hasOwn(record,'messageIds'))issues.push({code:'INVALID_VALUE',path,message:'Tombstones use root scope, not a materialized descendant list'});
  if(collection==='parts'){
    const part=entry as unknown as ContentPart;
    if((part.kind==='Text'||part.kind==='Note')&&!textData(part.data))issues.push({code:'INVALID_VALUE',path:`${path}.data`,message:'Text requires exactly one bounded inline value or UTF-8 blob reference'});
    if(Object.hasOwn(partSchemas,part.kind)&&object(part.data))for(const [key,check] of Object.entries(partSchemas[part.kind]))if(!check((part.data as unknown as Record<string,unknown>)[key]))issues.push({code:"INVALID_VALUE",path:`${path}.data.${key}`,message:`Invalid ${part.kind} ${key}`});
  }
  return issues;
}

/** Validate unknown data before any caller relies on its TypeScript shape. */
export function validateHistory(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (code: ValidationCode, path: string, message: string) => { issues.push({ code, path, message }); };
  if (!object(input) || !isJsonValue(input)) return [{ code: "INVALID_VALUE", path: "$", message: "History must be finite, acyclic JSON (maximum nesting 128)" }];
  const root = input as Record<string, unknown>;
  if (root.version !== 1) issue("INVALID_VALUE", "$.version", "Unsupported canonical model version");
  for (const collection of Object.keys(schemas) as (keyof typeof schemas)[]) {
    const entries=collection === "summaryProposals" && !Object.hasOwn(root, collection) ? [] : root[collection];
    if(!Array.isArray(entries)){issue('INVALID_VALUE',`$.${collection}`,'Expected an array');continue;}
    entries.forEach((entry,index)=>{for(const found of validateEntityShape(collection,entry))issues.push({...found,path:found.path.replace(`$.${collection}`,`$.${collection}[${index}]`)});});
  }
  if (issues.length) return issues;
  const history = input as unknown as CanonicalHistory;
  const maps = new Map<string, Map<string, { id?: string; threadId?: string }>>();
  const globalIds = new Set<string>();
  for (const name of Object.keys(schemas) as (keyof typeof schemas)[]) {
    const map = new Map<string, { id?: string; threadId?: string }>();
    (history[name] ?? []).forEach((entry, index) => {
      const id = "id" in entry ? entry.id : entry.threadId;
      if (map.has(id) || (name !== "threadStates" && globalIds.has(id))) issue("DUPLICATE_ID", `$.${name}[${index}]`, `Duplicate Quixi ID ${id}`);
      map.set(id, entry);
      if (name !== "threadStates") globalIds.add(id);
    });
    maps.set(name, map);
  }
  const reference = (collection: string, id: string | null, path: string, threadId?: string) => {
    if (id === null) return undefined;
    const target = maps.get(collection)?.get(id);
    if (!target) issue("MISSING_REFERENCE", path, `Missing ${collection} reference ${id}`);
    else if (threadId !== undefined && target.threadId !== threadId) issue("CROSS_THREAD", path, "Reference crosses thread boundaries");
    return target;
  };
  const messages = new Map(history.messages.map(message => [message.id, message]));
  const parts = new Map(history.parts.map(part => [part.id, part]));
  const ownedParts=new Map<string,ContentPart[]>();
  for(const part of history.parts){let items=ownedParts.get(part.messageId);if(!items){items=[];ownedParts.set(part.messageId,items);}items.push(part);}
  const generations = new Map(history.generations.map(generation => [generation.id, generation]));
  const contexts = new Map(history.contexts.map(context => [context.id, context]));
  const children = new Map<string, string[]>();
  for (const message of history.messages) {
    if (message.parentId) children.set(message.parentId, [...(children.get(message.parentId) ?? []), message.id]);
  }
  const descendants = (id: string): Set<string> => {
    const found = new Set<string>(); const pending = [id];
    while (pending.length) { const next = pending.pop()!; if (!found.has(next)) { found.add(next); pending.push(...children.get(next) ?? []); } }
    return found;
  };
  // Linear-time iterative parent walk; a long imported chain cannot overflow JS's stack.
  for (const relationship of ["parentId","editedFromMessageId"] as const) {
    const checked = new Set<string>();
    for (const message of history.messages) {
      const path = new Set<string>(); let next: string | null = message.id;
      while (next && !checked.has(next)) {
        if (path.has(next)) { issue(relationship === "parentId" ? "CYCLE" : "EDIT_RELATIONSHIP", `$.messages.${message.id}.${relationship}`, "Message relationship contains a cycle"); break; }
        path.add(next); next = messages.get(next)?.[relationship] ?? null;
      }
      for (const id of path) checked.add(id);
    }
  }
  const isAncestor = (ancestor: string, child: string) => {
    const seen = new Set<string>(); let next = messages.get(child)?.parentId;
    while (next && !seen.has(next)) { if (next === ancestor) return true; seen.add(next); next = messages.get(next)?.parentId; }
    return false;
  };
  const collectionForKind: Record<EntityKind, string> = {summaryProposal:"summaryProposals", thread: "threads", message: "messages", generation: "generations", part: "parts", attachment: "attachments", document: "documents", event: "events", threadState: "threadStates", context: "contexts", rawObject: "rawObjects", importSource: "importSources", sourceIdentity: "sourceIdentities", provenance: "provenance", tombstone: "tombstones" };
  for (const [index, proposal] of (history.summaryProposals ?? []).entries()) {
    const path = `$.summaryProposals[${index}]`;
    reference('threads',proposal.threadId,`${path}.threadId`);
    for (const key of ['sourceContextSnapshotId','requestContextSnapshotId'] as const) reference('contexts',proposal[key],`${path}.${key}`,proposal.threadId);
    for (const key of ['throughMessageId','sourceLeafMessageId'] as const) reference('messages',proposal[key],`${path}.${key}`,proposal.threadId);
    reference('generations',proposal.generationId,`${path}.generationId`,proposal.threadId);
    reference('rawObjects',proposal.inputRawObjectId,`${path}.inputRawObjectId`);
    reference('summaryProposals',proposal.baseSummaryProposalId,`${path}.baseSummaryProposalId`,proposal.threadId);
    reference('contexts',proposal.baseSummaryContextId,`${path}.baseSummaryContextId`,proposal.threadId);
    const generation=generations.get(proposal.generationId), input=history.rawObjects.find(raw=>raw.id===proposal.inputRawObjectId);
    const source=contexts.get(proposal.sourceContextSnapshotId), request=contexts.get(proposal.requestContextSnapshotId), base=source?contextSummary(source):null;
    if (!generation || generation.purpose!=='context_summary' || generation.parentMessageId!==proposal.throughMessageId || generation.contextSnapshotId!==proposal.requestContextSnapshotId || request?.systemPrompt!==SUMMARY_INSTRUCTION || proposal.sourceContextSnapshotId===proposal.requestContextSnapshotId || !input || input.mediaType!=='application/vnd.quixi.summary-input+json' || input.availability!=='available' || input.sha256!==proposal.inputSha256 || input.byteLength!==proposal.inputByteLength || proposal.baseSummaryProposalId!==(base?.proposalId??null) || proposal.baseSummaryContextId!==(base?source!.id:null)) issue('INVALID_VALUE',path,'Summary proposal provenance differs from its source, attempt or frozen input');
    let cursor:string|null=proposal.sourceLeafMessageId,next:Message|undefined;const tail=new Set<string>();
    while(cursor&&cursor!==proposal.throughMessageId&&!tail.has(cursor)&&tail.size<2047){tail.add(cursor);next=messages.get(cursor);if(!next?.sealed)break;cursor=next.parentId;}
    if(cursor!==proposal.throughMessageId||next?.role!=='user')issue('INVALID_VALUE',path,'Summary cutoff must precede a retained user turn on the selected branch');
    if ((history.summaryProposals ?? []).filter(value=>value.generationId===proposal.generationId).length!==1) issue('DUPLICATE_ID',path,'A summary generation has one proposal');
  }
  history.threads.forEach((thread, index) => {
    reference("threadStates", thread.id, `$.threads[${index}].state`);
    reference("importSources", thread.importSourceId, `$.threads[${index}].importSourceId`);
    const initialContexts = history.contexts.filter(context => context.threadId === thread.id && context.version === 1);
    if (initialContexts.length !== 1 || initialContexts[0]?.systemPrompt !== thread.systemPrompt || !equalJson(initialContexts[0]?.preferredRoute,thread.preferredRoute)) issue("CONTEXT_VERSION", `$.threads[${index}]`, "Thread must retain exactly one matching initial context");
  });
  history.contexts.forEach((context, index) => {
    const path = `$.contexts[${index}]`; reference("threads", context.threadId, `${path}.threadId`);
    const summary=contextSummary(context);
    if(summary){
      reference('summaryProposals',summary.proposalId,`${path}.compaction.summary.proposalId`,context.threadId);
      reference('messages',summary.throughMessageId,`${path}.compaction.summary.throughMessageId`,context.threadId);
      const proposal=(history.summaryProposals??[]).find(value=>value.id===summary.proposalId), generation=proposal?generations.get(proposal.generationId):null;
      if(!proposal||proposal.throughMessageId!==summary.throughMessageId||generation?.status!=='complete'||!messages.get(generation.outputMessageId)?.sealed)issue('INVALID_VALUE',path,'Only a complete sealed summary proposal may be applied');
      else try { summaryOutputText(generation,messages.get(generation.outputMessageId)!,history.parts.filter(part=>part.messageId===generation.outputMessageId).sort((a,b)=>a.order-b.order)); } catch(error) { issue('INVALID_VALUE',path,String(error)); }
    }
    if (context.compaction) for (const partId of context.compaction.excludedPartIds) {
      const part = parts.get(partId);
      if (!part || !isAttachmentPart(part) || messages.get(part.messageId)?.threadId !== context.threadId)
        issue('INVALID_VALUE', `${path}.compaction`, 'Exclusions must reference attachment parts in this thread');
    }
    reference("contexts", context.previousId, `${path}.previousId`, context.threadId);
    if ((context.version === 1 && context.previousId !== null) || (context.version > 1 && contexts.get(context.previousId ?? "")?.version !== context.version - 1)) issue("CONTEXT_VERSION", path, "Context version must extend its previous immutable snapshot");
  });
  const hidden = new Set<string>(); const hiddenThreads = new Set<string>();
  history.tombstones.forEach((tombstone, index) => {
    const path = `$.tombstones[${index}]`; reference("threads", tombstone.threadId, `${path}.threadId`);
    reference("messages", tombstone.rootMessageId, `${path}.rootMessageId`, tombstone.threadId);
    const expected = tombstone.rootMessageId ? descendants(tombstone.rootMessageId) : new Set(history.messages.filter(message => message.threadId === tombstone.threadId).map(message => message.id));
    for (const id of expected) hidden.add(id);
    if (tombstone.rootMessageId === null) hiddenThreads.add(tombstone.threadId);
  });
  history.threadStates.forEach((state, index) => {
    const path = `$.threadStates[${index}]`; reference("threads", state.threadId, `${path}.threadId`);
    reference("contexts", state.contextSnapshotId, `${path}.contextSnapshotId`, state.threadId);
    const active=messages.get(state.activeLeafMessageId??'');
    if(active?.generationId&&generations.get(active.generationId)?.purpose)issue('ACTIVE_PATH',path,'Summary proposals cannot be selected as chat answers');
    reference("messages", state.activeLeafMessageId, `${path}.activeLeafMessageId`, state.threadId);
    if (state.activeLeafMessageId && (hidden.has(state.activeLeafMessageId) || hiddenThreads.has(state.threadId))) issue("ACTIVE_PATH", `${path}.activeLeafMessageId`, "Active selection cannot point to deleted history");
    if (new Set(state.tags).size !== state.tags.length) issue("INVALID_VALUE", `${path}.tags`, "Tags must be unique");
  });
  history.messages.forEach((message, index) => {
    const path = `$.messages[${index}]`; reference("threads", message.threadId, `${path}.threadId`);
    reference("messages", message.parentId, `${path}.parentId`, message.threadId);
    reference("messages", message.editedFromMessageId, `${path}.editedFromMessageId`, message.threadId);
    if (message.editedFromMessageId) {
      const previous = messages.get(message.editedFromMessageId);
      if (previous && (previous.id === message.id || previous.parentId !== message.parentId || previous.role !== message.role || !previous.sealed || message.generationId !== null)) issue("EDIT_RELATIONSHIP", path, "An edit is a fresh same-role sibling of sealed history, not a model-generated output");
    }
    const generation = message.generationId ? generations.get(message.generationId) : undefined;
    reference("generations", message.generationId, `${path}.generationId`, message.threadId);
    const parent=messages.get(message.parentId??'');
    if(parent?.generationId&&generations.get(parent.generationId)?.purpose)issue('ACTIVE_PATH',path,'Summary outputs cannot be continued as chat');
    if (generation && (message.role !== "assistant" || generation.outputMessageId !== message.id || generation.parentMessageId !== message.parentId)) issue("GENERATION_LINK", path, "Generation/output backlink or parent disagrees");
    if (!message.sealed && !generation) issue("SEALED_CONTENT", path, "Only an active generation output may be unsealed");
    const owned=ownedParts.get(message.id)??[];
    const orders=new Set(owned.map(part=>part.order));
    if(owned.length!==message.partCount||orders.size!==owned.length||owned.some(part=>part.order>=message.partCount))issue('PART_OWNERSHIP',path,'Part count and consecutive unique order must match the owning message');
  });
  history.generations.forEach((generation, index) => {
    const path = `$.generations[${index}]`; reference("threads", generation.threadId, `${path}.threadId`);
    reference("messages", generation.parentMessageId, `${path}.parentMessageId`, generation.threadId);
    reference("messages", generation.outputMessageId, `${path}.outputMessageId`, generation.threadId);
    reference("contexts", generation.contextSnapshotId, `${path}.contextSnapshotId`, generation.threadId);
    reference("rawObjects", generation.rawResponseId, `${path}.rawResponseId`);
    const output = messages.get(generation.outputMessageId);
    if (messages.get(generation.parentMessageId)?.sealed === false) issue("SEALED_CONTENT", `${path}.parentMessageId`, "An attempt must anchor to stable completed history");
    if (output && (output.generationId !== generation.id || output.role !== "assistant" || output.parentId !== generation.parentMessageId)) issue("GENERATION_LINK", path, "Generation must own exactly its reserved assistant output");
    if (output && output.sealed !== (generation.status !== "streaming")) issue("SEALED_CONTENT", path, "Streaming outputs are unsealed; terminal outputs are sealed");
    if (generation.status === "streaming" && generation.completedAt !== null) issue("INVALID_VALUE", `${path}.completedAt`, "Streaming attempts cannot have completion time");
    if (generation.createdAt !== null && generation.completedAt !== null && generation.completedAt < generation.createdAt) issue("INVALID_VALUE", `${path}.completedAt`, "Completion precedes attempt creation");
  });
  history.documents.forEach((document,index)=>{
    reference("attachments",document.attachmentId,`$.documents[${index}].attachmentId`);
    reference("importSources",document.importSourceId,`$.documents[${index}].importSourceId`);
  });
  history.parts.forEach((part, index) => {
    const path = `$.parts[${index}]`; reference("messages", part.messageId, `${path}.messageId`);
    if (!messages.has(part.messageId) || part.order >= messages.get(part.messageId)!.partCount) issue("PART_OWNERSHIP", path, "Part is not projected once by its owning message");
    if (part.kind === "File" || part.kind === "Image" || part.kind === "Audio") reference("attachments", part.data.attachmentId, `${path}.data.attachmentId`);
    if (part.kind === "ProviderArtifact") reference("rawObjects", part.data.rawObjectId, `${path}.data.rawObjectId`);
    if (part.kind === "Citation") reference("parts", part.data.sourcePartId, `${path}.data.sourcePartId`);
    if (part.kind === "ToolResult") {
      reference("parts", part.data.callPartId, `${path}.data.callPartId`);
      const call = parts.get(part.data.callPartId ?? "");
      if ((!part.data.callPartId && !part.data.unresolvedProviderCallId) || (part.data.callPartId && part.data.unresolvedProviderCallId)) issue("TOOL_REFERENCE", path, "Tool result must have one resolved or explicit unresolved call reference");
      if (call && (call.kind !== "ToolCall" || !(call.messageId === part.messageId ? call.order < part.order : isAncestor(call.messageId, part.messageId)))) issue("TOOL_REFERENCE", path, "Tool call must precede its result in this message or an ancestor");
    }
  });
  history.attachments.forEach((attachment, index) => {
    const path = `$.attachments[${index}]`;
    reference("rawObjects", attachment.rawObjectId, `${path}.rawObjectId`);
    if ((attachment.availability === "available") !== (attachment.blobSha256 !== null) || (attachment.availability === "available" && attachment.sizeBytes === null)) issue("ATTACHMENT_STATE", path, "Available bytes require verified SHA256 and size; missing/unavailable bytes have no verified blob reference");
  });
  history.rawObjects.forEach((raw, index) => {
    if ((raw.availability === "available" && (raw.sha256 === null || raw.byteLength === null || raw.storageRef === null)) || (raw.availability !== "available" && raw.storageRef !== null)) issue("ATTACHMENT_STATE", `$.rawObjects[${index}]`, "Retained raw bytes require verified hash, size, and reference; unavailable bytes have no local reference");
  });
  history.events.forEach((event, index) => {
    const path = `$.events[${index}]`; reference("threads", event.threadId, `${path}.threadId`);
    reference("messages", event.messageId, `${path}.messageId`, event.threadId);
    reference("generations", event.generationId, `${path}.generationId`, event.threadId);
  });
  const nativeKeys = new Map<string, string>();
  history.sourceIdentities.forEach((identity, index) => {
    reference(collectionForKind[identity.entityKind], identity.quixiId, `$.sourceIdentities[${index}].quixiId`);
    const key = JSON.stringify([identity.provider, identity.accountScope, identity.sourceThreadId, identity.sourceContainerKey, identity.entityKind, identity.nativeId]);
    if (nativeKeys.has(key)) issue("SOURCE_IDENTITY_CONFLICT", `$.sourceIdentities[${index}]`, "Scoped provider identity must resolve to exactly one canonical mapping");
    nativeKeys.set(key, identity.quixiId);
  });
  history.provenance.forEach((observation, index) => {
    const path = `$.provenance[${index}]`; reference(collectionForKind[observation.entityKind], observation.entityId, `${path}.entityId`);
    reference("importSources", observation.importSourceId, `${path}.importSourceId`);
    reference("rawObjects", observation.rawObjectId, `${path}.rawObjectId`);
    if (observation.locator !== null && observation.rawObjectId === null) issue("MISSING_REFERENCE", `${path}.locator`, "A raw entry locator requires a raw-object reference");
  });
  return issues;
}

export function assertHistory(input: unknown): asserts input is CanonicalHistory {
  const issues = validateHistory(input);
  if (issues.length) throw new ModelValidationError(issues);
}

export function assertGenerationTransition(from: GenerationStatus, to: GenerationStatus): void {
  if (!status(from) || !status(to) || from !== "streaming" || to === "streaming") throw new ModelValidationError([{ code: "INVALID_TRANSITION", path: "$.status", message: "Only a streaming attempt can transition once to a terminal state" }]);
}

export function validateSearchChunk(input: unknown): ValidationIssue[] {
  if (!object(input) || !isJsonValue(input)) return [{code:"INVALID_VALUE",path:"$",message:"Chunk must be serializable JSON"}];
  const value = input as unknown as SearchChunk;
  const shape: Record<string, Check> = {
    id: nonempty, sourceType: choices("message", "document", "ocr", "code", "tool_output"), sourceId: nonempty, partIds: array(isQuixiId),
    chunkIndex: integer, text: string, contextPrefix: string, sourceDigest: hash, chunkerVersion: nonempty, tokenizerVersion: nullable(nonempty),
    tokenStart: nullable(integer), tokenEnd: nullable(integer), embeddingModelId: nullable(nonempty), embeddingStatus: choices("not_indexed", "queued", "indexing", "ready", "failed", "stale"),
  };
  const issues: ValidationIssue[] = Object.entries(shape).filter(([key, check]) => !check((input as Record<string, unknown>)[key])).map(([key]) => ({code:"INVALID_VALUE",path:`$.${key}`,message:`Invalid ${key}`}));
  if ((value.tokenStart === null) !== (value.tokenEnd === null) || (value.tokenStart !== null && value.tokenEnd !== null && value.tokenEnd < value.tokenStart)) issues.push({code:"INVALID_VALUE",path:"$.tokenEnd",message:"Token ranges must be paired and ordered"});
  if (value.embeddingStatus === "ready" && value.embeddingModelId === null) issues.push({code:"INVALID_VALUE",path:"$.embeddingModelId",message:"A ready embedding requires its model identity"});
  return issues;
}
