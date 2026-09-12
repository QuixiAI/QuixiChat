import { SUMMARY_INSTRUCTION } from '../src/model/summaries.ts';
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMessageEdit, assertHistory, planBranchTombstone } from "../src/model/index.ts";
import type { CanonicalHistory } from "../src/model/index.ts";
import { assertEntityPage, assertStorageResponse, assertAtomicSyncCoverage, assertSameOperation, assertStorageRequest, canonicalJson, jsonByteLength, MAX_TRANSFER_BYTES, MUTATION_KINDS, previewMutation, previewMutationBatch, syncOperationFor, TransferWindow, validateImportBundle } from "../src/contracts/index.ts";
import type { CanonicalMutation, MutationKind, MutationPayloads, StorageRequest } from "../src/contracts/index.ts";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const time=1788870000000;
async function load(name='native-branches'):Promise<CanonicalHistory>{const value:unknown=JSON.parse(await readFile(new URL(`../../../tests/fixtures/canonical/${name}.history.json`,import.meta.url),'utf8'));assertHistory(value);return value;}
const mutation=<K extends MutationKind>(kind:K,payload:MutationPayloads[K],operation=99000):CanonicalMutation=>({version:1,operationId:id(operation),kind,recordedAt:time,payload}) as CanonicalMutation;

