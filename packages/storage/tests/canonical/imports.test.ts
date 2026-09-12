import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import initialize from '../../sqlite/dist/sqlite3.mjs';
import {CanonicalRepository} from '../../src/worker/canonical/index.ts';
import type {CanonicalSqlite,CanonicalRepositoryOptions} from '../../src/worker/canonical/index.ts';
import {canonicalJson,jsonByteLength} from '@quixi/core/contracts';
import type {StagedImportRecord,NormalizedImportStatus,StorageOperations,LocalSyncOperation} from '@quixi/core/contracts';
import type {CanonicalHistory,Message,ContentPart,Thread,ThreadState,ContextSnapshot,JsonValue} from '@quixi/core/model';
const wasm=await readFile(new URL('../../sqlite/dist/sqlite3.wasm',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../../sqlite/artifacts.json',import.meta.url),'utf8'));
assert.equal(createHash('sha256').update(wasm).digest('hex'),manifest.artifacts['sqlite3.wasm'].sha256);
(globalThis as typeof globalThis & {sqlite3ApiConfig:unknown}).sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};
const initOptions={instantiateWasm:async(imports:WebAssembly.Imports,success:(instance:WebAssembly.Instance,module:WebAssembly.Module)=>void)=>{const {instance,module}=await WebAssembly.instantiate(wasm,imports);success(instance,module);},print:()=>{},printErr:()=>{}};
const sqlite=await initialize(initOptions) as {oo1:{DB:new(filename:string,flags:string)=>CanonicalSqlite&{close():void}}};
let serial=3_000_000;const id=()=>`00000000-0000-4000-8000-${String(serial++).padStart(12,'0')}`;const time=1788870000000;
function open(options:Partial<CanonicalRepositoryOptions>={}){const filename=`/import-${serial++}.sqlite3`;const db=new sqlite.oo1.DB(filename,'c');const repository=new CanonicalRepository(db,{assertBlobAvailable:()=>{},...options});repository.migrate();return {db,repository,filename};}
function base(){
  const thread:Thread={id:id(),workspaceId:id(),createdAt:time,recordedAt:time,systemPrompt:null,preferredRoute:null,importSourceId:null};
  const context:ContextSnapshot={id:id(),threadId:thread.id,previousId:null,version:1,systemPrompt:null,preferredRoute:null,recordedAt:time};
  const state:ThreadState={threadId:thread.id,title:'Original synthetic import',tags:[],pinned:false,archived:false,activeLeafMessageId:null,contextSnapshotId:context.id,routingProfile:null,revision:0};
  return {thread,context,state};
}
function entry<C extends StagedImportRecord['collection']>(collection:C,record:NonNullable<CanonicalHistory[C]>[number]):StagedImportRecord{return{collection,record,operationId:id(),recordedAt:time} as StagedImportRecord;}
function begin(repository:CanonicalRepository,threadId:string,mode:'create'|'extend'='create',revision:number|null=null){const args={operationId:id(),importId:id(),threadId,mode,expectedThreadRevision:revision,recordedAt:time};return {args,status:repository.beginNormalizedImport(args)};}
function stage(repo:CanonicalRepository,status:NormalizedImportStatus,records:StagedImportRecord[]){return repo.stageImportRecords({operationId:id(),importId:status.importId,sequence:status.nextSequence,records});}
function ready(repo:CanonicalRepository,status:NormalizedImportStatus,maxRecords=128){let steps=0;do{status=repo.validateImportStep({operationId:id(),importId:status.importId,maxRecords,stagedBlobIds:[]});assert.ok(++steps<100_000);}while(status.state!=='ready');return status;}
function publication(status:NormalizedImportStatus){return{operationId:id(),importId:status.importId,recordedAt:time,expectedRecordCount:status.recordCount,expectedManifestDigest:status.manifestDigest};}
function publish(repo:CanonicalRepository,status:NormalizedImportStatus){return repo.finalizeNormalizedImport(publication(ready(repo,status)));}
function count(db:CanonicalSqlite,table='quixi_records'){return Number(db.selectValue(`SELECT count(*) FROM ${table}`));}
function clean(db:CanonicalSqlite){assert.equal(db.selectValue('PRAGMA integrity_check'),'ok');assert.deepEqual(db.exec({sql:'PRAGMA foreign_key_check',rowMode:'object',returnValue:'resultRows'}),[]);}

test('provider-shaped normalized graphs stay hidden through staging/restart and publish with grouped sync coverage',async()=>{
  for(const name of ['native-branches','claude-compliance','chatgpt-conversations']){
    const h=JSON.parse(await readFile(new URL(`../../../../tests/fixtures/canonical/${name}.history.json`,import.meta.url),'utf8')) as CanonicalHistory;
    // An imported snapshot cannot advertise the fixture's in-progress native producer as live.
    for(const generation of h.generations)if(generation.status==='streaming'){
      generation.status='partial';generation.completedAt=Math.max(time,generation.createdAt??0);
      h.messages.find(message=>message.id===generation.outputMessageId)!.sealed=true;
    }
    const first=open();let repo=first.repository;let {status,args}=begin(repo,h.threads[0]!.id);
    assert.deepEqual(repo.beginNormalizedImport(args),status);
    const records=Object.entries(h).filter(([collection])=>collection!=='version'&&collection!=='tombstones').flatMap(([collection,items])=>(items as unknown[]).map(record=>entry(collection as StagedImportRecord['collection'],record as StagedImportRecord['record']))).reverse();
    for(let i=0;i<records.length;i+=3)status=stage(repo,status,records.slice(i,i+3));
    assert.equal(count(first.db),0);assert.equal(count(first.db,'quixi_sync_ops'),0);
    if(h.sourceIdentities[0])assert.equal(repo.resolveSourceIdentity(h.sourceIdentities[0]),null);
    const page=repo.readStagedImportRecords({importId:status.importId,page:{maxItems:2,maxBytes:900_000,cursor:null}});assert.equal(page.items.length,2);assert.ok(page.nextCursor);
    const checkpoint={operationId:id(),importId:status.importId,maxRecords:4,stagedBlobIds:[]};
    status=repo.validateImportStep(checkpoint);
    assert.deepEqual(repo.committedImportOperation('validateImportStep',checkpoint),status);
    assert.throws(()=>repo.committedImportOperation('validateImportStep',{...checkpoint,maxRecords:5}),/identity/);
    first.db.close();
    const db=new sqlite.oo1.DB(first.filename,'w');repo=new CanonicalRepository(db,{assertBlobAvailable:()=>{}});repo.migrate();
    status=ready(repo,repo.normalizedImportStatus({importId:status.importId}),3);assert.equal(count(db),0);
    const argsFinal=publication(status),published=repo.finalizeNormalizedImport(argsFinal);assert.equal(published.state,'published');assert.deepEqual(repo.finalizeNormalizedImport(argsFinal),published);
    assert.equal(repo.operationStatus(argsFinal.operationId).status,'committed');assert.equal(count(db),records.length);assert.equal(count(db,'quixi_sync_ops'),records.length+1);
    for(const e of records){const record=e.record;assert.deepEqual(repo.get(e.collection,'id'in record?record.id:record.threadId),record);}
    let cursor:string|null=null;let digest='0'.repeat(64),ordinal=0;let marker:LocalSyncOperation|undefined;
    do{
      const sync=repo.readSyncOperations({afterSequence:0,page:{maxItems:2,maxBytes:900_000,cursor}});
      for(const op of sync.items){if(op.kind==='ImportRecord'){
        const payload=op.payload as {importId:string;ordinal:number};assert.equal(payload.importId,status.importId);assert.equal(payload.ordinal,ordinal++);assert.equal(op.affects.length,1);
        const identity=createHash('sha256').update(canonicalJson({version:1,operationId:op.operationId,kind:op.kind,recordedAt:op.recordedAt,payload:op.payload})).digest('hex');
        digest=createHash('sha256').update(canonicalJson([digest,identity])).digest('hex');
      }else{assert.equal(op.kind,'PublishImport');marker=op;}}
      cursor=sync.nextCursor;
    }while(cursor);
    assert.equal(ordinal,records.length);assert.equal(digest,status.manifestDigest);assert.equal((marker!.payload as {manifestDigest:string}).manifestDigest,digest);
    assert.equal(count(db,'quixi_import_records'),0);assert.equal(repo.readStagedImportRecords({importId:status.importId,page:{maxItems:2,maxBytes:900_000,cursor:null}}).items.length,0);clean(db);db.close();
  }
});

test('sealed 2,000-part message spans bounded controls, validation and ordered pages without partial visibility',()=>{
  const {db,repository:repo}=open();const b=base();const message:Message={id:id(),threadId:b.thread.id,parentId:null,role:'assistant',createdAt:time,recordedAt:time,generationId:null,editedFromMessageId:null,partCount:2000,sealed:true};
  let {status}=begin(repo,b.thread.id);status=stage(repo,status,[entry('threads',b.thread),entry('contexts',b.context),entry('threadStates',{...b.state,activeLeafMessageId:message.id}),entry('messages',message)]);
  let controlBytes=0;
  for(let first=0;first<message.partCount;first+=64){const records:StagedImportRecord[]=[];for(let order=first;order<Math.min(first+64,message.partCount);order++)records.push(entry('parts',{id:id(),messageId:message.id,order,kind:'Text',data:{text:'x'.repeat(1024)}}));
    const args={operationId:id(),importId:status.importId,sequence:status.nextSequence,records};const bytes=jsonByteLength(args);controlBytes+=bytes;assert.ok(bytes<1_048_576);status=repo.stageImportRecords(args);assert.equal(repo.get('messages',message.id),null);
  }
  assert.ok(controlBytes>2_000_000);status=ready(repo,status);assert.equal(count(db),0);publish(repo,status);
  let cursor:string|null=null,partCount=0;do{const page=repo.readMessageParts({messageId:message.id,page:{maxItems:73,maxBytes:20_000,cursor}});for(const part of page.items as unknown as ContentPart[])assert.equal(part.order,partCount++);cursor=page.nextCursor;}while(cursor);
  assert.equal(partCount,message.partCount);clean(db);db.close();
});

test('stage operations, global IDs and native source mappings are fenced across overlapping jobs and normal commits',()=>{
  const {db,repository:repo}=open();const a=base(),b=base();let first=begin(repo,a.thread.id).status,second=begin(repo,b.thread.id).status;
  const source={id:id(),provider:'synthetic',accountScope:'account',sourceThreadId:'native-thread',sourceContainerKey:'conversation',entityKind:'thread' as const,nativeId:'native-thread',quixiId:a.thread.id};
  const records=[entry('threads',a.thread),entry('contexts',a.context),entry('threadStates',a.state),entry('sourceIdentities',source)];
  const args={operationId:id(),importId:first.importId,sequence:0,records};first=repo.stageImportRecords(args);assert.deepEqual(repo.stageImportRecords(args),first);
  assert.throws(()=>repo.stageImportRecords({...args,records:[entry('threads',a.thread)]}),/identity/);
  assert.throws(()=>stage(repo,second,[entry('sourceIdentities',{...source,id:id(),quixiId:b.thread.id})]),/constraint/i);
  assert.throws(()=>repo.commit({transactionId:id(),expectedThreadRevisions:[],stagedBlobIds:[],mutations:[{version:1,operationId:id(),kind:'CreateThread',recordedAt:time,payload:{thread:a.thread,context:a.context,state:a.state}}]}),/reserved/);
  const cancelled=repo.cancelNormalizedImport({operationId:id(),importId:first.importId});assert.equal(cancelled.state,'cancelled');assert.equal(count(db),0);
  second=stage(repo,second,[entry('threads',b.thread),entry('contexts',b.context),entry('threadStates',b.state),entry('sourceIdentities',{...source,id:id(),quixiId:b.thread.id})]);publish(repo,second);
  assert.equal(repo.resolveSourceIdentity(source),b.thread.id);
  // A cancelled group's operation identity cannot acquire a different meaning later.
  const third=begin(repo,id()).status;
  assert.throws(()=>stage(repo,third,[{...entry('rawObjects',{id:id(),availability:'missing',sha256:null,byteLength:null,mediaType:'application/json',storageRef:null}),operationId:records[0]!.operationId}]),/constraint/i);
  clean(db);db.close();
});

test('missing references, ancestry/edit cycles and incomplete messages cannot become visible',()=>{
  for(const error of ['missing','cycle','parts'] as const){const {db,repository:repo}=open();const b=base();const message:Message={id:id(),threadId:b.thread.id,parentId:null,role:'user',createdAt:time,recordedAt:time,generationId:null,editedFromMessageId:null,partCount:error==='parts'?2:0,sealed:true};
    const second={...message,id:id(),parentId:message.id};if(error==='missing')message.parentId=id();if(error==='cycle')message.parentId=second.id;
    let {status}=begin(repo,b.thread.id);status=stage(repo,status,[entry('threads',b.thread),entry('contexts',b.context),entry('threadStates',b.state),entry('messages',message),...(error==='cycle'?[entry('messages',second)]:[])]);
    assert.throws(()=>ready(repo,status),error==='parts'?/part count/:/cycle or missing/);assert.equal(count(db),0);assert.equal(count(db,'quixi_sync_ops'),0);clean(db);db.close();
  }
});

test('publication rollback under SQLite allocation denial preserves staged work and retries the same operation',()=>{
  let inject=false;const {db,repository:repo}=open({beforeCommit:()=>{if(inject)throw new Error('injected publication failure');}});const b=base();
  const message:Message={id:id(),threadId:b.thread.id,parentId:null,role:'user',createdAt:time,recordedAt:time,generationId:null,editedFromMessageId:null,partCount:32,sealed:true};
  let {status}=begin(repo,b.thread.id);status=stage(repo,status,[entry('threads',b.thread),entry('contexts',b.context),entry('threadStates',b.state),entry('messages',message)]);
  for(let first=0;first<32;first+=8)status=stage(repo,status,Array.from({length:8},(_,i)=>entry('parts',{id:id(),messageId:message.id,order:first+i,kind:'Text',data:{text:'bounded original text '.repeat(600)}})));
  status=ready(repo,status);const args=publication(status);inject=true;assert.throws(()=>repo.finalizeNormalizedImport(args),/injected/);inject=false;
  assert.equal(count(db),0);assert.equal(count(db,'quixi_sync_ops'),0);assert.equal(repo.normalizedImportStatus({importId:status.importId}).state,'ready');
  const pages=Number(db.selectValue('PRAGMA page_count'));db.exec(`PRAGMA max_page_count=${pages+2}`);
  assert.throws(()=>repo.finalizeNormalizedImport(args),/full/i);assert.equal(count(db),0);assert.equal(count(db,'quixi_sync_ops'),0);assert.equal(count(db,'quixi_import_records'),status.recordCount);clean(db);
  db.exec('PRAGMA max_page_count=1073741823');assert.equal(repo.finalizeNormalizedImport(args).state,'published');clean(db);db.close();
});

test('restart and concurrent live commits require fresh bounded validation, while extension preserves user state',()=>{
  const {db,repository:repo,filename}=open();const b=base();let {status}=begin(repo,b.thread.id);status=stage(repo,status,[entry('threads',b.thread),entry('contexts',b.context),entry('threadStates',b.state)]);publish(repo,status);
  let ext=begin(repo,b.thread.id,'extend',0).status;
  const message:Message={id:id(),threadId:b.thread.id,parentId:null,role:'user',createdAt:time,recordedAt:time,generationId:null,editedFromMessageId:null,partCount:0,sealed:true};ext=stage(repo,ext,[entry('messages',message)]);ext=ready(repo,ext);db.close();
  const reopened=new sqlite.oo1.DB(filename,'w');const next=new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}});next.migrate();const args=publication(ext);
  assert.equal(next.normalizedImportStatus({importId:ext.importId}).state,'validating');assert.throws(()=>next.finalizeNormalizedImport(args),/validation/);
  ready(next,ext);assert.equal(next.finalizeNormalizedImport(args).state,'published');assert.deepEqual(next.get('threadStates',b.thread.id),b.state);
  let changed=begin(next,b.thread.id,'extend',0).status;changed=stage(next,changed,[entry('messages',{...message,id:id()})]);ready(next,changed);
  next.commit({transactionId:id(),expectedThreadRevisions:[],stagedBlobIds:[],mutations:[{version:1,operationId:id(),kind:'SetTitle',recordedAt:time,payload:{threadId:b.thread.id,value:'User title wins'}}]});
  assert.throws(()=>next.finalizeNormalizedImport(publication(changed)),/validation/);assert.throws(()=>ready(next,changed),/revision/);assert.equal(next.get('threadStates',b.thread.id)!.title,'User title wins');clean(reopened);reopened.close();
});

