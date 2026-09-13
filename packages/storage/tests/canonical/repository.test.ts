import { ViewRepository } from '../../src/worker/views.ts';
import { SearchRepository } from '../../src/worker/search/index.ts';
import { loadSource } from '../../src/worker/search/sources.ts';
import { summarySourceInfo, summaryTextDigest } from '../../src/worker/canonical/summary-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import initialize from '../../sqlite/dist/sqlite3.mjs';
import {CanonicalRepository} from '../../src/worker/canonical/index.ts';
import {CANONICAL_MIGRATIONS} from '../../migrations/index.ts';
import type {CanonicalSqlite, CanonicalRepositoryOptions} from '../../src/worker/canonical/index.ts';
import {contextSummary,SUMMARY_INSTRUCTION,assertHistory,createMessageEdit,planBranchTombstone} from '@quixi/core/model';
import type {CanonicalHistory,Message,ContentPart,ImportSource,Generation,SummaryProposal,ContextSnapshot} from '@quixi/core/model';
import {MUTATION_KINDS} from '@quixi/core/contracts';
import type {CanonicalMutation,MutationBatch,MutationKind,MutationPayloads} from '@quixi/core/contracts';

const wasm=await readFile(new URL('../../sqlite/dist/sqlite3.wasm',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../../sqlite/artifacts.json',import.meta.url),'utf8')) as {artifacts:{'sqlite3.wasm':{sha256:string}}};
assert.equal(createHash('sha256').update(wasm).digest('hex'),manifest.artifacts['sqlite3.wasm'].sha256);
(globalThis as typeof globalThis & {sqlite3ApiConfig:unknown}).sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};
const initOptions={instantiateWasm:async(imports:WebAssembly.Imports,success:(instance:WebAssembly.Instance,module:WebAssembly.Module)=>void)=>{const {instance,module}=await WebAssembly.instantiate(wasm,imports);success(instance,module);},print:()=>{},printErr:()=>{}};
const sqlite=await initialize(initOptions) as {oo1:{DB:new(filename:string,flags:string)=>CanonicalSqlite&{close():void}}};
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let serial=100_000;const nextId=()=>id(serial++);const time=1788870000000;
const fixtureRoot=new URL('../../../../tests/fixtures/canonical/',import.meta.url);
async function fixture(name='native-branches'):Promise<CanonicalHistory>{const value:unknown=JSON.parse(await readFile(new URL(`${name}.history.json`,fixtureRoot),'utf8'));assertHistory(value);return value;}
const mutation=<K extends MutationKind>(kind:K,payload:MutationPayloads[K],recordedAt=time):Extract<CanonicalMutation,{kind:K}>=>({version:1,operationId:nextId(),kind,recordedAt,payload}) as Extract<CanonicalMutation,{kind:K}>;
function batch(mutations:CanonicalMutation[]):MutationBatch{return{transactionId:nextId(),expectedThreadRevisions:[],stagedBlobIds:[],mutations};}
function open(options:Partial<CanonicalRepositoryOptions>={}){const filename=`/canonical-${serial++}.sqlite3`;const db=new sqlite.oo1.DB(filename,'c');const repository=new CanonicalRepository(db,{assertBlobAvailable:()=>{},...options});repository.migrate();return {db,repository,filename};}
function rows(db:CanonicalSqlite,sql:string){return db.exec({sql,rowMode:'object',returnValue:'resultRows'}) as Record<string,string|number>[];}
function commit(repo:CanonicalRepository,command:CanonicalMutation){return repo.commit(batch([command]));}
async function seed(repo:CanonicalRepository,name='native-branches'){
  const h=await fixture(name);
  const source:ImportSource=h.importSources[0]??{id:nextId(),provider:'fixture',method:'native_response',sourceThreadId:null,sourceUrl:null,importerName:'test-seed',importerVersion:'1',sourceFormatVersion:null,sourceFingerprint:null,importedAt:time};
  commit(repo,mutation('RegisterImportSource',{source,rawObjects:h.rawObjects}));
  for(const thread of h.threads)commit(repo,mutation('CreateThread',{thread,context:h.contexts.find(item=>item.threadId===thread.id&&item.version===1)!,state:{...h.threadStates.find(item=>item.threadId===thread.id)!,activeLeafMessageId:null}}));
  for(const attachment of h.attachments)commit(repo,mutation('RegisterAttachment',{attachment}));
  for(const document of h.documents)commit(repo,mutation('RegisterDocument',{document}));
  for(const message of h.messages){
    const parts=h.parts.filter(part=>part.messageId===message.id);
    if(message.generationId)commit(repo,mutation('CreateGeneration',{generation:h.generations.find(item=>item.id===message.generationId)!,output:message,parts}));
    else if(message.editedFromMessageId)commit(repo,mutation('EditMessage',{previousId:message.editedFromMessageId,message,parts},message.recordedAt));
    else commit(repo,mutation('CreateMessage',{message,parts}));
  }
  for(const event of h.events)commit(repo,mutation('CreateThreadEvent',{event}));
  if(h.provenance.length||h.sourceIdentities.length)commit(repo,mutation('AttachProvenance',{provenance:h.provenance,identities:h.sourceIdentities}));
  for(const state of h.threadStates)commit(repo,mutation('SetActiveBranch',{threadId:state.threadId,value:state.activeLeafMessageId}));
  return h;
}


function prepareSummary(db:CanonicalSqlite,repo:CanonicalRepository,status:Generation['status']='complete',outputParts?:ContentPart[],cutoff=id(102)) {
  const state=repo.get('threadStates',id(10))!,source=repo.get('contexts',state.contextSnapshotId)!;
  const request:ContextSnapshot={...source,id:nextId(),previousId:source.id,version:source.version+1,systemPrompt:SUMMARY_INSTRUCTION};
  delete request.compaction;
  const input={id:nextId(),availability:'available' as const,sha256:summaryTextDigest('{}'),byteLength:2,mediaType:'application/vnd.quixi.summary-input+json',storageRef:'sha256:'+summaryTextDigest('{}')};
  repo.commit(batch([mutation('RegisterRawObject',{rawObject:input}),mutation('CreateContextSnapshot',{context:request,select:false})]));
  const generation:Generation={...repo.get('generations',id(200))!,id:nextId(),purpose:'context_summary',parentMessageId:cutoff,outputMessageId:nextId(),contextSnapshotId:request.id,status,completedAt:status==='streaming'?null:time};
  const parts:ContentPart[]=outputParts?.map((part,order)=>({...part,id:nextId(),messageId:generation.outputMessageId,order}))??[{id:nextId(),messageId:generation.outputMessageId,order:0,kind:'Text',data:{text:'Proposed summary with exact unresolved constraint.'}}];
  const output:Message={...repo.get('messages',id(101))!,id:generation.outputMessageId,parentId:generation.parentMessageId,generationId:generation.id,sealed:status!=='streaming',partCount:parts.length};
  const info=summarySourceInfo(db,source.id,generation.parentMessageId);
  const proposal:SummaryProposal={version:1,id:nextId(),threadId:state.threadId,recordedAt:time,generationId:generation.id,sourceContextSnapshotId:source.id,requestContextSnapshotId:request.id,throughMessageId:generation.parentMessageId,sourceLeafMessageId:state.activeLeafMessageId!,sourceThreadRevision:state.revision,baseSummaryProposalId:contextSummary(source)?.proposalId??null,baseSummaryContextId:contextSummary(source)?source.id:null,...info,inputRawObjectId:input.id,inputSha256:input.sha256,inputByteLength:input.byteLength,promptTemplateVersion:1};
  return {source,request,input,generation,output,parts,proposal,commands:[mutation('CreateGeneration',{generation,output,parts}),mutation('RegisterSummaryProposal',{proposal})]};
}
function summaryApply(f:ReturnType<typeof prepareSummary>,reviewedText='Human-reviewed correction: keep the unresolved constraint.'){
  const context:ContextSnapshot={...f.source,id:nextId(),previousId:f.source.id,version:f.source.version+1,recordedAt:time,compaction:{version:2,excludedPartIds:f.source.compaction?.excludedPartIds??[],summary:{proposalId:f.proposal.id,throughMessageId:f.proposal.throughMessageId,reviewedText,reviewedTextSha256:summaryTextDigest(reviewedText)}}};
  const event={id:nextId(),threadId:f.proposal.threadId,type:'ContextCompaction' as const,createdAt:time,recordedAt:time,messageId:f.proposal.throughMessageId,generationId:f.generation.id,details:{action:'apply_summary',contextSnapshotId:context.id,proposalId:f.proposal.id}};
  return {context,event,batch:{...batch([mutation('CreateThreadEvent',{event}),mutation('CreateContextSnapshot',{context,select:true})]),expectedThreadRevisions:[{threadId:f.proposal.threadId,revision:f.proposal.sourceThreadRevision}]}};
}

test('pinned WASM SQL retains provider branches/provenance/raw references across close/reopen',async()=>{
  for(const name of ['native-branches','claude-compliance','chatgpt-conversations']){
    const {db,repository,filename}=open();const h=await seed(repository,name);
    assert.equal(db.selectValue('PRAGMA integrity_check'),'ok');assert.equal(db.selectValue('PRAGMA foreign_keys'),1);
    assert.equal(rows(db,'PRAGMA foreign_key_check').length,0);db.close();
    const reopened=new sqlite.oo1.DB(filename,'w');const repo=new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}});repo.migrate();
    for(const message of h.messages)assert.deepEqual(repo.get('messages',message.id),message);
    for(const part of h.parts)assert.deepEqual(repo.get('parts',part.id),part);
    for(const provenance of h.provenance)assert.deepEqual(repo.get('provenance',provenance.id),provenance);
    assert.equal(repo.get('threadStates',h.threads[0]!.id)!.activeLeafMessageId,h.threadStates[0]!.activeLeafMessageId);reopened.close();
  }
});