test("every canonical mutation has validated, explicit sync-op coverage",async()=>{
  const history=await load();const imported=await load('claude-compliance');
  const initial={...history,messages:[],parts:[],generations:[],events:[],attachments:[],documents:[],rawObjects:[],threadStates:[{...history.threadStates[0]!,activeLeafMessageId:null}]};
  const empty={...initial,threads:[],contexts:[],threadStates:[]};
  const editPart={id:id(9501),messageId:id(9500),order:0,kind:'Text' as const,data:{text:'Edited synthetic answer'}};
  const edit=createMessageEdit(history,id(102),id(9500),[editPart],time).messages.at(-1)!;
  const branch=planBranchTombstone(history,id(10),id(103),id(9502),time);
  const thread=planBranchTombstone(history,id(10),null,id(9503),time);
  const summaryGeneration={...history.generations[0]!,id:id(9602),purpose:'context_summary' as const,parentMessageId:id(102),outputMessageId:id(9603),contextSnapshotId:id(9601),status:'complete' as const};
  const summaryHistory={...history,contexts:[...history.contexts,{...history.contexts[0]!,id:id(9601),previousId:id(11),version:2,systemPrompt:SUMMARY_INSTRUCTION}],generations:[...history.generations,summaryGeneration],messages:[...history.messages,{...history.messages[1]!,id:id(9603),generationId:id(9602),parentId:id(102),partCount:0,sealed:true}],rawObjects:[...history.rawObjects,{id:id(9604),availability:'available' as const,sha256:'a'.repeat(64),byteLength:1,mediaType:'application/vnd.quixi.summary-input+json',storageRef:'sha256:'+ 'a'.repeat(64)}]};
  const cases:{history:CanonicalHistory;command:CanonicalMutation}[]=[
    {history:summaryHistory,command:mutation('RegisterSummaryProposal',{proposal:{version:1,id:id(9605),threadId:id(10),recordedAt:time,generationId:id(9602),sourceContextSnapshotId:id(11),requestContextSnapshotId:id(9601),throughMessageId:id(102),sourceLeafMessageId:id(103),sourceThreadRevision:0,baseSummaryProposalId:null,baseSummaryContextId:null,sourceMessageCount:1,sourcePartCount:1,sourceFingerprint:'b'.repeat(64),inputRawObjectId:id(9604),inputSha256:'a'.repeat(64),inputByteLength:1,promptTemplateVersion:1}})},
    {history:empty,command:mutation('CreateThread',{thread:history.threads[0]!,state:initial.threadStates[0]!,context:history.contexts[0]!})},
    {history:initial,command:mutation('CreateMessage',{message:history.messages[0]!,parts:history.parts.filter(part=>part.messageId===id(100))})},
    {history,command:mutation('EditMessage',{previousId:id(102),message:edit,parts:[editPart]})},
    {history:{...initial,messages:[history.messages[0]!],parts:history.parts.filter(part=>part.messageId===id(100))},command:mutation('CreateGeneration',{generation:history.generations[0]!,output:history.messages[1]!,parts:history.parts.filter(part=>part.messageId===id(101))})},
    {history,command:mutation('AppendGenerationOutput',{generationId:id(206),sequence:1,newParts:[],textAppend:{partId:id(1110),text:' extra'}})},
    {history,command:mutation('CompleteGeneration',{generationId:id(206),status:'partial',completedAt:time,tokensIn:null,tokensOut:null,cachedTokens:null,estimatedCost:null,reportedCost:null,rawResponseId:null})},
    {history,command:mutation('CreateThreadEvent',{event:{...history.events[0]!,id:id(9504),type:'UserNote',details:{text:'Original note'}}})},
    {history,command:mutation('SetTitle',{threadId:id(10),value:'New title'})},
    {history,command:mutation('SetTags',{threadId:id(10),value:['new']})},
    {history,command:mutation('SetPinned',{threadId:id(10),value:true})},
    {history,command:mutation('SetArchived',{threadId:id(10),value:true})},
    {history,command:mutation('SetActiveBranch',{threadId:id(10),value:id(109)})},
    {history,command:mutation('SetRoutingProfile',{threadId:id(10),value:{provider:'fixture-route'}})},
    {history,command:mutation('CreateContextSnapshot',{context:{...history.contexts[0]!,id:id(9505),previousId:id(11),version:2,systemPrompt:'New prompt',recordedAt:time},select:true})},
    {history,command:mutation('RegisterRawObject',{rawObject:{...imported.rawObjects[0]!,id:id(9599)}})},
    {history,command:mutation('RegisterImportSource',{source:imported.importSources[0]!,rawObjects:imported.rawObjects})},
    {history:{...imported,provenance:[],sourceIdentities:[]},command:mutation('AttachProvenance',{provenance:imported.provenance,identities:imported.sourceIdentities})},
    {history,command:mutation('RegisterAttachment',{attachment:{...history.attachments[0]!,id:id(9506)}})},
    {history,command:mutation('RegisterDocument',{document:{...history.documents[0]!,id:id(9515)}})},
    {history,command:mutation('SetDocumentTitle',{documentId:id(450),value:'Renamed document'})},
    {history,command:mutation('AttachContent',{messageId:id(110),sequence:1,parts:[{id:id(9507),messageId:id(110),order:1,kind:'File',data:{attachmentId:id(400),description:null}}]})},
    {history,command:mutation('ResolveAttachment',{attachmentId:id(400),blobSha256:'a'.repeat(64),sizeBytes:3,provenance:[]})},
    {history,command:mutation('TombstoneThread',thread)},
    {history,command:mutation('TombstoneBranch',branch)},
  ];
  assert.deepEqual(cases.map(item=>item.command.kind).sort(),[...MUTATION_KINDS].sort());
  for(const item of cases){
    const before=JSON.stringify(item.history);
    const operation=syncOperationFor(item.command,item.history);
    const next=previewMutation(item.history,item.command);assertHistory(next);
    assert.equal(JSON.stringify(item.history),before,`${item.command.kind} mutated its input`);
    assert.ok(operation.affects.length,`${item.command.kind} has no canonical effects`);
    // Check actual changed records independently of the command/effects switch.
    const kinds={threads:'thread',threadStates:'threadState',contexts:'context',messages:'message',generations:'generation',parts:'part',events:'event',attachments:'attachment',documents:'document',rawObjects:'rawObject',importSources:'importSource',sourceIdentities:'sourceIdentity',provenance:'provenance',tombstones:'tombstone'} as const;
    for(const collection of Object.keys(kinds) as (keyof typeof kinds)[]){
      const key=(record:{id?:string;threadId?:string})=>record.id??record.threadId!;
      const previous=new Map((item.history[collection] ?? []).map(record=>[key(record),JSON.stringify(record)]));
      for(const record of next[collection])if(previous.get(key(record))!==JSON.stringify(record))assert.ok(operation.affects.some(effect=>effect.kind===kinds[collection]&&effect.id===key(record)),`${item.command.kind} leaves ${collection}/${key(record)} without sync coverage`);
    }
    assertAtomicSyncCoverage(operation.affects,[operation]);
    assert.throws(()=>assertAtomicSyncCoverage(operation.affects,[]));
    assert.equal(operation.operationId,item.command.operationId);
  }
});

