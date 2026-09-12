import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { assertAttachmentCompaction, compactAttachment, ATTACHMENT_EXCLUSION_MARKER, activeMessagePath, appendGenerationOutput, assertGenerationTransition, assertHistory, createMessageEdit, finalizeGeneration, generationCandidates, ModelValidationError, planBranchTombstone, resolveMessagePath, selectActiveBranch, validateEntityShape, validateHistory, validateSearchChunk } from "../src/model/index.ts";
import type { CanonicalHistory, ContentPart, GenerationStatus } from "../src/model/index.ts";

const fixtures = new URL("../../../tests/fixtures/canonical/", import.meta.url);
async function load(name: string): Promise<CanonicalHistory> {
  const value: unknown = JSON.parse(await readFile(new URL(name,fixtures),"utf8"));assertHistory(value);return value;
}
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const native=()=>load("native-branches.history.json");

for(const name of ["native-branches","claude-compliance","chatgpt-conversations"]){
  test(`${name}: canonical graph and exact raw bytes survive JSON round trip`,async()=>{
    const history=await load(`${name}.history.json`);
    assert.deepEqual(validateHistory(JSON.parse(JSON.stringify(history))),[]);
    for(const raw of history.rawObjects){
      const bytes=await readFile(new URL(raw.storageRef!,fixtures));
      assert.equal(createHash('sha256').update(bytes).digest('hex'),raw.sha256);assert.equal(bytes.length,raw.byteLength);
    }
    for(const observation of history.provenance.filter(item=>item.rawObjectId&&item.locator!==null)){
      const raw=history.rawObjects.find(item=>item.id===observation.rawObjectId)!;
      let target:unknown=JSON.parse(await readFile(new URL(raw.storageRef!,fixtures),'utf8'));
      if(observation.locator)for(const key of observation.locator.slice(1).split('/').map(segment=>segment.replaceAll('~1','/').replaceAll('~0','~'))){assert.ok(target&&typeof target==='object'&&Object.hasOwn(target,key));target=(target as Record<string,unknown>)[key];}
      assert.notEqual(target,undefined);
    }
  });
}

test("multiple providers, candidates, tool turns and active path retain sibling history",async()=>{
  const history=await native();const expected=JSON.parse(await readFile(new URL('native-branches.expected.json',fixtures),'utf8'));
  assert.deepEqual(activeMessagePath(history,id(10)).map(message=>message.id),expected.activePath);
  for(const [parent,candidates] of Object.entries(expected.candidateGroups))assert.deepEqual(generationCandidates(history,parent).map(item=>item.id),candidates);
  const changed=selectActiveBranch(history,id(10),id(109));
  assert.deepEqual(activeMessagePath(changed,id(10)).map(item=>item.id),[id(108),id(109)]);
  assert.deepEqual(history.messages,changed.messages);assert.equal(history.threadStates[0]!.activeLeafMessageId,id(107));
  // Selecting an internal node deliberately ends the visible path without deleting descendants.
  assert.deepEqual(activeMessagePath(selectActiveBranch(history,id(10),id(100)),id(10)).map(item=>item.id),[id(100)]);
});

test("editing generated output creates a new sibling and does not rewrite its descendants",async()=>{
  const history=await native();const original=JSON.stringify(history);
  const replacement:ContentPart={id:id(9001),messageId:id(9000),order:0,kind:'Text',data:{text:'User revised this answer.'}};
  const next=createMessageEdit(history,id(102),id(9000),[replacement],1788870000000);
  const edited=next.messages.at(-1)!;
  assert.equal(edited.parentId,id(100));assert.equal(edited.generationId,null);assert.equal(edited.editedFromMessageId,id(102));
  assert.equal(next.messages.find(item=>item.id===id(103))!.parentId,id(102));
  assert.equal(JSON.stringify(history),original);assert.equal(next.threadStates[0]!.activeLeafMessageId,id(107));
});

