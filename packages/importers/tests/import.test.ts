import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {beginChatgptImport,importChatgptSource} from '../src/index.ts';
import type {ImportRuntime,ImportByteSource} from '../src/index.ts';
import type {Message,ContentPart,ThreadState,JsonValue} from '@quixi/core/model';
import {StorageHarness} from './storage-harness.ts';
const now=1788870000000,page={maxItems:1000,maxBytes:1_000_000,cursor:null};
function source(value:unknown):ImportByteSource{const bytes=new TextEncoder().encode(JSON.stringify(value));return{name:'conversations.json',byteLength:bytes.length,async*open(start=0,end=bytes.length){for(let offset=start;offset<end;offset+=65536)yield bytes.slice(offset,Math.min(end,offset+65536));}};}
const message=(id:string,role:string,parts:unknown[])=>({id,author:{role},create_time:1700000000,content:{content_type:'text',parts}});
const fixture=(answer='first answer',many=false)=>[{conversation_id:'thread-native',title:'Original title',create_time:1700000000,current_node:'alternative',mapping:{alternative:{parent:'user',message:message('alternative-native','assistant',['alternative'])},answer:{parent:'user',message:message('answer-native','assistant',many?['large 😀'.repeat(12000),...Array.from({length:1001},(_,i)=>`piece ${i}`),{content_type:'unknown_widget',payload:{opaque:true}}]:[answer])},user:{parent:'root',message:{...message('user-native','user',['question']),metadata:{attachments:[{file_name:'missing.pdf',file_size:123}]}}},root:{parent:null,message:null}}}];
async function run(harness:StorageHarness,value:unknown,accountScope='account-one'){const runtime:ImportRuntime={storage:harness.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false};const runId=randomUUID();await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope,recordedAt:now});return{runtime,runId,result:await importChatgptSource(runtime,{runId,sourceKey:'file-0',source:source(value)})};}
const entities=(h:StorageHarness,collection:Parameters<StorageHarness['repository']['readEntities']>[0]['collection'])=>h.repository.readEntities({collection,threadId:null,page}).items;

test('public StorageClient importer preserves raw bytes, branches, missing attachments, unsupported parts and more than one request of message parts',async()=>{
 const h=new StorageHarness(),input=fixture('unused',true);const result=await run(h,input);
 assert.equal(result.result.state,'complete');assert.equal(entities(h,'threads').length,1);const messages=entities(h,'messages') as unknown as Message[];assert.equal(messages.length,3);
 const user=messages.find(x=>x.role==='user')!;assert.equal(messages.filter(x=>x.parentId===user.id).length,2);
 const long=messages.find(x=>x.partCount===1003)!;assert.ok(long);let cursor:string|null=null,count=0,blob:ContentPart|null=null,artifact=false;
 do{const parts=h.repository.readMessageParts({messageId:long.id,page:{...page,maxItems:77,cursor}});for(const raw of parts.items){const part=raw as unknown as ContentPart;assert.equal(part.order,count++);if(part.kind==='Text'&&part.data.textBlob)blob=part;if(part.kind==='ProviderArtifact')artifact=true;}cursor=parts.nextCursor;}while(cursor);
 assert.equal(count,1003);assert.ok(blob?.kind==='Text'&&blob.data.textBlob);assert.equal(new TextDecoder().decode(h.published.get(blob.data.textBlob.sha256)!.bytes),'large 😀'.repeat(12000));assert.ok(artifact);
 assert.equal(entities(h,'attachments')[0]&&((entities(h,'attachments')[0] as {[key:string]:JsonValue}).availability),'missing');
 const state=entities(h,'threadStates')[0] as unknown as ThreadState;assert.equal(state.activeLeafMessageId,messages.find(x=>x.id!==long.id&&x.role==='assistant')!.id);
 const raw=entities(h,'rawObjects')[0] as {[key:string]:JsonValue};const expected=JSON.stringify(input);assert.equal(new TextDecoder().decode(h.published.get(String(raw.sha256))!.bytes),expected);assert.equal(raw.sha256,createHash('sha256').update(expected).digest('hex'));
 assert.ok(h.maxRequestBytes<1_048_576);assert.ok(h.maxReaders<=3);assert.equal(h.readers.size,0);assert.equal(h.db.selectValue('PRAGMA integrity_check'),'ok');
 const sync=h.repository.readSyncOperations({afterSequence:0,page:{...page,maxItems:1000}});assert.equal(sync.items[0]!.kind,'RegisterRawObject');
 await h.client.close();
});