test('operation and transaction retries preserve results and reject payload conflicts before revisions',async()=>{
  const {db,repository}=open();await seed(repository);const revision=repository.get('threadStates',id(10))!.revision;
  const command=mutation('SetTitle',{threadId:id(10),value:'Stable title'});const request={...batch([command]),expectedThreadRevisions:[{threadId:id(10),revision}]};
  const first=repository.commit(request);assert.deepEqual(repository.commit(request),first);
  const replay=repository.commit({...request,transactionId:nextId()});assert.equal(replay.operations[0]!.outcome,'already_committed');assert.equal(repository.get('threadStates',id(10))!.revision,revision+1);
  assert.throws(()=>repository.commit({...request,mutations:[{...command,payload:{threadId:id(10),value:'Different'}}]}),/Transaction ID/);
  assert.throws(()=>repository.commit({...request,transactionId:nextId(),mutations:[{...command,payload:{threadId:id(10),value:'Different'}}]}),/Operation ID/);
  assert.throws(()=>repository.commit({...request,transactionId:nextId(),mutations:[mutation('SetPinned',{threadId:id(10),value:true})]}),/revision/);
  assert.equal(repository.operationStatus(command.operationId).status,'committed');db.close();
});

test('injected precommit failure and a later invalid command roll back records, edges, operations and transaction result',async()=>{
  let inject=false;const {db,repository}=open({beforeCommit:()=>{if(inject)throw new Error('injected precommit');}});await seed(repository);
  const before=String(db.selectValue("SELECT payload FROM quixi_records WHERE collection='threadStates'"));const count=db.selectValue('SELECT count(*) FROM quixi_sync_ops');
  const request=batch([mutation('SetTitle',{threadId:id(10),value:'must roll back'})]);inject=true;assert.throws(()=>repository.commit(request),/injected/);inject=false;
  assert.equal(db.selectValue("SELECT payload FROM quixi_records WHERE collection='threadStates'"),before);assert.equal(db.selectValue('SELECT count(*) FROM quixi_sync_ops'),count);assert.equal(repository.operationStatus(request.mutations[0]!.operationId).status,'not_found');
  assert.throws(()=>repository.commit(batch([mutation('SetTitle',{threadId:id(10),value:'also roll back'}),mutation('SetActiveBranch',{threadId:id(10),value:nextId()})])));
  assert.equal(db.selectValue("SELECT payload FROM quixi_records WHERE collection='threadStates'"),before);assert.equal(db.selectValue('SELECT count(*) FROM quixi_sync_ops'),count);assert.equal(rows(db,'PRAGMA foreign_key_check').length,0);db.close();
});

test('every canonical kind persists actual record effects and exactly one matching sync operation',async()=>{
  const {db,repository}=open();const history=await seed(repository);
  const editPart:ContentPart={id:nextId(),messageId:nextId(),order:0,kind:'Text',data:{text:'Edited original synthetic answer'}};
  const edited=createMessageEdit(history,id(102),editPart.messageId,[editPart],time).messages.at(-1)!;
  for(const command of [
    mutation('EditMessage',{previousId:id(102),message:edited,parts:[editPart]}),
    mutation('AppendGenerationOutput',{generationId:id(206),sequence:1,newParts:[],textAppend:{partId:id(1110),text:' delta'}}),
    mutation('AttachContent',{messageId:id(110),sequence:2,parts:[{id:nextId(),messageId:id(110),order:1,kind:'File',data:{attachmentId:id(400),description:null}}]}),
    mutation('CompleteGeneration',{generationId:id(206),status:'stopped',completedAt:time,tokensIn:null,tokensOut:null,cachedTokens:null,estimatedCost:null,reportedCost:null,rawResponseId:null}),
    mutation('RegisterRawObject',{rawObject:{...history.rawObjects[0]!,id:nextId()}}),
    mutation('SetTitle',{threadId:id(10),value:'Renamed'}),mutation('SetTags',{threadId:id(10),value:['test']}),mutation('SetPinned',{threadId:id(10),value:true}),mutation('SetArchived',{threadId:id(10),value:true}),mutation('SetRoutingProfile',{threadId:id(10),value:{route:'fixture'}}),
    mutation('CreateContextSnapshot',{context:{...history.contexts[0]!,id:nextId(),previousId:id(11),version:2,systemPrompt:'Revised',recordedAt:time},select:true}),
    mutation('SetDocumentTitle',{documentId:id(450),value:'Renamed document'}),mutation('ResolveAttachment',{attachmentId:id(400),blobSha256:'a'.repeat(64),sizeBytes:3,provenance:[]}),
  ])commit(repository,command);
  commit(repository,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));
  repository.commit(batch(prepareSummary(db,repository).commands));
  // Separate branches and thread scopes remain bounded operations.
  const state=repository.get('threadStates',id(10))!;
  commit(repository,mutation('TombstoneBranch',{tombstone:{id:nextId(),threadId:id(10),rootMessageId:id(103),createdAt:time,reason:null},state:{...state,activeLeafMessageId:id(102),revision:state.revision+1}}));
  const next=repository.get('threadStates',id(10))!;
  commit(repository,mutation('TombstoneThread',{tombstone:{id:nextId(),threadId:id(10),rootMessageId:null,createdAt:time,reason:null},state:{...next,activeLeafMessageId:null,revision:next.revision+1}}));
  // Import identities/provenance exercise their separate command without relying on private inserts.
  await seed(repository,'claude-compliance');
  assert.deepEqual(rows(db,'SELECT DISTINCT kind FROM quixi_sync_ops ORDER BY kind').map(row=>row.kind),[...MUTATION_KINDS].sort());
  for(const row of rows(db,'SELECT affects FROM quixi_sync_ops')){
    const effects=JSON.parse(String(row.affects)) as {kind:string;id:string}[];assert.ok(effects.length);
    for(const effect of effects)assert.ok(db.selectValue('SELECT count(*) FROM quixi_records WHERE id=?',[effect.id]));
  }
  assert.equal(db.selectValue('PRAGMA integrity_check'),'ok');db.close();
});