test("stream checkpoints append monotonically and terminal statuses seal retained prefixes",async()=>{
  const history=await native();const before=history.parts.find(part=>part.id===id(1110))!;
  const next=appendGenerationOutput(history,{generationId:id(206),sequence:1,newParts:[],textAppend:{partId:id(1110),text:' and is retained.'}});
  assert.deepEqual(history.parts.find(part=>part.id===id(1110)),before);
  assert.equal(next.generations.find(item=>item.id===id(206))!.lastSequence,1);
  assert.throws(()=>appendGenerationOutput(next,{generationId:id(206),sequence:1,newParts:[],textAppend:null}),ModelValidationError);
  assert.throws(()=>appendGenerationOutput(next,{generationId:id(206),sequence:3,newParts:[],textAppend:null}),ModelValidationError);
  for(const status of ['complete','stopped','failed','cancelled','partial'] as const){
    const sealed=finalizeGeneration(next,id(206),status,1788870000000);
    assert.equal(sealed.messages.find(item=>item.id===id(110))!.sealed,true);
    assert.equal(sealed.parts.find(item=>item.id===id(1110))!.kind,'Text');
    assert.throws(()=>appendGenerationOutput(sealed,{generationId:id(206),sequence:2,newParts:[],textAppend:null}),ModelValidationError);
    assert.throws(()=>finalizeGeneration(sealed,id(206),'complete',1788870000001),ModelValidationError);
  }
});

test('transport provenance leaves the latest text appendable but semantic parts close it',async()=>{
  const history=await native();
  const rawObjectId=history.rawObjects[0]!.id;
  const evidence:ContentPart[]=['quixi.provider.raw-stream-chunk','quixi.provider.response-manifest'].map((providerKind,index)=>({id:id(9200+index),messageId:id(110),order:1+index,kind:'ProviderArtifact',data:{providerKind,rawObjectId,locator:''}}));
  const checkpoint=appendGenerationOutput(history,{generationId:id(206),sequence:1,newParts:evidence,textAppend:null});
  const next=appendGenerationOutput(checkpoint,{generationId:id(206),sequence:2,newParts:[],textAppend:{partId:id(1110),text:'\u0000🙂 continued'}});
  assert.deepEqual(next.parts.slice(-2),evidence);
  assert.deepEqual(next.parts.find(part=>part.id===id(1110))!.data,{text:(history.parts.find(part=>part.id===id(1110))!.data as {text:string}).text+'\u0000🙂 continued'});
  assert.throws(()=>appendGenerationOutput(next,{generationId:id(206),sequence:2,newParts:[],textAppend:null}),ModelValidationError);
  for(const barrier of [
    {kind:'Text',data:{text:'next block'}},
    {kind:'ProviderArtifact',data:{providerKind:'unknown-provider-part',rawObjectId,locator:''}},
  ] as const){
    const closed=appendGenerationOutput(next,{generationId:id(206),sequence:3,newParts:[{id:id(9202),messageId:id(110),order:3,...barrier}],textAppend:null});
    assert.throws(()=>appendGenerationOutput(closed,{generationId:id(206),sequence:4,newParts:[],textAppend:{partId:id(1110),text:' forbidden'}}),ModelValidationError);
  }
  assert.throws(()=>appendGenerationOutput(finalizeGeneration(next,id(206),'complete',1788870000000),{generationId:id(206),sequence:3,newParts:[],textAppend:{partId:id(1110),text:' late'}}),ModelValidationError);
});

test("unknown generation status and terminal-to-terminal transitions are rejected",()=>{
  assert.throws(()=>assertGenerationTransition('complete','failed'),ModelValidationError);
  assert.throws(()=>assertGenerationTransition('streaming','streaming'),ModelValidationError);
  assert.throws(()=>assertGenerationTransition('streaming','invented' as GenerationStatus),ModelValidationError);
});

test("branch tombstones cover descendants and choose closest retained active ancestor",async()=>{
  const history=await native();const {tombstone,state}=planBranchTombstone(history,id(10),id(103),id(9100),1788870000000);
  assert.equal(tombstone.rootMessageId,id(103));assert.equal(state.activeLeafMessageId,id(102));
  const next={...history,tombstones:[tombstone],threadStates:[state]};assertHistory(next);
  assert.throws(()=>resolveMessagePath(next,id(10),id(107)),ModelValidationError);
  const whole=planBranchTombstone(history,id(10),null,id(9101),1788870000000);
  assert.equal(whole.tombstone.rootMessageId,null);assert.equal(whole.state.activeLeafMessageId,null);
  assert.ok(validateHistory({...next,tombstones:[{...tombstone,messageIds:[id(103)]}]}).some(issue=>issue.code==='INVALID_VALUE'));
});