test("operation identity survives retries and rejects changed payloads",async()=>{
  const history=await load();const command=mutation('SetRoutingProfile',{threadId:id(10),value:{a:1,b:2}});
  const first=syncOperationFor(command,history);
  const reordered=syncOperationFor(mutation('SetRoutingProfile',{threadId:id(10),value:{b:2,a:1}}),history);
  assertSameOperation(first,reordered);
  assert.throws(()=>assertSameOperation(first,syncOperationFor(mutation('SetRoutingProfile',{threadId:id(10),value:{a:2,b:2}}),history)));
  assert.throws(()=>assertSameOperation(first,{...first,operationId:id(99001)}));
  assert.throws(()=>assertAtomicSyncCoverage(first.affects,[first,first]));
  assert.equal(canonicalJson({b:2,a:1}),canonicalJson({a:1,b:2}));
});

test("attachment resolution never rewrites sealed content and new parts require an edit",async()=>{
  const history=await load();const before=JSON.stringify(history.messages);
  const next=previewMutation(history,mutation('ResolveAttachment',{attachmentId:id(400),blobSha256:'a'.repeat(64),sizeBytes:3,provenance:[]}));
  assert.equal(JSON.stringify(next.messages),before);assert.equal(next.attachments[0]!.availability,'available');
  assert.throws(()=>previewMutation(next,mutation('ResolveAttachment',{attachmentId:id(400),blobSha256:'b'.repeat(64),sizeBytes:3,provenance:[]})));
  const illegal=mutation('AttachContent',{messageId:id(103),sequence:1,parts:[{id:id(9507),messageId:id(103),order:2,kind:'File',data:{attachmentId:id(400),description:null}}]});
  assert.throws(()=>previewMutation(history,illegal),/SEALED_CONTENT/);assert.throws(()=>syncOperationFor(illegal,history));
});

test("new context snapshots preserve prior attempt prompts and workspace identity",async()=>{
  const history=await load();const original=JSON.stringify(history.generations);
  const next=previewMutation(history,mutation('CreateContextSnapshot',{context:{...history.contexts[0]!,id:id(9510),previousId:id(11),version:2,systemPrompt:'Revised prompt',preferredRoute:{model:'fixture-new'},recordedAt:time},select:true}));
  assert.equal(next.threadStates[0]!.contextSnapshotId,id(9510));assert.equal(JSON.stringify(next.generations),original);
  assert.deepEqual(next.threads,history.threads);assert.equal(next.contexts[0]!.systemPrompt,'Preserve history honestly.');
});

test("a batch validates atomically in memory and stale revisions cannot silently overwrite",async()=>{
  const history=await load();const before=JSON.stringify(history);
  const batch={transactionId:id(9600),expectedThreadRevisions:[{threadId:id(10),revision:0}],stagedBlobIds:[],mutations:[mutation('SetTitle',{threadId:id(10),value:'Changed'},9601),mutation('SetPinned',{threadId:id(10),value:true},9602)]};
  const after=previewMutationBatch(history,batch);assert.equal(after.threadStates[0]!.revision,2);assert.equal(after.threadStates[0]!.pinned,true);assert.equal(JSON.stringify(history),before);
  assert.throws(()=>previewMutationBatch(after,batch),/CONFLICT/);
  assert.throws(()=>previewMutationBatch(history,{...batch,mutations:[batch.mutations[0]!,mutation('SetActiveBranch',{threadId:id(10),value:id(99999)},9603)]}));
  assert.equal(JSON.stringify(history),before);
});