test('provider scoped identity uniqueness rejects overlapping imports without partial observations',async()=>{
  const {db,repository}=open();const history=await seed(repository,'claude-compliance');const source=history.sourceIdentities[0]!;
  assert.equal(repository.resolveSourceIdentity(source),source.quixiId);
  const request=batch([mutation('AttachProvenance',{identities:[{...source,id:nextId()}],provenance:[{...history.provenance[0]!,id:nextId()}]})]);
  const before=db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='provenance'");assert.throws(()=>repository.commit(request));
  assert.equal(db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='provenance'"),before);assert.equal(repository.operationStatus(request.mutations[0]!.operationId).status,'not_found');db.close();
});

test('ordered parts and keyset entity pages obey byte/item budgets and scope cursors',async()=>{
  const {db,repository}=open();const h=await seed(repository);const seen:string[]=[];let cursor:string|null=null;
  do{const page=repository.readEntities({collection:'messages',threadId:id(10),page:{maxItems:2,maxBytes:1000,cursor}});assert.ok(page.items.length<=2);assert.equal(page.bytes,Buffer.byteLength(JSON.stringify(page.items)));seen.push(...page.items.map(value=>(value as unknown as Message).id));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(seen,h.messages.map(message=>message.id).sort());
  const first=repository.readMessageParts({messageId:id(103),page:{maxItems:1,maxBytes:1000,cursor:null}});assert.ok(first.nextCursor);
  const second=repository.readMessageParts({messageId:id(103),page:{maxItems:1,maxBytes:1000,cursor:first.nextCursor}});assert.equal((second.items[0] as unknown as ContentPart).order,1);assert.equal(second.nextCursor,null);
  assert.throws(()=>repository.readMessageParts({messageId:id(100),page:{maxItems:1,maxBytes:1000,cursor:first.nextCursor}}));
  assert.throws(()=>repository.readEntities({collection:'messages',threadId:id(10),page:{maxItems:1,maxBytes:2,cursor:null}}));db.close();
});

test('only confirmed lost producers recover as partial; ordinary reopen preserves live streaming',async()=>{
  const {db,repository,filename}=open();await seed(repository);const prefix=repository.get('parts',id(1110));db.close();
  const reopened=new sqlite.oo1.DB(filename,'w');const repo=new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}});repo.migrate();
  assert.equal(repo.get('generations',id(206))!.status,'streaming');assert.deepEqual(repo.recoverInterrupted({generationIds:[],nextId,now:()=>time}),{recovered:0});
  assert.deepEqual(repo.recoverInterrupted({generationIds:[id(206)],nextId,now:()=>time}),{recovered:1});assert.equal(repo.get('generations',id(206))!.status,'partial');assert.equal(repo.get('messages',id(110))!.sealed,true);assert.deepEqual(repo.get('parts',id(1110)),prefix);
  assert.deepEqual(repo.recoverInterrupted({generationIds:[id(206)],nextId,now:()=>time}),{recovered:0});
  assert.throws(()=>commit(repo,mutation('AppendGenerationOutput',{generationId:id(206),sequence:1,newParts:[],textAppend:{partId:id(1110),text:'late'}})));reopened.close();
});

