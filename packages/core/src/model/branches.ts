import { MAX_INLINE_TEXT_CHARS, ModelValidationError } from "./types.ts";
import { assertGenerationTransition, assertHistory } from "./validation.ts";
import { isInternalProvenancePart } from './provenance.ts';
import type { CanonicalHistory, ContentPart, Generation, GenerationStatus, Message, QuixiId, ThreadState, Tombstone } from "./types.ts";

function invalid(code: "ACTIVE_PATH" | "MISSING_REFERENCE" | "CYCLE" | "CROSS_THREAD" | "SEALED_CONTENT" | "OUTPUT_SEQUENCE", message: string): never {
  throw new ModelValidationError([{code,path:"$",message}]);
}

/** Ordered root-to-selection messages. Selection is a display leaf, not a global-tree leaf. */
export function resolveMessagePath(history: CanonicalHistory, threadId: QuixiId, leafId: QuixiId | null): Message[] {
  if (!history.threads.some(thread => thread.id === threadId)) invalid("MISSING_REFERENCE", "Unknown thread");
  if (leafId === null) return [];
  const messages = new Map(history.messages.map(message => [message.id, message]));
  const hidden = new Set(history.tombstones.flatMap(tombstone => tombstone.rootMessageId?[tombstone.rootMessageId]:[]));
  if (history.tombstones.some(tombstone => tombstone.threadId === threadId && tombstone.rootMessageId === null)) invalid("ACTIVE_PATH", "Thread is deleted");
  const path: Message[] = []; const visited = new Set<string>(); let id: string | null = leafId;
  while (id !== null) {
    if (visited.has(id)) invalid("CYCLE", "Selected path contains a cycle");
    visited.add(id);
    const message = messages.get(id);
    if (!message) invalid("MISSING_REFERENCE", "Selected path has a missing message");
    if (message.threadId !== threadId) invalid("CROSS_THREAD", "Selected path crosses threads");
    if (hidden.has(id)) invalid("ACTIVE_PATH", "Selected path includes deleted history");
    path.push(message); id = message.parentId;
  }
  return path.reverse();
}

export function activeMessagePath(history: CanonicalHistory, threadId: QuixiId): Message[] {
  const state = history.threadStates.find(state => state.threadId === threadId);
  if (!state) invalid("MISSING_REFERENCE", "Thread state is missing");
  return resolveMessagePath(history, threadId, state.activeLeafMessageId);
}

export function generationCandidates(history: CanonicalHistory, parentMessageId: QuixiId): Generation[] {
  if (!history.messages.some(message => message.id === parentMessageId)) invalid("MISSING_REFERENCE", "Generation parent is missing");
  // Stable ID order is a presentation tie-breaker, never evidence of source chronology.
  return history.generations.filter(generation => generation.parentMessageId === parentMessageId && !generation.purpose).sort((a,b) => a.id.localeCompare(b.id));
}

export function selectActiveBranch(history: CanonicalHistory, threadId: QuixiId, leafId: QuixiId | null): CanonicalHistory {
  assertHistory(history);
  resolveMessagePath(history, threadId, leafId);
  const updated = { ...history, threadStates: history.threadStates.map(state => state.threadId === threadId ? { ...state, activeLeafMessageId: leafId, revision: state.revision + 1 } : state) };
  assertHistory(updated); return updated;
}

/** Caller supplies fresh IDs and replacement parts; original records and descendants remain unchanged. */
export function createMessageEdit(history: CanonicalHistory, previousId: QuixiId, id: QuixiId, parts: ContentPart[], recordedAt: number): CanonicalHistory {
  assertHistory(history);
  const previous = history.messages.find(message => message.id === previousId);
  if (!previous) invalid("MISSING_REFERENCE", "Message to edit is missing");
  if (!previous.sealed) invalid("SEALED_CONTENT", "Finish or stop the streaming attempt before editing");
  resolveMessagePath(history,previous.threadId,previous.id);
  const message: Message = {
    id, threadId: previous.threadId, parentId: previous.parentId, role: previous.role,
    createdAt: recordedAt, recordedAt, generationId: null, editedFromMessageId: previousId,
    partCount: parts.length, sealed: true,
  };
  const updated = { ...history, messages: [...history.messages, message], parts: [...history.parts, ...parts] };
  assertHistory(updated); return updated;
}

export interface GenerationAppend {
  generationId: QuixiId; sequence: number;
  newParts: ContentPart[]; textAppend: { partId: QuixiId; text: string } | null;
}