test("storage request identity, bounded pages, blob staging and cancellation metadata are serializable",()=>{
  const request:StorageRequest={version:1,requestId:id(9700),operation:'beginBlobTransfer',args:{operationId:id(9701),purpose:'attachment',expectedBytes:2000,expectedSha256:null}};
  assertStorageRequest(request);
  assertStorageRequest({version:1,requestId:id(9702),operation:'finishBlobTransfer',args:{operationId:id(9703),transferId:id(9704),expectedBytes:2000,expectedSha256:'a'.repeat(64)}});
  assertStorageRequest({version:1,requestId:id(9705),operation:'readBlobTransfer',args:{sha256:'a'.repeat(64)}});
  assertStorageRequest({version:1,requestId:id(9706),operation:'discardBlobTransfer',args:{transferId:id(9704)}});
  const page:StorageRequest={version:1,requestId:id(9710),operation:'readEntities',args:{threadId:id(10),collection:'messages',page:{maxItems:100,maxBytes:MAX_TRANSFER_BYTES,cursor:null}}};
  assertStorageRequest(page);
  assert.throws(()=>assertStorageRequest({...page,args:{...page.args,page:{...page.args.page,maxBytes:MAX_TRANSFER_BYTES+1}}}));
  assert.throws(()=>assertStorageRequest({...request,args:{...request.args,expectedBytes:-1}}));
  assert.throws(()=>assertStorageRequest({...request,requestId:'provider-native-id'}));
});

test("bounded JSON preflight counts UTF-8/escapes and rejects before visiting later payload fields",()=>{
  for(const value of ['plain','Café','🎉','\ud800','\udc00','\u0000\b\f\n\r\t"\\',{a:'é',b:['🎉',null,true,123,-0,1e30]}])assert.equal(jsonByteLength(value),Buffer.byteLength(JSON.stringify(value)));
  let read=false;const payload={text:'x'.repeat(MAX_TRANSFER_BYTES+1),get later(){read=true;throw new Error('must not be read')}};
  assert.throws(()=>jsonByteLength(payload),/byte limit/);assert.equal(read,false);
  assert.throws(()=>jsonByteLength({x:undefined}));assert.throws(()=>jsonByteLength({x:NaN}));
  const cycle:Record<string,unknown>={};cycle.x=cycle;assert.throws(()=>jsonByteLength(cycle),/cycle/);
});

test("byte transfers apply backpressure and validate ordering, bounds and acknowledgements",()=>{
  const transferId=id(9800);const window=new TransferWindow(transferId,4,2);
  window.reserve({transferId,sequence:0,offset:0,bytes:new Uint8Array([1,2,3,4]),final:false});
  window.reserve({transferId,sequence:1,offset:4,bytes:new Uint8Array([5]),final:false});assert.equal(window.pendingBytes,5);
  assert.throws(()=>window.reserve({transferId,sequence:2,offset:5,bytes:new Uint8Array([6]),final:false}),/backpressure/);
  assert.throws(()=>window.acknowledge({transferId,sequence:0,committedOffset:3}));
  window.acknowledge({transferId,sequence:0,committedOffset:4});
  assert.throws(()=>window.reserve({transferId,sequence:2,offset:6,bytes:new Uint8Array([6]),final:false}));
  assert.throws(()=>window.reserve({transferId,sequence:2,offset:5,bytes:new Uint8Array(5),final:false}));
  window.reserve({transferId,sequence:2,offset:5,bytes:new Uint8Array([6]),final:true});
  assert.equal(window.complete,false);window.acknowledge({transferId,sequence:1,committedOffset:5});window.acknowledge({transferId,sequence:2,committedOffset:6});assert.equal(window.complete,true);
  assert.throws(()=>window.reserve({transferId,sequence:3,offset:6,bytes:new Uint8Array([7]),final:true}));
});