test('migration upgrades and injected failures preserve the previous valid schema and data',()=>{
  const db=new sqlite.oo1.DB(`/migration-${serial++}.sqlite3`,'c');const repository=new CanonicalRepository(db,{assertBlobAvailable:()=>{}});repository.migrate(1);
  db.exec("CREATE TABLE retained_probe(value TEXT); INSERT INTO retained_probe VALUES('retained')");
  let broken=true;const wrapper:CanonicalSqlite={selectValue:(sql,bind)=>db.selectValue(sql,bind),exec:options=>{if(broken&&typeof options==='string'&&options.includes('CREATE UNIQUE INDEX quixi_generation_output')){db.exec('CREATE TABLE half_migration(id INTEGER)');throw new Error('injected upgrade failure');}return db.exec(options);}};
  const upgraded=new CanonicalRepository(wrapper,{assertBlobAvailable:()=>{}});assert.throws(()=>upgraded.migrate(),/rolled back/);
  assert.equal(db.selectValue('SELECT max(version) FROM quixi_schema_migrations'),1);assert.equal(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name='half_migration'"),0);assert.equal(db.selectValue('SELECT value FROM retained_probe'),'retained');
  broken=false;assert.equal(upgraded.migrate(),CANONICAL_MIGRATIONS.at(-1)!.version);
  db.exec({sql:'INSERT INTO quixi_blob_catalog(sha256,byte_length,utf8_verified) VALUES(?,?,?)',bind:['a'.repeat(64),3,1]});
  assert.deepEqual(rows(db,'SELECT availability,verification_epoch FROM quixi_blob_catalog').map(row=>({...row})),[{availability:'verified',verification_epoch:''}]);
  db.exec("UPDATE quixi_blob_catalog SET availability='unverified',verification_epoch='review-owner'");
  assert.equal(db.selectValue('SELECT availability FROM quixi_blob_catalog'),'unverified');
  assert.throws(()=>db.exec("UPDATE quixi_blob_catalog SET availability='invalid'"),/CHECK/);
  db.exec("UPDATE quixi_schema_migrations SET checksum='changed' WHERE version=1");assert.throws(()=>upgraded.migrate(),/differs/);db.close();
});

test('migration 8 preserves append prefixes across transport records and closes text at semantic barriers',async()=>{
  for(const barrierKind of ['Text','ProviderArtifact'] as const){
    const {db,repository}=open();const history=await seed(repository);const rawObjectId=history.rawObjects[0]!.id;
    const evidence:ContentPart[]=['quixi.provider.raw-stream-chunk','quixi.provider.response-manifest'].map((providerKind,index)=>({id:nextId(),messageId:id(110),order:1+index,kind:'ProviderArtifact',data:{providerKind,rawObjectId,locator:''}}));
    commit(repository,mutation('AppendGenerationOutput',{generationId:id(206),sequence:1,newParts:evidence,textAppend:null}));
    const before=repository.get('parts',id(1110))!;
    const request=batch([mutation('AppendGenerationOutput',{generationId:id(206),sequence:2,newParts:[],textAppend:{partId:id(1110),text:'\u0000🙂 continued'}})]);
    const receipt=repository.commit(request);assert.deepEqual(repository.commit(request),receipt);
    for(const part of evidence)assert.deepEqual(repository.get('parts',part.id),part);
    const extended=repository.get('parts',id(1110))!;
    assert.deepEqual(extended.data,{text:(before.data as {text:string}).text+'\u0000🙂 continued'});
    const writeText=(text:string)=>db.exec({sql:"UPDATE quixi_records SET payload=? WHERE collection='parts' AND id=?",bind:[JSON.stringify({...extended,data:{text}}),extended.id]});
    // The trigger compares UTF-8 bytes, including everything following an embedded NUL.
    assert.throws(()=>writeText((before.data as {text:string}).text+'\u0000rewritten'),/append its prefix/);
    const text=(extended.data as {text:string}).text;
    writeText(text+' SQL append');
    assert.throws(()=>db.exec({sql:"UPDATE quixi_records SET payload=? WHERE collection='parts' AND id=?",bind:[JSON.stringify({...evidence[0],data:{providerKind:'changed',rawObjectId,locator:''}}),evidence[0]!.id]}),/append its prefix/);
    const barrier:ContentPart=barrierKind==='Text'?{id:nextId(),messageId:id(110),order:3,kind:'Text',data:{text:'next'}}:{id:nextId(),messageId:id(110),order:3,kind:'ProviderArtifact',data:{providerKind:'unknown-part',rawObjectId,locator:''}};
    commit(repository,mutation('AppendGenerationOutput',{generationId:id(206),sequence:3,newParts:[barrier],textAppend:null}));
    const forbidden=mutation('AppendGenerationOutput',{generationId:id(206),sequence:4,newParts:[],textAppend:{partId:id(1110),text:' late'}});
    assert.throws(()=>commit(repository,forbidden),/last unfinished semantic/);
    assert.equal(repository.operationStatus(forbidden.operationId).status,'not_found');
    assert.throws(()=>writeText(text+' SQL append late'),/append its prefix/);
    commit(repository,mutation('CompleteGeneration',{generationId:id(206),status:'complete',completedAt:time,tokensIn:null,tokensOut:null,cachedTokens:null,estimatedCost:null,reportedCost:null,rawResponseId:null}));
    if(barrier.kind==='Text')assert.throws(()=>db.exec({sql:"UPDATE quixi_records SET payload=? WHERE collection='parts' AND id=?",bind:[JSON.stringify({...barrier,data:{text:'next late'}}),barrier.id]}),/append its prefix/);
    db.close();
  }
});

test('schema 7 upgrade retains canonical history and old migration identities before enabling streaming text',async()=>{
  const db=new sqlite.oo1.DB(`/upgrade-seven-${serial++}.sqlite3`,'c');
  const repository=new CanonicalRepository(db,{assertBlobAvailable:()=>{}});repository.migrate(7);
  const history=await seed(repository);
  const evidence:ContentPart={id:nextId(),messageId:id(110),order:1,kind:'ProviderArtifact',data:{providerKind:'quixi.provider.raw-stream-chunk',rawObjectId:history.rawObjects[0]!.id,locator:''}};
  commit(repository,mutation('AppendGenerationOutput',{generationId:id(206),sequence:1,newParts:[evidence],textAppend:null}));
  const before=rows(db,'SELECT collection,id,payload FROM quixi_records ORDER BY collection,id');
  const ledger=rows(db,'SELECT * FROM quixi_schema_migrations ORDER BY version');
  const command=mutation('AppendGenerationOutput',{generationId:id(206),sequence:2,newParts:[],textAppend:{partId:id(1110),text:' continuation'}});
  assert.throws(()=>commit(repository,command),/append its prefix/);
  assert.equal(repository.migrate(8),8);
  assert.deepEqual(rows(db,'SELECT collection,id,payload FROM quixi_records ORDER BY collection,id'),before);
  assert.deepEqual(rows(db,'SELECT * FROM quixi_schema_migrations WHERE version<=7 ORDER BY version'),ledger);
  commit(repository,command);
  assert.equal(repository.get('generations',id(206))!.lastSequence,2);
  db.close();
});

test('long text references verified blobs and streaming grows ordered parts without growing a message manifest',async()=>{
  const checked:{digest:string;size:number;stages:readonly string[];encoding?:'utf-8'}[]=[];
  const {db,repository}=open({assertBlobAvailable:(digest,size,stages,encoding)=>{checked.push({digest,size,stages,...(encoding?{encoding}:{})});if(digest==='f'.repeat(64))throw new Error('unverified bytes');}});await seed(repository);
  const blobPart:ContentPart={id:nextId(),messageId:nextId(),order:0,kind:'Text',data:{textBlob:{sha256:'a'.repeat(64),byteLength:50_000_000,encoding:'utf-8'}}};
  const message:Message={...repository.get('messages',id(100))!,id:blobPart.messageId,partCount:1};
  const staged=nextId();repository.commit({...batch([mutation('CreateMessage',{message,parts:[blobPart]})]),stagedBlobIds:[staged]});
  assert.deepEqual(checked.at(-1),{digest:'a'.repeat(64),size:50_000_000,stages:[staged],encoding:'utf-8'});assert.equal(repository.readMessageParts({messageId:message.id,page:{maxItems:10,maxBytes:1000,cursor:null}}).items.length,1);
  const missing={...blobPart,id:nextId(),messageId:nextId(),data:{textBlob:{sha256:'f'.repeat(64),byteLength:50_000_000,encoding:'utf-8' as const}}};
  assert.throws(()=>commit(repository,mutation('CreateMessage',{message:{...message,id:missing.messageId},parts:[missing]})),/unverified/);assert.equal(repository.get('messages',missing.messageId),null);
  const sizeBefore=JSON.stringify(repository.get('messages',id(110))).length;
  for(let checkpoint=1;checkpoint<=20;checkpoint++){
    const start=repository.get('messages',id(110))!.partCount;
    const parts:ContentPart[]=Array.from({length:50},(_,index)=>({id:nextId(),messageId:id(110),order:start+index,kind:'Text',data:{text:'bounded original segment'}}));
    commit(repository,mutation('AppendGenerationOutput',{generationId:id(206),sequence:checkpoint,newParts:parts,textAppend:null}));
  }
  assert.equal(repository.get('messages',id(110))!.partCount,1001);assert.ok(JSON.stringify(repository.get('messages',id(110))).length<sizeBefore+10);
  const page=repository.readMessageParts({messageId:id(110),page:{maxItems:25,maxBytes:8000,cursor:null}});assert.equal(page.items.length,25);assert.ok(page.nextCursor);db.close();
});

test('a 50,000-message thread has a bounded root tombstone and cannot grow after deletion',async()=>{
  const {db,repository}=open();const h=await fixture();
  commit(repository,mutation('CreateThread',{thread:h.threads[0]!,context:h.contexts[0]!,state:{...h.threadStates[0]!,activeLeafMessageId:null}}));
  const base:Message={...h.messages[0]!,partCount:0};let last='';
  for(let offset=0;offset<50_000;offset+=100){
    const commands:CanonicalMutation[]=[];
    for(let index=0;index<100;index++){last=nextId();commands.push(mutation('CreateMessage',{message:{...base,id:last,parentId:null},parts:[]}));}
    repository.commit(batch(commands));
  }
  commit(repository,mutation('SetActiveBranch',{threadId:id(10),value:last}));const state=repository.get('threadStates',id(10))!;
  const request=batch([mutation('TombstoneThread',{tombstone:{id:nextId(),threadId:id(10),rootMessageId:null,createdAt:time,reason:null},state:{...state,activeLeafMessageId:null,revision:state.revision+1}})]);
  assert.ok(Buffer.byteLength(JSON.stringify(request))<2000);repository.commit(request);
  assert.equal(repository.get('threadStates',id(10))!.activeLeafMessageId,null);assert.equal(db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='messages'"),50_000);
  assert.throws(()=>commit(repository,mutation('CreateMessage',{message:{...base,id:nextId()},parts:[]})),/deleted/);
  assert.throws(()=>commit(repository,mutation('SetActiveBranch',{threadId:id(10),value:last})),/deleted/);
  assert.equal(db.selectValue('PRAGMA integrity_check'),'ok');db.close();
});

test('sync pages follow commit sequence, pin a high-water mark and resume later writes independently of UUID sorting',async()=>{
  const {db,repository}=open();await seed(repository);
  const first=repository.readSyncOperations({afterSequence:0,page:{maxItems:2,maxBytes:10000,cursor:null}});assert.ok(first.nextCursor);
  const future=mutation('SetTitle',{threadId:id(10),value:'later commit with low lexical UUID'});future.operationId=id(1);commit(repository,future);
  const seen=first.items.map(item=>item.sequence);let cursor:string|null=first.nextCursor;let last=first.lastSequence;
  while(cursor){const page=repository.readSyncOperations({afterSequence:0,page:{maxItems:2,maxBytes:10000,cursor}});assert.equal(page.highWaterSequence,first.highWaterSequence);assert.equal(page.bytes,Buffer.byteLength(JSON.stringify(page.items)));seen.push(...page.items.map(item=>item.sequence));last=page.lastSequence;cursor=page.nextCursor;}
  assert.equal(last,first.highWaterSequence);assert.deepEqual(seen,[...seen].sort((a,b)=>a-b));assert.equal(new Set(seen).size,seen.length);
  const later=repository.readSyncOperations({afterSequence:last,page:{maxItems:10,maxBytes:10000,cursor:null}});assert.equal(later.items.length,1);assert.equal(later.items[0]!.operationId,id(1));assert.ok(later.items[0]!.sequence>last);db.close();
});

test('SQL guards immutable message identity, sealed text, terminal attempts and committed operation coverage',async()=>{
  const {db,repository}=open();
  db.exec(`CREATE TABLE audit(collection TEXT,id TEXT,operation_id TEXT);
    CREATE TRIGGER audit_insert AFTER INSERT ON quixi_records BEGIN INSERT INTO audit VALUES(NEW.collection,NEW.id,NULL); END;
    CREATE TRIGGER audit_update AFTER UPDATE ON quixi_records BEGIN INSERT INTO audit VALUES(NEW.collection,NEW.id,NULL); END;
    CREATE TRIGGER audit_operation AFTER INSERT ON quixi_sync_ops BEGIN UPDATE audit SET operation_id=NEW.operation_id WHERE operation_id IS NULL; END;`);
  await seed(repository);
  assert.throws(()=>db.exec({sql:"UPDATE quixi_records SET payload=json_set(payload,'$.parentId',NULL) WHERE collection='messages' AND id=?",bind:[id(102)]}),/immutable/);
  assert.throws(()=>db.exec({sql:"UPDATE quixi_records SET payload=json_set(payload,'$.data.text','replaced') WHERE collection='parts' AND id=?",bind:[id(1100)]}),/unfinished/);
  assert.throws(()=>db.exec({sql:"UPDATE quixi_records SET payload=json_set(payload,'$.status','failed') WHERE collection='generations' AND id=?",bind:[id(200)]}),/immutable/);
  const kindFor:Record<string,string>={threads:'thread',threadStates:'threadState',contexts:'context',messages:'message',generations:'generation',parts:'part',events:'event',attachments:'attachment',documents:'document',rawObjects:'rawObject',importSources:'importSource',sourceIdentities:'sourceIdentity',provenance:'provenance',tombstones:'tombstone'};
  assert.equal(db.selectValue('SELECT count(*) FROM audit WHERE operation_id IS NULL'),0);
  for(const change of rows(db,'SELECT DISTINCT collection,id,operation_id FROM audit')){
    const op=rows(db,`SELECT affects FROM quixi_sync_ops WHERE operation_id='${change.operation_id}'`)[0]!;
    const effects=JSON.parse(String(op.affects)) as {kind:string;id:string}[];
    assert.ok(effects.some(effect=>effect.kind===kindFor[String(change.collection)]&&effect.id===change.id));
  }
  db.close();
});

test('live raw capture requires verified bytes and sync coverage without inventing an import source',()=>{
  const expected='f'.repeat(64);let available=false;const {db,repository}=open({assertBlobAvailable:(hash,size)=>{assert.equal(hash,expected);assert.equal(size,12);if(!available)throw new Error('unverified live raw bytes');}});
  const rawObject={id:nextId(),availability:'available' as const,sha256:expected,byteLength:12,mediaType:'text/event-stream',storageRef:`sha256:${expected}`};
  const command=mutation('RegisterRawObject',{rawObject});assert.throws(()=>commit(repository,command),/unverified/);
  assert.equal(repository.get('rawObjects',rawObject.id),null);assert.equal(repository.operationStatus(command.operationId).status,'not_found');available=true;commit(repository,command);
  assert.deepEqual(repository.get('rawObjects',rawObject.id),rawObject);assert.equal(db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='importSources'"),0);
  const sync=repository.readSyncOperations({afterSequence:0,page:{maxItems:10,maxBytes:900_000,cursor:null}}).items;assert.equal(sync.length,1);assert.equal(sync[0]!.kind,'RegisterRawObject');assert.deepEqual(sync[0]!.affects,[{kind:'rawObject',id:rawObject.id}]);db.close();
});


test('schema 9 writer barrier commits only with its ledger and preserves all existing history', async () => {
  const db = new sqlite.oo1.DB(`/upgrade-eight-${serial++}.sqlite3`, 'c');
  const repository = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  repository.migrate(8);
  await seed(repository);
  const queries = [
    'SELECT * FROM quixi_records ORDER BY collection,id',
    'SELECT * FROM quixi_edges ORDER BY owner_collection,owner_id,field',
    'SELECT * FROM quixi_sync_ops ORDER BY sequence',
    'SELECT * FROM quixi_transactions ORDER BY transaction_id',
    'SELECT * FROM quixi_schema_migrations WHERE version<=8 ORDER BY version',
  ];
  const before = queries.map(sql => rows(db, sql));
  const failing: CanonicalSqlite = {
    selectValue: (sql, bind) => db.selectValue(sql, bind),
    exec(options) {
      const result = db.exec(options);
      if (typeof options !== 'string' && options.sql === 'INSERT INTO quixi_schema_migrations VALUES(?,?,?)' && options.bind?.[0] === 9)
        throw new Error('lost before migration commit');
      return result;
    },
  };
  assert.throws(() => new CanonicalRepository(failing, { assertBlobAvailable: () => {} }).migrate(), /rolled back/);
  assert.equal(repository.migrate(8), 8);
  assert.deepEqual(queries.map(sql => rows(db, sql)), before);
  assert.equal(repository.migrate(9), 9);
  assert.throws(() => repository.migrate(8), /Unsupported canonical schema version/);
  assert.deepEqual(queries.map(sql => rows(db, sql)), before);
  assert.equal(db.selectValue('PRAGMA integrity_check'), 'ok');
  db.close();
});


test('attachment exclusions commit with their event, replay once, reject stale and invalid references, and survive reopen', async () => {
  const { db, repository: repo, filename } = open(); const h = await seed(repo);
  const previous = h.contexts[0]!, part = h.parts.find(part => part.kind === 'File')!, threadId = previous.threadId;
  const context = {...previous, id:nextId(), previousId:previous.id, version:2, recordedAt:time, compaction:{version:1 as const, excludedPartIds:[part.id]}};
  const event = {id:nextId(), threadId, type:'ContextCompaction' as const, messageId:null, generationId:null, createdAt:time, recordedAt:time, details:{action:'exclude_attachments',contextSnapshotId:context.id,excludedPartIds:[part.id]}};
  const commands = batch([mutation('CreateContextSnapshot',{context,select:true}), mutation('CreateThreadEvent',{event})]);
  commands.expectedThreadRevisions = [{threadId,revision:repo.get('threadStates',threadId)!.revision}];
  const result = repo.commit(commands); assert.deepEqual(repo.commit(commands), result);
  assert.equal(repo.get('threadStates',threadId)!.contextSnapshotId,context.id);
  assert.deepEqual(repo.get('parts',part.id),part); assert.deepEqual(repo.get('contexts',previous.id),previous);
  assert.throws(() => repo.commit({...commands,transactionId:nextId(),mutations:[mutation('SetTitle',{threadId,value:'stale'})]}), /revision|changed/i);
  for (const excludedPartIds of [[nextId()],[h.parts.find(p=>p.kind==='Text')!.id]]) {
    const invalid = {...context,id:nextId(),previousId:context.id,version:3,compaction:{version:1 as const,excludedPartIds}};
    const badEvent = {...event,id:nextId()};
    assert.throws(() => repo.commit(batch([mutation('CreateThreadEvent',{event:badEvent}),mutation('CreateContextSnapshot',{context:invalid,select:true})])));
    assert.equal(repo.get('events',badEvent.id),null); assert.equal(repo.get('contexts',invalid.id),null);
    assert.equal(repo.get('threadStates',threadId)!.contextSnapshotId,context.id);
  }
  db.close(); const reopened = new sqlite.oo1.DB(filename,'w');
  try { const next = new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}}); next.migrate(); assert.deepEqual(next.get('contexts',context.id),context); assert.deepEqual(next.get('events',event.id),event); assert.deepEqual(next.get('parts',part.id),part); } finally {reopened.close();}
});