test('reimport deduplicates native identities and edits add immutable revisions while preserving local user state',async()=>{
 const h=new StorageHarness();await run(h,fixture());const first=entities(h,'messages') as unknown as Message[],thread=entities(h,'threadStates')[0] as unknown as ThreadState;
 h.repository.commit({transactionId:randomUUID(),mutations:[{version:1,operationId:randomUUID(),kind:'SetTitle',recordedAt:now,payload:{threadId:thread.threadId,value:'My local title'}}],expectedThreadRevisions:[{threadId:thread.threadId,revision:0}],stagedBlobIds:[]});
 await run(h,fixture());assert.equal(entities(h,'messages').length,3);assert.equal(entities(h,'threads').length,1);
 await run(h,fixture('edited answer'));const after=entities(h,'messages') as unknown as Message[];assert.equal(after.length,4);const revision=after.find(x=>!first.some(previous=>previous.id===x.id))!;assert.ok(revision.editedFromMessageId);assert.equal((entities(h,'threadStates')[0] as unknown as ThreadState).title,'My local title');assert.equal((entities(h,'threadStates')[0] as unknown as ThreadState).activeLeafMessageId,thread.activeLeafMessageId);
 await run(h,fixture('edited answer'));assert.equal(entities(h,'messages').length,4);await h.client.close();
});

test('lost stage reply resumes using original operation and sequence from retained raw bytes after owner restart',async()=>{
 const h=new StorageHarness();const runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false};const runId=randomUUID();await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:'resume',recordedAt:now});
 let lost=false;h.afterRequest=(operation)=>{if(operation==='stageImportRecords'&&!lost){lost=true;throw new Error('simulated unknown outcome after SQL commit');}};
 await assert.rejects(importChatgptSource(runtime,{runId,sourceKey:'file',source:source(fixture())}),/unknown outcome/);assert.equal(entities(h,'threads').length,0);assert.equal(entities(h,'messages').length,0);assert.equal(entities(h,'rawObjects').length,1);
 h.afterRequest=null;h.restart();await importChatgptSource(runtime,{runId,sourceKey:'file'});assert.equal(entities(h,'threads').length,1);assert.equal(entities(h,'messages').length,3);assert.equal(h.db.selectValue('PRAGMA integrity_check'),'ok');await h.client.close();
});

test('lost raw publication, message-stage, final publication and work acknowledgments recover exact identities',async()=>{
 for(const target of ['commit','stageImportRecords:message','finalizeNormalizedImport','importWorkResolve:source','importGroupFinish'] as const){
  const h=new StorageHarness(),runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false};const runId=randomUUID();await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:target,recordedAt:now});
  let lost=false;h.afterRequest=(operation,args)=>{const value=args as {records?:{collection:string}[];key?:string};const match=target==='stageImportRecords:message'?operation==='stageImportRecords'&&value.records?.some(r=>r.collection==='messages'):target==='importWorkResolve:source'?operation==='importWorkResolve'&&value.key==='bytes':operation===target;if(match&&!lost){lost=true;throw new Error('lost acknowledgement');}};
  await assert.rejects(importChatgptSource(runtime,{runId,sourceKey:'file',source:source(fixture())}),/lost acknowledgement/);assert.ok(lost,target);h.afterRequest=null;h.restart();
  await importChatgptSource(runtime,{runId,sourceKey:'file'});assert.equal(entities(h,'threads').length,1,target);assert.equal(entities(h,'messages').length,3,target);assert.equal(entities(h,'rawObjects').length,1,target);assert.equal(h.readers.size,0);await h.client.close();
 }
});