test("provider-native import manifests retain explicit missing entries and cannot bypass byte bounds",()=>{
  const bundle={version:1,id:id(9850),provider:'fixture-provider',method:'file_export',capturedAt:time,sourceFormatVersion:null,entries:[{id:id(9851),path:'conversations.json',mediaType:'application/json',byteLength:42,sha256:'a'.repeat(64),availability:'available'},{id:id(9852),path:'missing.pdf',mediaType:'application/pdf',byteLength:null,sha256:null,availability:'missing'}]};
  assert.equal(validateImportBundle(bundle),true);
  assert.equal(validateImportBundle({...bundle,entries:[{...bundle.entries[0],path:'../outside'}]}),false);
  assert.equal(validateImportBundle({...bundle,entries:[{...bundle.entries[0],sha256:null}]}),false);
  assert.equal(validateImportBundle({...bundle,provider:'x'.repeat(MAX_TRANSFER_BYTES+1)}),false);
  assert.equal(validateImportBundle({...bundle,entries:[bundle.entries[0],bundle.entries[0]]}),false);
});


test("reply correlation, page bytes, and structured failures obey the worker boundary",()=>{
  const requestId=id(9750);const result={items:[{text:"é"}],nextCursor:null,bytes:jsonByteLength([{text:"é"}])};
  assertStorageResponse({version:1,requestId,ok:true,result},requestId);
  assertEntityPage(result,{maxItems:1,maxBytes:100,cursor:null});
  assert.throws(()=>assertStorageResponse({version:1,requestId:id(9751),ok:true,result},requestId));
  assert.throws(()=>assertStorageResponse({version:1,requestId,ok:true,result:"x".repeat(MAX_TRANSFER_BYTES)},requestId));
  assert.throws(()=>assertEntityPage({...result,bytes:1},{maxItems:1,maxBytes:100,cursor:null}));
  assert.throws(()=>assertEntityPage(result,{maxItems:1,maxBytes:2,cursor:null}));
  const error={code:"UNKNOWN_OUTCOME",message:"Reconcile original operation",requestId,operationId:id(9752),retry:"same_operation_id",details:{}};
  assertStorageResponse({version:1,requestId,ok:false,error},requestId);
  assert.throws(()=>assertStorageResponse({version:1,requestId,ok:false,error:{...error,requestId:id(9753)}},requestId));
});

test("batch staging identities and optimistic revision keys must be unique",async()=>{
  const history=await load();const batch={transactionId:id(9760),expectedThreadRevisions:[{threadId:id(10),revision:0}],stagedBlobIds:[id(9761)],mutations:[mutation('SetTitle',{threadId:id(10),value:'Title'})]};
  for(const invalid of [{...batch,stagedBlobIds:[id(9761),id(9761)]},{...batch,stagedBlobIds:['native-id']},{...batch,expectedThreadRevisions:[...batch.expectedThreadRevisions,...batch.expectedThreadRevisions]}]){
    assert.throws(()=>previewMutationBatch(history,invalid));
    assert.throws(()=>assertStorageRequest({version:1,requestId:id(9762),operation:'commit',args:invalid}));
  }
});

test('sync inspection uses monotonic local sequence and canonical text declares a verified UTF-8 transfer purpose',()=>{
  assertStorageRequest({version:1,requestId:id(9950),operation:'readSyncOperations',args:{afterSequence:42,page:{maxItems:10,maxBytes:10000,cursor:null}}});
  assert.throws(()=>assertStorageRequest({version:1,requestId:id(9950),operation:'readSyncOperations',args:{afterSequence:-1,page:{maxItems:10,maxBytes:10000,cursor:null}}}));
  assertStorageRequest({version:1,requestId:id(9951),operation:'beginBlobTransfer',args:{operationId:id(9952),purpose:'canonical_text',expectedBytes:50_000_000,expectedSha256:null}});
});