test("import retains unsupported parts, missing attachments, provenance, and unknown generation facts",async()=>{
  const history=await load('claude-compliance.history.json');
  assert.equal(history.generations.length,0);assert.equal(history.messages[1]!.generationId,null);
  assert.equal(history.attachments[0]!.availability,'missing');assert.equal(history.attachments[0]!.blobSha256,null);
  assert.ok(history.parts.some(part=>part.kind==='ProviderArtifact'&&part.data.providerKind==='quixi_fixture_unknown'));
  assert.ok(history.parts.some(part=>part.kind==='ReasoningMetadata'&&part.data.redacted&&part.data.summary===null));
  assert.ok(history.sourceIdentities.every(identity=>identity.nativeId!==identity.quixiId));
  const unknownTime=await load('chatgpt-conversations.history.json');assert.equal(unknownTime.threads[0]!.createdAt,null);
  assert.ok(unknownTime.sourceIdentities.every(identity=>identity.sourceThreadId===null&&identity.sourceContainerKey.startsWith('fingerprint:')));
});

const invalidCases=JSON.parse(await readFile(new URL('invalid-cases.json',fixtures),'utf8')) as {name:string;fixture:string;path:(string|number)[];value:unknown;code:string}[];
for(const example of invalidCases)test(`invalid fixture: ${example.name}`,async()=>{
  const value:unknown=JSON.parse(await readFile(new URL(example.fixture,fixtures),'utf8'));
  let target=value as Record<string|number,unknown>;
  for(const segment of example.path.slice(0,-1))target=target[segment] as Record<string|number,unknown>;
  target[example.path.at(-1)!]=example.value;
  assert.ok(validateHistory(value).some(issue=>issue.code===example.code),JSON.stringify(validateHistory(value)));
});

test("cross-thread references and scoped source identity collisions fail explicitly",async()=>{
  const history=await native();const imported=await load('claude-compliance.history.json');
  const merged:CanonicalHistory={version:1,...Object.fromEntries(Object.keys(history).filter(key=>key!=='version').map(key=>[key,[...(history[key as Exclude<keyof CanonicalHistory,'version'>] ?? []),...(imported[key as Exclude<keyof CanonicalHistory,'version'>] ?? [])]]))} as CanonicalHistory;
  assertHistory(merged);merged.messages[0]!.parentId=imported.messages[0]!.id;
  assert.ok(validateHistory(merged).some(issue=>issue.code==='CROSS_THREAD'));
  imported.sourceIdentities.push({...imported.sourceIdentities[0]!,id:id(9900)});
  assert.ok(validateHistory(imported).some(issue=>issue.code==='SOURCE_IDENTITY_CONFLICT'));
});

test("a deep imported chain validates without recursive parent traversal",async()=>{
  const history=await load('chatgpt-conversations.history.json');history.messages=[];history.parts=[];history.sourceIdentities=[];history.provenance=[];
  const base={threadId:id(30),role:'user' as const,createdAt:null,recordedAt:1788870000000,generationId:null,editedFromMessageId:null,partCount:0,sealed:true};
  for(let i=0;i<10_000;i++)history.messages.push({...base,id:id(100000+i),parentId:i?id(100000+i-1):null});
  history.threadStates[0]!.activeLeafMessageId=history.messages.at(-1)!.id;assertHistory(history);
  assert.equal(activeMessagePath(history,id(30)).length,10_000);
});

test("derived chunks have source/version identity and do not require an embedding model",()=>{
  const chunk={id:'derived-message-v1',sourceType:'message',sourceId:id(100),partIds:[id(1100)],chunkIndex:0,text:'Plan a two-day trip.',contextPrefix:'',sourceDigest:'a'.repeat(64),chunkerVersion:'v1',tokenizerVersion:null,tokenStart:null,tokenEnd:null,embeddingModelId:null,embeddingStatus:'not_indexed'};
  assert.deepEqual(validateSearchChunk(chunk),[]);
  assert.ok(validateSearchChunk({...chunk,embeddingStatus:'ready'}).length>0);
  assert.ok(validateSearchChunk({...chunk,tokenStart:8,tokenEnd:2}).length>0);
  assert.ok(validateSearchChunk({...chunk,sourceDigest:'unverified'}).length>0);
});