test('interrupted upload can restart from selected bytes but cannot pretend partial upload is resumable without them',async()=>{
 const h=new StorageHarness(),runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false};const runId=randomUUID();await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:'upload',recordedAt:now});
 let lost=false;h.afterRequest=(operation)=>{if(operation==='beginBlobTransfer'&&!lost){lost=true;throw new Error('lost transfer allocation');}};
 await assert.rejects(importChatgptSource(runtime,{runId,sourceKey:'file',source:source(fixture())}),/lost transfer/);h.afterRequest=null;h.restart();
 await assert.rejects(importChatgptSource(runtime,{runId,sourceKey:'file'}),/original source/);
 await importChatgptSource(runtime,{runId,sourceKey:'file',source:source(fixture())});assert.equal(entities(h,'threads').length,1);assert.equal(h.stages.size,1,'interrupted stage was discarded');await h.client.close();
});

test('Claude observed export normalizes object text, explicit branches and legacy text while recording inferred flat order',async()=>{
 const {beginClaudeImport,importClaudeSource}=await import('../src/index.ts');const h=new StorageHarness(),runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false};const runId=randomUUID();
 await beginClaudeImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:'claude-one',recordedAt:now});
 const input=[{uuid:'claude-conversation',name:'Claude source',created_at:'2026-01-01T00:00:00.000Z',chat_messages:[
  {uuid:'c2',sender:'assistant',created_at:'2026-01-01T00:00:02Z',parent_message_uuid:'c1',text:'redundant fallback',content:[{text:'Claude 😀 '.repeat(3000),type:'text'},{type:'thinking',thinking:'raw-only synthetic private field'}]},
  {uuid:'c1',sender:'human',created_at:'2026-01-01T00:00:01Z',parent_message_uuid:null,text:'legacy user text',attachments:[{file_name:'missing.txt'}]},
  {uuid:'c3',sender:'assistant',created_at:'2026-01-01T00:00:03Z',text:'flat legacy answer'}
 ]}];
 await importClaudeSource(runtime,{runId,sourceKey:'claude-file',source:source(input)});const messages=entities(h,'messages') as unknown as Message[];assert.equal(messages.length,3);const user=messages.find(m=>m.role==='user')!;assert.equal(messages.filter(m=>m.parentId===user.id).length,2);
 const texts:ContentPart[]=[];for(const message of messages)texts.push(...h.repository.readMessageParts({messageId:message.id,page}).items as unknown as ContentPart[]);
 assert.ok(texts.some(part=>part.kind==='Text'&&part.data.text==='legacy user text'));assert.ok(texts.some(part=>part.kind==='Text'&&part.data.text==='flat legacy answer'));assert.ok(texts.some(part=>part.kind==='Text'&&part.data.textBlob));assert.ok(texts.some(part=>part.kind==='ProviderArtifact'));
 assert.ok(entities(h,'events').some(value=>(value as {details:{code:string}}).details.code==='parent_inferred_from_export_order'));assert.equal((entities(h,'threadStates')[0] as unknown as ThreadState).activeLeafMessageId,null,'absent active-branch fact is not fabricated');await h.client.close();
});

test('malformed message records are skipped with a warning while descendants attach to the nearest valid ancestor and raw source is retained',async()=>{
 const h=new StorageHarness();
 const input=[{conversation_id:'thread-malformed',title:'Malformed record',create_time:1700000000,current_node:'answer',mapping:{
  root:{parent:null,message:null},
  question:{parent:'root',message:message('question-native','user',['Question before a broken record'])},
  broken:{parent:'question',message:{id:'broken-native',author:{role:'widget-bot'},create_time:1700000001,content:{content_type:'text',parts:['This record has an unsupported author role']}}},
  answer:{parent:'broken',message:message('answer-native','assistant',['Answer after the broken record'])},
 }}];
 const result=await run(h,input);assert.equal(result.result.state,'complete');
 const messages=entities(h,'messages') as unknown as Message[];assert.equal(messages.length,2);
 const user=messages.find(m=>m.role==='user')!,answer=messages.find(m=>m.role==='assistant')!;assert.equal(answer.parentId,user.id,'descendant attaches to the nearest valid ancestor');
 const texts:ContentPart[]=[];for(const m of messages)texts.push(...h.repository.readMessageParts({messageId:m.id,page}).items as unknown as ContentPart[]);
 assert.ok(!texts.some(part=>part.kind==='Text'&&part.data.text==='This record has an unsupported author role'),'skipped record contributes no parts');
 const warning=entities(h,'events').find(value=>(value as {details:{code:string}}).details.code==='malformed_record_skipped') as {details:{reason:string;role:string|null;locator:string}}|undefined;
 assert.ok(warning);assert.equal(warning!.details.reason,'unsupported_or_missing_role');assert.equal(warning!.details.role,'widget-bot');assert.ok(warning!.details.locator.length>0);
 assert.equal(entities(h,'rawObjects').length,1);assert.equal(entities(h,'threads').length,1);assert.equal((entities(h,'threadStates')[0] as unknown as ThreadState).activeLeafMessageId,answer.id);
 assert.equal(h.db.selectValue('PRAGMA integrity_check'),'ok');await h.client.close();
});