test('schema 10, 11 and 12 upgrade without losing history and each older migration ceiling refuses schema 13', async () => {
  for(const ceiling of [10,11,12]){
    const db=new sqlite.oo1.DB(`/upgrade-${serial++}.sqlite3`,'c');
    try { const repo=new CanonicalRepository(db,{assertBlobAvailable:()=>{}}); repo.migrate(ceiling); const h=await seed(repo); repo.migrate(); assert.deepEqual(repo.get('contexts',h.contexts[0]!.id),h.contexts[0]); assert.throws(()=>repo.migrate(ceiling), /newer|schema|migration/i); assert.equal(db.selectValue('PRAGMA integrity_check'),'ok'); } finally {db.close();}
  }
});


test('summary attempt and immutable provenance commit together, apply/event replay exactly and survive reopen',async()=>{
 const {db,repository:repo,filename}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));
 const f=prepareSummary(db,repo),before=repo.get('threadStates',id(10)),sourcePart=repo.get('parts',id(1100));assert.ok(sourcePart);
 assert.throws(()=>repo.commit(batch([f.commands[0]!])),/proposal.*together/);assert.equal(repo.get('generations',f.generation.id),null);
 const created=batch(f.commands);repo.commit(created);assert.deepEqual(repo.commit(created).operations.map(x=>x.outcome),['committed','committed']);assert.deepEqual(repo.get('threadStates',id(10)),before);
 const applied=summaryApply(f),result=repo.commit(applied.batch);assert.deepEqual(repo.commit(applied.batch),result);
 assert.equal(repo.get('threadStates',id(10))!.revision,before!.revision+1);assert.equal(repo.get('threadStates',id(10))!.activeLeafMessageId,id(104));
 assert.deepEqual(repo.get('parts',id(1100)),sourcePart);assert.deepEqual(repo.get('parts',f.parts[0]!.id),f.parts[0]);
 db.close();const reopened=new sqlite.oo1.DB(filename,'w');try{const next=new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}});next.migrate();assert.deepEqual(next.get('summaryProposals',f.proposal.id),f.proposal);assert.deepEqual(next.get('contexts',applied.context.id),applied.context);assert.deepEqual(next.get('events',applied.event.id),applied.event);}finally{reopened.close();}
});