test('bounded prevalidation iterator and durable blob transfer cleanup survive restart, cancellation and revoked evidence',()=>{
  let valid=true;const calls:string[]=[];const {db,repository:repo,filename}=open({assertBlobAvailable:(hash,_size,_stages,encoding)=>{calls.push(`${hash}:${encoding}`);if(!valid)throw new Error('blob verification revoked');}});
  const b=base(),message:Message={id:id(),threadId:b.thread.id,parentId:null,role:'assistant',createdAt:time,recordedAt:time,generationId:null,editedFromMessageId:null,partCount:1,sealed:true};
  let {status}=begin(repo,b.thread.id);status=stage(repo,status,[entry('threads',b.thread),entry('contexts',b.context),entry('threadStates',b.state),entry('messages',message),entry('parts',{id:id(),messageId:message.id,order:0,kind:'Text',data:{textBlob:{sha256:'a'.repeat(64),byteLength:99,encoding:'utf-8'}}})]);
  const transfers=[id(),id(),id()];repo.recordImportBlobTransfers(status.importId,transfers);repo.recordImportBlobTransfers(status.importId,transfers);
  assert.equal([...repo.importValidationRecords({importId:status.importId,maxRecords:1})].length,0);
  status=repo.validateImportStep({operationId:id(),importId:status.importId,maxRecords:1,stagedBlobIds:[]});
  assert.equal([...repo.importValidationRecords({importId:status.importId,maxRecords:2})].length,2);
  status=ready(repo,status,2);assert.ok(calls.includes(`${'a'.repeat(64)}:utf-8`));valid=false;
  assert.throws(()=>repo.finalizeNormalizedImport(publication(status)),/revoked/);assert.equal(count(db),0);valid=true;
  publish(repo,status);db.close();const reopened=new sqlite.oo1.DB(filename,'w');const next=new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}});next.migrate();
  assert.deepEqual(next.readImportBlobTransfers(status.importId,{after:null,maxItems:2}),transfers.slice(0,2));next.forgetImportBlobTransfer(status.importId,transfers[0]!);
  assert.deepEqual(next.readImportBlobTransfers(status.importId,{after:null,maxItems:128}),transfers.slice(1));assert.equal(next.cancelNormalizedImport({operationId:id(),importId:status.importId}).state,'published');clean(reopened);reopened.close();
});