test('missing native thread ID uses an explicit heuristic fingerprint that excludes a changed title',async()=>{
 const h=new StorageHarness();const original=fixture() as {conversation_id?:string;title:string}[];delete original[0]!.conversation_id;await run(h,original);original[0]!.title='Renamed outside Quixi';await run(h,original);
 assert.equal(entities(h,'threads').length,1);assert.equal(entities(h,'messages').length,3);assert.ok(entities(h,'events').some(value=>(value as {details:{code:string}}).details.code==='heuristic_thread_identity'));
 const sources=entities(h,'importSources') as {sourceThreadId:string|null}[];assert.ok(sources.every(item=>item.sourceThreadId===null),'heuristic key must not masquerade as native provider ID');await h.client.close();
});

test('ZIP import captures the original container, imports numbered JSON shards and resolves exact-path assets',async()=>{
 const {importProviderZip,exportImportReport}=await import('../src/index.ts');const {makeZip,zipSource}=await import('./zip-fixture.ts');
 const h=new StorageHarness(),runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false},runId=randomUUID();await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:'zip',recordedAt:now});
 const asset=Uint8Array.of(37,80,68,70,10),bytes=makeZip([{name:'missing.pdf',bytes:asset},{name:'conversations-000.json',bytes:new TextEncoder().encode(JSON.stringify(fixture()))},{name:'export_manifest.json',bytes:new TextEncoder().encode('{"version":1,"files":[{"name":"conversations.json","shards":[{"name":"conversations-000.json"}]}]}')}],true);
 const result=await importProviderZip(runtime,{runId,sourceKey:'original-zip',source:zipSource(bytes),maxEntryBytes:2_000_000});assert.equal(result.state,'complete');assert.equal(entities(h,'threads').length,1);assert.equal(entities(h,'rawObjects').length,2,'container and extracted source both retained');
 const attachment=entities(h,'attachments')[0] as {availability:string;blobSha256:string};assert.equal(attachment.availability,'available');assert.deepEqual(h.published.get(attachment.blobSha256)!.bytes,asset);
 const hash=createHash('sha256').update(bytes).digest('hex');assert.deepEqual(h.published.get(hash)!.bytes,Uint8Array.from(bytes));
 const lines:unknown[]=[];for await(const chunk of exportImportReport(runtime,{runId})){assert.ok(chunk.length<1_048_576);lines.push(JSON.parse(new TextDecoder().decode(chunk)));}assert.ok(lines.some(value=>(value as {type:string}).type==='import-warning'));
 h.restart();assert.equal((await importProviderZip(runtime,{runId,sourceKey:'original-zip',maxEntryBytes:2_000_000})).state,'complete');assert.equal(h.readers.size,0);await h.client.close();
});