test('summary registration rejects stale revision, mismatched fingerprint, wrong branch and duplicate provenance atomically',async()=>{
 const {db,repository:repo}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));
 const f=prepareSummary(db,repo);
 for(const change of [{sourceThreadRevision:f.proposal.sourceThreadRevision-1},{sourceFingerprint:'f'.repeat(64)},{throughMessageId:id(101)},{sourceLeafMessageId:id(109)}]){
  const request=batch([f.commands[0]!,mutation('RegisterSummaryProposal',{proposal:{...f.proposal,...change}})]);
  assert.throws(()=>repo.commit(request));assert.equal(repo.get('generations',f.generation.id),null);assert.equal(repo.get('summaryProposals',f.proposal.id),null);
 }
 repo.commit(batch(f.commands));assert.throws(()=>commit(repo,mutation('RegisterSummaryProposal',{proposal:{...f.proposal,id:nextId()}})));db.close();
});

test('summary application rejects partial, stopped, streaming, empty, nontext, unknown artifacts and oversized UTF-8 output',async()=>{
 const ordinaryPart={id:nextId(),messageId:nextId(),order:0,kind:'Text' as const,data:{text:'valid'}};
 const cases:Array<{status:Generation['status'];parts?:ContentPart[]}>=[{status:'partial'},{status:'stopped'},{status:'streaming'},{status:'complete',parts:[]},{status:'complete',parts:[{...ordinaryPart,kind:'StructuredData',data:{value:{invented:true}}}]},{status:'complete',parts:[{...ordinaryPart,data:{text:'🧭'.repeat(4097)}}]},{status:'complete',parts:[{...ordinaryPart,kind:'ProviderArtifact',data:{providerKind:'unknown',rawObjectId:id(500),locator:'/'}}]}];
 for(const c of cases){const {db,repository:repo}=open();try{await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));const f=prepareSummary(db,repo,c.status,c.parts);repo.commit(batch(f.commands));const applied=summaryApply(f);assert.throws(()=>repo.commit(applied.batch));assert.equal(repo.get('contexts',applied.context.id),null);assert.equal(repo.get('events',applied.event.id),null);assert.equal(repo.get('threadStates',id(10))!.contextSnapshotId,f.source.id);assert.deepEqual(repo.get('generations',f.generation.id),f.generation);}finally{db.close();}}
});

test('summary bad reviewed digest and stale source selection roll back audit event and context; proposals cannot be chat branches',async()=>{
 const {db,repository:repo}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));const f=prepareSummary(db,repo);repo.commit(batch(f.commands));
 const applied=summaryApply(f);applied.context.compaction!.version===2&&applied.context.compaction!.summary&&(applied.context.compaction!.summary.reviewedTextSha256='f'.repeat(64));
 assert.throws(()=>repo.commit(applied.batch),/digest/);assert.equal(repo.get('events',applied.event.id),null);
 assert.throws(()=>commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:f.output.id})),/Summary/);
 assert.throws(()=>commit(repo,mutation('CreateMessage',{message:{...f.output,id:nextId(),generationId:null,parentId:f.output.id,role:'user',partCount:0},parts:[]})),/Summary/);
 commit(repo,mutation('SetTitle',{threadId:id(10),value:'A newer source revision'}));const stale=summaryApply(f);stale.batch.expectedThreadRevisions=[];assert.throws(()=>repo.commit(stale.batch),/source changed/);assert.equal(repo.get('events',stale.event.id),null);db.close();
});


test('successive summaries advance the boundary and fingerprint attachment changes even without a thread revision',async()=>{
 const {db,repository:repo}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));
 const first=prepareSummary(db,repo);repo.commit(batch(first.commands));const applied=summaryApply(first);repo.commit(applied.batch);
 const tail:Message={...repo.get('messages',id(103))!,id:nextId(),parentId:id(104),partCount:0};
 repo.commit(batch([mutation('CreateMessage',{message:tail,parts:[]}),mutation('SetActiveBranch',{threadId:id(10),value:tail.id})]));
 const next=prepareSummary(db,repo,'complete',undefined,id(104));assert.equal(next.proposal.baseSummaryProposalId,first.proposal.id);assert.equal(next.proposal.baseSummaryContextId,applied.context.id);assert.equal(next.proposal.sourceMessageCount,2);
 repo.commit(batch(next.commands));const revision=repo.get('threadStates',id(10))!.revision;
 commit(repo,mutation('ResolveAttachment',{attachmentId:id(400),blobSha256:'a'.repeat(64),sizeBytes:3,provenance:[]}));assert.equal(repo.get('threadStates',id(10))!.revision,revision);
 const stale=summaryApply(next);assert.throws(()=>repo.commit(stale.batch),/source changed/);assert.equal(repo.get('events',stale.event.id),null);
 const refreshed=prepareSummary(db,repo,'complete',undefined,id(104));assert.notEqual(refreshed.proposal.sourceFingerprint,next.proposal.sourceFingerprint);repo.commit(batch(refreshed.commands));const reviewed=summaryApply(refreshed);repo.commit(reviewed.batch);assert.equal(contextSummary(repo.get('contexts',reviewed.context.id)!)!.throughMessageId,id(104));db.close();
});