test('50,000-message arbitrary-order import uses bounded JS pages and one complete SQL publication',(t)=>{
  const started=performance.now();
  const {db,repository:repo}=open();const b=base();let {status}=begin(repo,b.thread.id);status=stage(repo,status,[entry('threads',b.thread),entry('contexts',b.context),entry('threadStates',b.state)]);
  // Children deliberately arrive before parents. IDs are generated arithmetically; there is no in-memory thread graph.
  const messageStart=serial;serial+=50_000;const messageId=(i:number)=>`00000000-0000-4000-8000-${String(messageStart+i).padStart(12,'0')}`;
  for(let end=50_000;end>0;end-=100){const records:StagedImportRecord[]=[];for(let i=end-1;i>=Math.max(0,end-100);i--)records.push(entry('messages',{id:messageId(i),threadId:b.thread.id,parentId:i===0?null:messageId(i-1),role:i%2?'assistant':'user',createdAt:time,recordedAt:time,generationId:null,editedFromMessageId:null,partCount:0,sealed:true}));status=stage(repo,status,records);}
  t.diagnostic(`stage 50k: ${Math.round(performance.now()-started)}ms`);
  assert.equal(count(db),0);status=ready(repo,status);assert.equal(count(db),0);assert.equal(count(db,'quixi_sync_ops'),0);
  t.diagnostic(`stage + validate 50k: ${Math.round(performance.now()-started)}ms`);
  repo.finalizeNormalizedImport(publication(status));
  t.diagnostic(`stage + validate + publish 50k: ${Math.round(performance.now()-started)}ms`);
  assert.equal(count(db),50_003);assert.equal(count(db,'quixi_sync_ops'),50_004);assert.equal(repo.get('messages',messageId(49_999))!.parentId,messageId(49_998));clean(db);db.close();
});