test('a later export resolves missing attachment bytes without duplicating a thread or rewriting sealed parts',async()=>{
 const {importProviderZip}=await import('../src/index.ts');const {makeZip,zipSource}=await import('./zip-fixture.ts');const h=new StorageHarness(),input=fixture();await run(h,input,'later-assets');
 const before=entities(h,'parts'),attachmentBefore=entities(h,'attachments')[0] as {id:string;availability:string};assert.equal(attachmentBefore.availability,'missing');
 const runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false},runId=randomUUID();await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:'later-assets',recordedAt:now});
 const bytes=makeZip([{name:'conversations.json',bytes:new TextEncoder().encode(JSON.stringify(input))},{name:'missing.pdf',bytes:Uint8Array.of(1,2,3)}]);await importProviderZip(runtime,{runId,sourceKey:'later',source:zipSource(bytes),maxEntryBytes:2_000_000});
 assert.equal(entities(h,'threads').length,1);assert.equal(entities(h,'messages').length,3);assert.deepEqual(entities(h,'parts'),before);const attachment=entities(h,'attachments')[0] as {id:string;availability:string};assert.equal(attachment.id,attachmentBefore.id);assert.equal(attachment.availability,'available');await h.client.close();
});

test('pause retains hidden work and resumes without original source; malformed parent graphs retain raw but expose no partial thread',async()=>{
 const {setImportRunState}=await import('../src/index.ts');
 const h=new StorageHarness();let cancelled=false;const runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>cancelled},runId=randomUUID();
 await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:'pause',recordedAt:now});h.afterRequest=(operation)=>{if(operation==='stageImportRecords')cancelled=true;};
 await assert.rejects(importChatgptSource(runtime,{runId,sourceKey:'file',source:source(fixture())}),/paused/);assert.equal(entities(h,'threads').length,0);
 await setImportRunState(runtime,{operationId:randomUUID(),runId,state:'paused',summary:{reason:'user_pause'}});h.afterRequest=null;h.restart();cancelled=false;await setImportRunState(runtime,{operationId:randomUUID(),runId,state:'running',summary:{}});await importChatgptSource(runtime,{runId,sourceKey:'file'});assert.equal(entities(h,'threads').length,1);await h.client.close();
 const bad=new StorageHarness();await assert.rejects(run(bad,[{id:'bad',mapping:{a:{parent:'b',message:message('a','user',['one'])},b:{parent:'a',message:message('b','assistant',['two'])}}}]),/cyclic/);assert.equal(entities(bad,'threads').length,0);assert.equal(entities(bad,'messages').length,0);assert.equal(entities(bad,'rawObjects').length,1);await bad.client.close();
});

test('large reverse-ordered export generator imports through bounded controls without a JS thread graph',async()=>{
 const {largeChatgptSource}=await import('./large-source.ts');const h=new StorageHarness(),runtime:ImportRuntime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>now,cancelled:()=>false},runId=randomUUID();
 await beginChatgptImport(runtime,{operationId:randomUUID(),runId,workspaceId:randomUUID(),accountScope:'large',recordedAt:now});
 const source=largeChatgptSource(2000);await importChatgptSource(runtime,{runId,sourceKey:'large',source});
 assert.equal(h.db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='messages'"),2000);assert.ok(h.maxRequestBytes<1_048_576);assert.ok(h.maxReaders<=3);assert.equal(h.db.selectValue('PRAGMA integrity_check'),'ok');await h.client.close();
});

test('observed image pointers remain typed missing attachments and invalid Unicode stays lossless raw with a warning',async()=>{
 const h=new StorageHarness();const input=[{conversation_id:'image-text',title:'Bounded display '.repeat(1000),mapping:{image:{parent:null,message:message('native-image','user',[{content_type:'image_asset_pointer',asset_pointer:'sediment://original-synthetic-image',size_bytes:12345,width:80,height:80},'unpaired\ud800'])}}}];await run(h,input);
 const parts=entities(h,'parts') as unknown as ContentPart[];assert.equal(parts[0]!.kind==='Image'||parts[1]!.kind==='Image',true);assert.ok(parts.some(part=>part.kind==='ProviderArtifact'&&part.data.providerKind==='unpaired-utf16-source-text'));
 const warnings=entities(h,'events') as {details:{code:string}}[];assert.ok(warnings.some(event=>event.details.code==='source_text_not_valid_unicode'));assert.ok(warnings.some(event=>event.details.code==='metadata_display_truncated'));assert.equal((entities(h,'attachments')[0] as {availability:string}).availability,'missing');
 const raw=entities(h,'rawObjects')[0] as {sha256:string};assert.equal(new TextDecoder().decode(h.published.get(raw.sha256)!.bytes),JSON.stringify(input));await h.client.close();
});