test('summary apply and clear require matching audit events and revision in the same atomic batch',async()=>{
 const {db,repository:repo}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));const f=prepareSummary(db,repo);repo.commit(batch(f.commands));
 const applied=summaryApply(f);
 for(const request of [
  {...applied.batch,mutations:applied.batch.mutations.filter(m=>m.kind!=='CreateThreadEvent')},
  {...applied.batch,expectedThreadRevisions:[]},
  {...applied.batch,mutations:[mutation('CreateThreadEvent',{event:{...applied.event,details:{...applied.event.details,contextSnapshotId:nextId()}}}),...applied.batch.mutations.filter(m=>m.kind!=='CreateThreadEvent')]},
 ]){assert.throws(()=>repo.commit(request),/audit event|thread revision/);assert.equal(repo.get('contexts',applied.context.id),null);assert.equal(repo.get('events',applied.event.id),null);assert.equal(repo.get('threadStates',id(10))!.contextSnapshotId,f.source.id);}
 repo.commit(applied.batch);
 // Ordinary context edits preserve the identical reviewed policy without a new summary audit.
 const preserved:ContextSnapshot={...applied.context,id:nextId(),previousId:applied.context.id,version:applied.context.version+1,systemPrompt:'New ordinary system prompt'};
 commit(repo,mutation('CreateContextSnapshot',{context:preserved,select:true}));
 // An unselected provider request is independent of the selected summary policy.
 const request:ContextSnapshot={...preserved,id:nextId(),previousId:preserved.id,version:preserved.version+1,systemPrompt:SUMMARY_INSTRUCTION};delete request.compaction;
 commit(repo,mutation('CreateContextSnapshot',{context:request,select:false}));
 const cleared:ContextSnapshot={...preserved,id:nextId(),previousId:preserved.id,version:preserved.version+1,compaction:{version:2,excludedPartIds:preserved.compaction!.excludedPartIds,summary:null}};
 const revision=repo.get('threadStates',id(10))!.revision,event={...applied.event,id:nextId(),generationId:null,details:{action:'clear_summary',contextSnapshotId:cleared.id}};
 const clearBatch={...batch([mutation('CreateContextSnapshot',{context:cleared,select:true}),mutation('CreateThreadEvent',{event})]),expectedThreadRevisions:[{threadId:id(10),revision}]};
 for(const request of [{...clearBatch,mutations:[clearBatch.mutations[0]!]},{...clearBatch,expectedThreadRevisions:[]}]){assert.throws(()=>repo.commit(request),/audit event|thread revision/);assert.equal(repo.get('contexts',cleared.id),null);assert.equal(repo.get('events',event.id),null);}
 const staleFork={...cleared,id:nextId(),previousId:f.source.id,version:f.source.version+1};
 assert.throws(()=>repo.commit({...clearBatch,transactionId:nextId(),mutations:[mutation('CreateContextSnapshot',{context:staleFork,select:true}),mutation('CreateThreadEvent',{event:{...event,id:nextId(),details:{action:'clear_summary',contextSnapshotId:staleFork.id}}})]}),/current selected context/);
 const result=repo.commit(clearBatch);assert.deepEqual(repo.commit(clearBatch),result);assert.equal(contextSummary(repo.get('contexts',cleared.id)!),null);assert.deepEqual(repo.get('contexts',applied.context.id),applied.context);assert.deepEqual(repo.get('summaryProposals',f.proposal.id),f.proposal);assert.deepEqual(repo.get('parts',f.parts[0]!.id),f.parts[0]);db.close();
});


test('summary outputs remain searchable with explicit proposal title and context labels',async()=>{
 const {db,repository:repo}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));const f=prepareSummary(db,repo);repo.commit(batch(f.commands));
 const search=new SearchRepository(db,{async beginVerifiedRead(){throw new Error("Unexpected original verification");},async advanceVerifiedRead(){throw new Error("Unexpected original verification");},async openRead(){throw new Error('Inline summary search must not read blobs');},sliceRead(){throw new Error('Unexpected range');},readChunk(){throw new Error('Unexpected read');},acknowledge(){throw new Error('Unexpected ack');},async discard(){}},{nextId});
 try{
  const source=loadSource(db,'p:'+f.parts[0]!.id)!;
  assert.match(source.title,/^Summary proposal: /);assert.match(source.chunk.contextPrefix,/^Summary proposal: .* > assistant$/);
  assert.equal(source.messageId,f.output.id);assert.equal(source.text,(f.parts[0] as Extract<ContentPart,{kind:'Text'}>).data.text);
  const ordinary=loadSource(db,'p:'+id(1100))!;assert.equal(ordinary.title,repo.get('threadStates',id(10))!.title);assert.doesNotMatch(ordinary.chunk.contextPrefix,/Summary proposal/);
  search.initialize();let ready=false;for(let count=0;count<200;count++){const status=await search.advance({maxChunks:8});if(!status.pendingSources){assert.equal(status.failedSources,1);assert.equal(search.status().lastFailure?.sourceId,'d:'+id(450));ready=true;break;}}assert.ok(ready);
  const hits=search.search({query:'unresolved constraint',mode:'exact',filters:{},page:{cursor:null,maxItems:16,maxBytes:100000}}).items;
  const hit=hits.find(hit=>hit.messageId===f.output.id);assert.ok(hit);assert.match(hit.title,/^Summary proposal: /);assert.equal(hit.position.partId,f.parts[0]!.id);
  assert.deepEqual(repo.get('generations',f.generation.id),f.generation);assert.equal(repo.get('threadStates',id(10))!.activeLeafMessageId,id(104));
 }finally{await search.close();db.close();}
});


test('thread usage separates summary attempts and tokens/cost while inclusive totals retain ordinary attempts',async()=>{
 const {db,repository:repo}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));
 commit(repo,mutation('CompleteGeneration',{generationId:id(206),status:'stopped',completedAt:time,tokensIn:100,tokensOut:25,cachedTokens:4,estimatedCost:{amount:'0.02',currency:'USD'},reportedCost:null,rawResponseId:null}));
 const views=new ViewRepository(db,repo),before=views.thread({threadId:id(10)}).usage;assert.equal(before.summary,undefined);
 for(const [status,usage] of [['complete',{tokensIn:10,tokensOut:3,cachedTokens:0,estimatedCost:{amount:'0.005',currency:'USD'}}],['partial',{tokensIn:null,tokensOut:2,cachedTokens:null,estimatedCost:{amount:'0.005',currency:'USD'}}],['stopped',{tokensIn:null,tokensOut:null,cachedTokens:null,estimatedCost:null}]] as const){const f=prepareSummary(db,repo,status);Object.assign(f.generation,usage);repo.commit(batch(f.commands));}
 const usage=views.thread({threadId:id(10)}).usage;
 assert.deepEqual(usage.summary,{attempts:3,tokensIn:10,tokensOut:5,cachedTokens:0,estimatedCost:{amount:'0.010000',currency:'USD',attempts:2},unpricedAttempts:1});
 assert.equal(usage.attempts,before.attempts+3);assert.equal(usage.tokensIn,110);assert.equal(usage.tokensOut,30);assert.equal(usage.cachedTokens,4);assert.deepEqual(usage.estimatedCost,{amount:'0.030000',currency:'USD',attempts:3});assert.equal(usage.unpricedAttempts,before.unpricedAttempts+1);
 const foreign=prepareSummary(db,repo);foreign.generation.estimatedCost={amount:'0.1',currency:'EUR'};repo.commit(batch(foreign.commands));const mixed=views.thread({threadId:id(10)}).usage;assert.equal(mixed.summary!.estimatedCost,null);assert.equal(mixed.estimatedCost,null);assert.equal(mixed.summary!.attempts,4);assert.equal(mixed.summary!.unpricedAttempts,1);db.close();
});