test('normalized imports use bounded independent controls, stable publication manifests and null diagnostics',async()=>{
  const h=await load('claude-compliance');const operationId=id(99001),importId=id(99002),threadId=h.threads[0]!.id;
  const declaration:StorageRequest={version:1,requestId:id(99000),operation:'beginNormalizedImport',args:{operationId,importId,threadId,mode:'create',expectedThreadRevision:null,recordedAt:time}};
  assert.doesNotThrow(()=>assertStorageRequest(declaration));
  assert.throws(()=>assertStorageRequest({...declaration,args:{...declaration.args,expectedThreadRevision:0}}),/declaration/);
  assert.doesNotThrow(()=>assertStorageRequest({...declaration,args:{...declaration.args,mode:'extend',expectedThreadRevision:4}}));
  const records=h.parts.map((record,index)=>({collection:'parts' as const,record,operationId:id(99100+index),recordedAt:time}));
  const stage:StorageRequest={version:1,requestId:id(99000),operation:'stageImportRecords',args:{operationId,importId,sequence:0,records}};
  assert.doesNotThrow(()=>assertStorageRequest(stage));
  assert.throws(()=>assertStorageRequest({...stage,args:{...stage.args,records:[records[0]!,records[0]!]}}),/envelope/);
  assert.throws(()=>assertStorageRequest({...stage,args:{...stage.args,records:Array.from({length:129},()=>records[0]!)}}),/bounded/);
  assert.throws(()=>assertStorageRequest({...stage,args:{...stage.args,records:[{...records[0]!,record:{...records[0]!.record,order:-1}}]}}),/shape/);
  const validate:StorageRequest={version:1,requestId:id(99000),operation:'validateImportStep',args:{operationId,importId,maxRecords:128,stagedBlobIds:[]}};
  assert.doesNotThrow(()=>assertStorageRequest(validate));assert.throws(()=>assertStorageRequest({...validate,args:{...validate.args,maxRecords:129}}),/bounded/);
  const final:StorageRequest={version:1,requestId:id(99000),operation:'finalizeNormalizedImport',args:{operationId,importId,recordedAt:time,expectedRecordCount:50000,expectedManifestDigest:'f'.repeat(64)}};
  assert.doesNotThrow(()=>assertStorageRequest(final));assert.throws(()=>assertStorageRequest({...final,args:{...final.args,expectedManifestDigest:'unknown'}}),/manifest/);
  const diagnostics:StorageRequest={version:1,requestId:id(99000),operation:'diagnostics',args:null};assert.doesNotThrow(()=>assertStorageRequest(diagnostics));
  assert.throws(()=>assertStorageRequest({...diagnostics,args:{}} as unknown as StorageRequest),/null/);
});

test('import work UUID/checkpoint controls and pinned blob slices enforce bounded serializable arguments',()=>{
  const requestId=id(99000),runId=id(99001),operationId=id(99002);
  const allocation:StorageRequest={version:1,requestId,operation:'importAllocateIds',args:{runId,keys:['message:a','operation:stage:0']}};assert.doesNotThrow(()=>assertStorageRequest(allocation));assert.throws(()=>assertStorageRequest({...allocation,args:{runId,keys:['same','same']}}),/allocation/);
  const checkpoint:StorageRequest={version:1,requestId,operation:'importWorkCheckpoint',args:{operationId,runId,groupKey:'source:0',key:'node:a',expectedRevision:0,checkpoint:{stageStartSequence:5,blobAttempt:1}}};assert.doesNotThrow(()=>assertStorageRequest(checkpoint));
  assert.throws(()=>assertStorageRequest({...checkpoint,args:{...checkpoint.args,checkpoint:{oversized:'x'.repeat(65536)}}}),/limit|large|budget/i);
  const range:StorageRequest={version:1,requestId,operation:'sliceBlobTransfer',args:{transferId:id(99003),offset:1024,byteLength:4096}};assert.doesNotThrow(()=>assertStorageRequest(range));
  assert.throws(()=>assertStorageRequest({...range,args:{...range.args,offset:Number.MAX_SAFE_INTEGER}}),/range/);
  const prepare:StorageRequest={version:1,requestId,operation:'prepareImportBlobs',args:{operationId,importId:id(99004),stagedBlobIds:[id(99005)]}};assert.doesNotThrow(()=>assertStorageRequest(prepare));
  assert.throws(()=>assertStorageRequest({...prepare,args:{...prepare.args,stagedBlobIds:[id(99005),id(99005)]}}),/preparation/);
});