test("initial route equality ignores object order, IDs use canonical case, and edit cycles fail",async()=>{
  const history=await native();
  history.threads[0]!.preferredRoute={model:"synthetic",parameters:{b:2,a:1}};
  history.contexts[0]!.preferredRoute={parameters:{a:1,b:2},model:"synthetic"};assertHistory(history);
  const changed=structuredClone(history);changed.messages.find(item=>item.id===id(100))!.editedFromMessageId=id(108);
  assert.ok(validateHistory(changed).some(issue=>issue.code==='EDIT_RELATIONSHIP'));
  history.documents[0]!.attachmentId=id(99999);assert.ok(validateHistory(history).some(issue=>issue.code==='MISSING_REFERENCE'));
  history.documents[0]!.attachmentId=id(400);history.documents[0]!.id='abcdefab-abcd-4abc-8abc-abcdefabcdef'.toUpperCase();
  assert.ok(validateHistory(history).some(issue=>issue.code==='INVALID_ID'));
});


test("bounded entity shape validation reuses canonical fields without requiring a whole thread",async()=>{
  const history=await native();
  assert.deepEqual(validateEntityShape('messages',history.messages[0]),[]);
  assert.ok(validateEntityShape('messages',{...history.messages[0],role:'invented'}).some(item=>item.code==='INVALID_VALUE'));
  assert.ok(validateEntityShape('parts',{id:id(9991),messageId:id(100),order:0,kind:'Text',data:{text:7}}).length);
  // Shape checking is deliberately not a referential-integrity guarantee.
  assert.deepEqual(validateEntityShape('messages',{...history.messages[0],parentId:id(99999)}),[]);
});

test('long text uses bounded ordered segments or one UTF-8 blob reference without an inline manifest',async()=>{
  const {inlineTextSegments,MAX_INLINE_TEXT_CHARS}=await import('../src/model/index.ts');
  const text='x'.repeat(MAX_INLINE_TEXT_CHARS-1)+'🎉'+'y'.repeat(MAX_INLINE_TEXT_CHARS+3);let counter=30000;
  const parts=[...inlineTextSegments(id(100),0,text,()=>id(counter++))];
  assert.equal(parts.map(part=>part.kind==='Text'?part.data.text:'').join(''),text);
  for(const part of parts){assert.deepEqual(validateEntityShape('parts',part),[]);if(part.kind==='Text')assert.ok(part.data.text!.length<=MAX_INLINE_TEXT_CHARS);}
  const history=await native();history.parts=history.parts.filter(part=>part.messageId!==id(100));history.parts.push(...parts);history.messages[0]!.partCount=parts.length;assertHistory(history);
  const blobPart={...parts[0]!,data:{textBlob:{sha256:'a'.repeat(64),byteLength:50_000_000,encoding:'utf-8'}}};
  assert.deepEqual(validateEntityShape('parts',blobPart),[]);
  assert.ok(validateEntityShape('parts',{...blobPart,data:{...blobPart.data,text:'ambiguous'}}).length);
  assert.ok(validateEntityShape('parts',{...parts[0],data:{text:'x'.repeat(MAX_INLINE_TEXT_CHARS+1)}}).length);
  assert.ok(validateEntityShape('messages',{...history.messages[0],partIds:parts.map(part=>part.id)}).length);
});


test('reviewed exclusions validate exact occurrence references and retain source history', async () => {
  const h = await native(), original = structuredClone(h);
  const part = h.parts.find(part => part.kind === 'File')!;
  const policy = { version: 1 as const, excludedPartIds: [part.id] };
  h.contexts[0]!.compaction = policy;
  assertHistory(h);
  assert.equal(compactAttachment(part, new Set()).kind, 'File');
  assert.deepEqual(compactAttachment(part, new Set(policy.excludedPartIds)), { id: part.id, messageId: part.messageId, order: part.order, kind: 'Text', data: { text: ATTACHMENT_EXCLUSION_MARKER } });
  assert.deepEqual(h.parts, original.parts); assert.deepEqual(h.attachments, original.attachments);
  for (const invalid of [{version: 2, excludedPartIds: []}, {version: 1, excludedPartIds: [part.id, part.id]}, {version: 1, excludedPartIds: ['bad']}, {version: 1, excludedPartIds: Array.from({length:65}, (_, i) => id(8000+i))}, {...policy, summary: 'unreviewed'}]) assert.throws(() => assertAttachmentCompaction(invalid));
  for (const excludedPartIds of [[id(99999)], [h.parts.find(part => part.kind === 'Text')!.id]]) {
    h.contexts[0]!.compaction = {version:1, excludedPartIds}; assert.notDeepEqual(validateHistory(h), []);
  }
  assert.throws(() => compactAttachment(h.parts.find(part => part.kind === 'Text')!, new Set(h.parts.map(part => part.id))));
});