function freshBranch(repo:CanonicalRepository){
 const state=repo.get('threadStates',id(10))!,source=repo.get('contexts',state.contextSnapshotId)!;
 const context:ContextSnapshot={...source,id:nextId(),previousId:source.id,version:source.version+1,recordedAt:time,...(source.compaction?.version===2?{compaction:{...source.compaction,summary:null}}:{})};
 const event={id:nextId(),threadId:state.threadId,type:'ContextCompaction' as const,messageId:state.activeLeafMessageId,generationId:null,createdAt:time,recordedAt:time,details:{version:1,action:'start_branch',retainedContext:'system_prompt_only',sourceThreadRevision:state.revision,sourceLeafMessageId:state.activeLeafMessageId,previousContextSnapshotId:source.id,contextSnapshotId:context.id}};
 const mutations:CanonicalMutation[]=[mutation('CreateContextSnapshot',{context,select:true}),mutation('SetActiveBranch',{threadId:state.threadId,value:null}),mutation('CreateThreadEvent',{event})];
 if(contextSummary(source))mutations.push(mutation('CreateThreadEvent',{event:{...event,id:nextId(),details:{action:'clear_summary',contextSnapshotId:context.id,previousContextSnapshotId:source.id,reason:'start_branch'}}}));
 return {state,source,context,event,batch:{...batch(mutations),expectedThreadRevisions:[{threadId:state.threadId,revision:state.revision}]}};
}
async function branchSeed(repo:CanonicalRepository){
 const history=await seed(repo);
 commit(repo,mutation('CompleteGeneration',{generationId:id(206),status:'stopped',completedAt:time,tokensIn:null,tokensOut:null,cachedTokens:null,estimatedCost:null,reportedCost:null,rawResponseId:null}));
 commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));
 return history;
}
test('fresh context branch atomically preserves source history, settings and exclusions across retry and reopen',async()=>{
 let inject=false;const {db,repository:repo,filename}=open({beforeCommit:()=>{if(inject)throw new Error('branch precommit fault');}});const h=await branchSeed(repo);
 const source=repo.get('contexts',repo.get('threadStates',id(10))!.contextSnapshotId)!;
 const attachmentPart=h.parts.find(part=>part.kind==='File')!;
 commit(repo,mutation('SetRoutingProfile',{threadId:id(10),value:{route:'retained-route'}}));
 commit(repo,mutation('CreateContextSnapshot',{context:{...source,id:nextId(),previousId:source.id,version:source.version+1,systemPrompt:'Keep exact system constraints.',preferredRoute:{route:'retained-route'},compaction:{version:1,excludedPartIds:[attachmentPart.id]}},select:true}));
 const before=rows(db,"SELECT collection,id,payload FROM quixi_records WHERE collection IN ('messages','parts','generations','contexts') ORDER BY collection,id");
 const branch=freshBranch(repo),operations=db.selectValue('SELECT count(*) FROM quixi_sync_ops');
 inject=true;assert.throws(()=>repo.commit(branch.batch),/branch precommit fault/);inject=false;
 assert.deepEqual(repo.get('threadStates',id(10)),branch.state);assert.equal(repo.get('contexts',branch.context.id),null);assert.equal(repo.get('events',branch.event.id),null);assert.equal(db.selectValue('SELECT count(*) FROM quixi_sync_ops'),operations);
 for(const command of branch.batch.mutations)assert.equal(repo.operationStatus(command.operationId).status,'not_found');
 const receipt=repo.commit(branch.batch);assert.deepEqual(repo.commit(branch.batch),receipt);
 const replay=repo.commit({...branch.batch,transactionId:nextId()});assert.ok(replay.operations.every(operation=>operation.outcome==='already_committed'));
 assert.deepEqual(repo.get('threadStates',id(10)),{...branch.state,contextSnapshotId:branch.context.id,activeLeafMessageId:null,revision:branch.state.revision+2});
 assert.deepEqual(repo.get('contexts',branch.context.id),branch.context);assert.deepEqual(repo.get('events',branch.event.id),branch.event);
 for(const row of before)assert.equal(db.selectValue('SELECT payload FROM quixi_records WHERE collection=? AND id=?',[String(row.collection),String(row.id)]),row.payload);
 assert.equal(db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='tombstones'"),0);
 db.close();const reopened=new sqlite.oo1.DB(filename,'w'),restored=new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}});restored.migrate();
 assert.equal(restored.get('threadStates',id(10))!.activeLeafMessageId,null);assert.deepEqual(restored.get('contexts',branch.context.id),branch.context);assert.deepEqual(restored.get('events',branch.event.id),branch.event);
 commit(restored,mutation('SetActiveBranch',{threadId:id(10),value:branch.state.activeLeafMessageId}));assert.deepEqual(restored.get('messages',branch.state.activeLeafMessageId!),h.messages.find(message=>message.id===branch.state.activeLeafMessageId));
 reopened.close();
});

test('fresh branch rejects stale, unaudited, retargeted or destructive batches without any writes',async()=>{
 const {db,repository:repo}=open();await branchSeed(repo);const original=freshBranch(repo);
 const variants:Array<(value:ReturnType<typeof freshBranch>)=>void>=[
  value=>{value.batch.expectedThreadRevisions=[];},
  value=>{value.batch.expectedThreadRevisions[0]!.revision--;},
  value=>{value.event.details.sourceLeafMessageId=id(100);},
  value=>{value.event.details.previousContextSnapshotId=nextId();},
  value=>{value.event.messageId=id(100);},
  value=>{value.context.systemPrompt='unreviewed replacement';},
  value=>{value.context.preferredRoute={route:'unreviewed route'};},
  value=>{value.context.compaction={version:1,excludedPartIds:[]};},
  value=>{value.context.previousId=nextId();},
  value=>{value.batch.mutations.push(mutation('SetTitle',{threadId:id(10),value:'unrelated'}));},
  value=>{value.batch.mutations.push(mutation('TombstoneThread',{tombstone:{id:nextId(),threadId:id(10),rootMessageId:null,createdAt:time,reason:null},state:{...value.state,activeLeafMessageId:null,revision:value.state.revision+1}}));},
  value=>{value.batch.mutations.splice(1,1);},
  value=>{value.batch.mutations[1]=mutation('SetActiveBranch',{threadId:id(10),value:id(100)});},
  value=>{value.batch.mutations.push(mutation('CreateThreadEvent',{event:{...value.event,id:nextId()}}));},
 ];
 for(const alter of variants){const value=freshBranch(repo);alter(value);const records=db.selectValue('SELECT count(*) FROM quixi_records'),ops=db.selectValue('SELECT count(*) FROM quixi_sync_ops');assert.throws(()=>repo.commit(value.batch));assert.equal(db.selectValue('SELECT count(*) FROM quixi_records'),records);assert.equal(db.selectValue('SELECT count(*) FROM quixi_sync_ops'),ops);assert.deepEqual(repo.get('threadStates',id(10)),original.state);}
 const stale=freshBranch(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(102)}));assert.throws(()=>repo.commit(stale.batch),/revision/);
 repo.commit(freshBranch(repo).batch);assert.throws(()=>repo.commit(freshBranch(repo).batch),/nonempty/);db.close();
});

test('fresh branch clears only applied summary with matching audit while preserving proposal and exclusions',async()=>{
 const {db,repository:repo}=open();const h=await branchSeed(repo),source=repo.get('contexts',repo.get('threadStates',id(10))!.contextSnapshotId)!;
 const excluded=h.parts.find(part=>part.kind==='File')!.id;
 commit(repo,mutation('CreateContextSnapshot',{context:{...source,id:nextId(),previousId:source.id,version:source.version+1,compaction:{version:1,excludedPartIds:[excluded]}},select:true}));
 const f=prepareSummary(db,repo);repo.commit(batch(f.commands));const applied=summaryApply(f);repo.commit(applied.batch);const branch=freshBranch(repo);
 assert.equal(branch.batch.mutations.length,4);
 assert.throws(()=>repo.commit({...branch.batch,transactionId:nextId(),mutations:branch.batch.mutations.slice(0,3)}),/unrelated/);
 const bad=freshBranch(repo),clear=bad.batch.mutations[3]!;if(clear.kind==='CreateThreadEvent')clear.payload.event.messageId=id(100);assert.throws(()=>repo.commit(bad.batch),/matching summary clear/);
 repo.commit(branch.batch);assert.deepEqual(repo.get('contexts',branch.context.id)!.compaction,{version:2,excludedPartIds:[excluded],summary:null});assert.deepEqual(repo.get('contexts',applied.context.id),applied.context);assert.deepEqual(repo.get('summaryProposals',f.proposal.id),f.proposal);assert.deepEqual(repo.get('parts',f.parts[0]!.id),f.parts[0]);assert.equal(repo.get('threadStates',id(10))!.activeLeafMessageId,null);db.close();
});

test('fresh branch cannot race a live generation on a different selected branch or a summary producer',async()=>{
 for(const summary of [false,true]){
  const {db,repository:repo}=open();await seed(repo);commit(repo,mutation('SetActiveBranch',{threadId:id(10),value:id(104)}));
  if(summary){commit(repo,mutation('CompleteGeneration',{generationId:id(206),status:'stopped',completedAt:time,tokensIn:null,tokensOut:null,cachedTokens:null,estimatedCost:null,reportedCost:null,rawResponseId:null}));const f=prepareSummary(db,repo,'streaming');repo.commit(batch(f.commands));}
  const branch=freshBranch(repo);assert.throws(()=>repo.commit(branch.batch),/live generation/);assert.deepEqual(repo.get('threadStates',id(10)),branch.state);assert.equal(repo.get('contexts',branch.context.id),null);db.close();
 }
});