/** Durable checkpoint preview. Storage must commit this change and its sync op atomically. */
export function appendGenerationOutput(history: CanonicalHistory, append: GenerationAppend): CanonicalHistory {
  assertHistory(history);
  const generation = history.generations.find(generation => generation.id === append.generationId);
  if (!generation) invalid("MISSING_REFERENCE", "Generation is missing");
  if (generation.status !== "streaming") invalid("SEALED_CONTENT", "Terminal generation output cannot be appended");
  if (!Number.isSafeInteger(append.sequence) || append.sequence !== generation.lastSequence + 1) invalid("OUTPUT_SEQUENCE", "Checkpoint sequence must advance by exactly one");
  const output = history.messages.find(message => message.id === generation.outputMessageId)!;
  resolveMessagePath(history,output.threadId,output.id);
  if (append.textAppend) {
    const part = history.parts.find(part => part.id === append.textAppend!.partId);
    if (!part || part.messageId !== output.id || part.kind !== "Text" || typeof part.data.text !== "string" || typeof append.textAppend.text !== "string" || history.parts.some(later => later.messageId === output.id && later.order > part.order && !isInternalProvenancePart(later))) invalid("SEALED_CONTENT", "Text append must extend the last unfinished semantic part");
  }
  if (append.newParts.some(part => part.messageId !== output.id)) invalid("CROSS_THREAD", "New output parts must belong to the reserved output message");
  const updated: CanonicalHistory = {
    ...history,
    messages: history.messages.map(message => message.id === output.id ? { ...message, partCount: message.partCount+append.newParts.length } : message),
    generations: history.generations.map(item => item.id === generation.id ? {...item,lastSequence:append.sequence} : item),
    parts: [...history.parts.map(part => part.kind === "Text" && typeof part.data.text === "string" && part.id === append.textAppend?.partId ? {...part,data:{text:part.data.text + append.textAppend.text}} : part), ...append.newParts],
  };
  assertHistory(updated); return updated;
}

export function finalizeGeneration(history: CanonicalHistory, id: QuixiId, status: Exclude<GenerationStatus,"streaming">, completedAt: number | null): CanonicalHistory {
  assertHistory(history);
  const generation = history.generations.find(generation => generation.id === id);
  if (!generation) invalid("MISSING_REFERENCE", "Generation is missing");
  assertGenerationTransition(generation.status, status);
  const updated: CanonicalHistory = {
    ...history,
    generations: history.generations.map(item => item.id === id ? {...item,status,completedAt} : item),
    messages: history.messages.map(message => message.id === generation.outputMessageId ? {...message,sealed:true} : message),
  };
  assertHistory(updated); return updated;
}

export function planBranchTombstone(history: CanonicalHistory, threadId: QuixiId, rootId: QuixiId | null, id: QuixiId, createdAt: number): { tombstone: Tombstone; state: ThreadState } {
  assertHistory(history);
  const state = history.threadStates.find(state => state.threadId === threadId);
  if (!state) invalid("MISSING_REFERENCE", "Thread is missing");
  const root = rootId ? history.messages.find(message => message.id === rootId && message.threadId === threadId) : undefined;
  if (rootId && !root) invalid("MISSING_REFERENCE", "Branch root is missing from this thread");
  const ids = new Set(rootId ? [rootId] : history.messages.filter(message => message.threadId === threadId).map(message => message.id));
  const children = new Map<string, string[]>();
  for (const message of history.messages) if (message.parentId) children.set(message.parentId, [...children.get(message.parentId) ?? [],message.id]);
  const pending = [...ids];
  while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!ids.has(child)) {ids.add(child);pending.push(child);}
  const selected = state.activeLeafMessageId;
  const nextState = {...state, activeLeafMessageId: rootId === null ? null : selected && ids.has(selected) ? root!.parentId : selected, revision:state.revision+1};
  const tombstone: Tombstone = {id,threadId,rootMessageId:rootId,createdAt,reason:null};
  assertHistory({...history,tombstones:[...history.tombstones,tombstone],threadStates:history.threadStates.map(item=>item.threadId===threadId?nextState:item)});
  return {tombstone,state:nextState};
}

/** Bounded inline segments for streaming adapters. Allocate IDs once before dispatch and retain them on retry. */
export function* inlineTextSegments(messageId:QuixiId,startOrder:number,text:string,nextId:()=>QuixiId):Generator<ContentPart> {
  if(!Number.isSafeInteger(startOrder)||startOrder<0)invalid('OUTPUT_SEQUENCE','Invalid starting part order');
  let offset=0,order=startOrder;
  while(offset<text.length){
    let end=Math.min(offset+MAX_INLINE_TEXT_CHARS,text.length);
    const last=text.charCodeAt(end-1),next=text.charCodeAt(end);
    if(end<text.length&&last>=0xd800&&last<=0xdbff&&next>=0xdc00&&next<=0xdfff)end--;
    yield {id:nextId(),messageId,order:order++,kind:'Text',data:{text:text.slice(offset,end)}};
    offset=end;
  }
}
