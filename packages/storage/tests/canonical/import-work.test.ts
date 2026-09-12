import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import initialize from '../../sqlite/dist/sqlite3.mjs';
import {CanonicalRepository} from '../../src/worker/canonical/index.ts';
import type {CanonicalSqlite} from '../../src/worker/canonical/index.ts';
import type {ImportWorkRecord} from '@quixi/core/contracts';
const wasm=await readFile(new URL('../../sqlite/dist/sqlite3.wasm',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../../sqlite/artifacts.json',import.meta.url),'utf8'));
assert.equal(createHash('sha256').update(wasm).digest('hex'),manifest.artifacts['sqlite3.wasm'].sha256);
(globalThis as typeof globalThis & {sqlite3ApiConfig:unknown}).sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};
const initOptions={instantiateWasm:async(imports:WebAssembly.Imports,success:(instance:WebAssembly.Instance,module:WebAssembly.Module)=>void)=>{const {instance,module}=await WebAssembly.instantiate(wasm,imports);success(instance,module);},print:()=>{},printErr:()=>{}};
const sqlite=await initialize(initOptions) as {oo1:{DB:new(filename:string,flags:string)=>CanonicalSqlite&{close():void}}};
let serial=6_000_000;const id=()=>`00000000-0000-4000-8000-${String(serial++).padStart(12,'0')}`;
function open(){const filename=`/import-work-${serial++}.sqlite3`;const db=new sqlite.oo1.DB(filename,'c');const repository=new CanonicalRepository(db,{assertBlobAvailable:()=>{}});repository.migrate();return{db,repository,filename};}
function begin(repo:CanonicalRepository){const args={operationId:id(),run:{runId:id(),provider:'synthetic',accountScope:'account',workspaceId:id(),importerName:'bounded-fixture',importerVersion:'1',formatProfile:'original-synthetic-v1',recordedAt:1788870000000}};return{args,run:repo.importRunBegin(args)};}
const page={maxItems:128,maxBytes:900_000,cursor:null};
const record=(key:string,parentKey:string|null):ImportWorkRecord=>({key,parentKey,byteStart:10,byteEnd:100,payload:{kind:'message',source:'exact byte locator'}});

test('run identity and random UUID allocations remain stable across unknown replies and database reopen',()=>{
  const {db,repository:repo,filename}=open();const {args,run}=begin(repo);assert.deepEqual(repo.importRunBegin(args),run);
  assert.throws(()=>repo.importRunBegin({...args,run:{...args.run,accountScope:'another'}}),/identity/);
  let allocations=0;const keys={runId:run.runId,keys:['message:node-a','operation:stage:0']};const first=repo.importAllocateIds(keys,()=>{allocations++;return id();});assert.equal(allocations,2);
  assert.deepEqual(repo.importAllocateIds(keys,()=>{throw new Error('must reuse stored UUID');}),first);
  const scope={runId:run.runId,groupKey:'source-preparation'};repo.importWorkStage({...scope,operationId:id(),records:[record('source',null)]});repo.importWorkSeal({...scope,operationId:id(),metadata:{}});
  const checkpoint={...scope,operationId:id(),key:'source',expectedRevision:0,checkpoint:{stageStartSequence:17,blobAttempt:1}};
  assert.deepEqual(repo.importWorkCheckpoint(checkpoint),{revision:1,checkpoint:checkpoint.checkpoint});assert.deepEqual(repo.importWorkCheckpoint(checkpoint),{revision:1,checkpoint:checkpoint.checkpoint});
  assert.throws(()=>repo.importWorkCheckpoint({...checkpoint,operationId:id(),checkpoint:{stageStartSequence:99}}),/revision/);
  const paused=repo.importRunSetState({operationId:id(),runId:run.runId,state:'paused',summary:{reason:'user_cancelled'}});assert.equal(paused.state,'paused');db.close();
  const reopened=new sqlite.oo1.DB(filename,'w');const next=new CanonicalRepository(reopened,{assertBlobAvailable:()=>{}});next.migrate();
  assert.deepEqual(next.importWorkGet({...scope,key:'source'})!.checkpoint,checkpoint.checkpoint);
  assert.equal(next.importWorkGet({...scope,key:'source'})!.checkpointRevision,1);
  assert.deepEqual(next.importAllocateIds(keys,()=>{throw new Error('must survive restart');}),first);
  assert.equal(next.importRunList({state:'paused',page}).items.length,1);assert.equal(next.importRunStatus({runId:run.runId}).state,'paused');
  const bad={runId:run.runId,keys:['valid-before-invalid','invalid']};let n=0;assert.throws(()=>next.importAllocateIds(bad,()=>++n===1?id():'not-a-uuid'),/UUID/);
  assert.equal(reopened.selectValue("SELECT count(*) FROM quixi_import_allocated_ids WHERE key='valid-before-invalid'"),0);reopened.close();
});

test('arbitrary input order resolves through bounded ready work with exact parent results and immutable staging',()=>{
  const {db,repository:repo}=open();const {run}=begin(repo);const scope={runId:run.runId,groupKey:'source.json#0'};
  const args={...scope,operationId:id(),records:[record('child','parent'),record('grandchild','child'),record('parent',null)]};const staged=repo.importWorkStage(args);assert.deepEqual(repo.importWorkStage(args),staged);
  assert.throws(()=>repo.importWorkStage({...args,operationId:id(),records:[record('child','parent')]}),/constraint/);
  assert.throws(()=>repo.importWorkRead({...scope,state:'ready',page}),/Seal/);
  repo.importWorkSeal({...scope,operationId:id(),metadata:{sourceFingerprint:'a'.repeat(64),title:'not an identity'}});
  assert.throws(()=>repo.importWorkStage({...scope,operationId:id(),records:[record('extra',null)]}),/frozen/);
  for(const [index,key] of ['parent','child','grandchild'].entries()){
    const ready=repo.importWorkRead({...scope,state:'ready',page:{...page,maxItems:1}});assert.deepEqual(ready.items.map(item=>item.key),[key]);assert.equal(ready.blocked,null);
    const item=ready.items[0]!;if(index)assert.equal(item.parentResult!.data.resolved, index-1);else assert.equal(item.parentResult,null);
    const command={...scope,operationId:id(),key,result:{canonicalId:id(),data:{resolved:index}}};const result=repo.importWorkResolve(command);assert.deepEqual(repo.importWorkResolve(command),result);
    assert.equal(repo.importWorkGet({...scope,key})!.state,'resolved');
  }
  assert.equal(repo.importWorkRead({...scope,state:'ready',page}).items.length,0);assert.equal(repo.importWorkRead({...scope,state:'ready',page}).blocked,null);
  const first=repo.importWorkRead({...scope,state:'all',page:{...page,maxItems:2}});assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  assert.equal(repo.importWorkRead({...scope,state:'all',page:{...page,cursor:first.nextCursor}}).items.length,1);
  assert.throws(()=>repo.importWorkRead({...scope,state:'ready',page:{...page,cursor:first.nextCursor}}),/queue/);
  assert.throws(()=>repo.importGroupFinish({...scope,operationId:id(),outcome:'published',normalizedImportId:id(),report:{}}),/publication/);
  const finished=repo.importGroupFinish({...scope,operationId:id(),outcome:'skipped',normalizedImportId:null,report:{reason:'already_imported'}});assert.equal(finished.state,'skipped');assert.equal(db.selectValue('SELECT count(*) FROM quixi_import_work'),0);
  assert.equal(repo.importRunReadGroups({runId:run.runId,page}).items.length,1);
  assert.equal(repo.importRunSetState({runId:run.runId,operationId:id(),state:'complete',summary:{skipped:1}}).state,'complete');
  assert.equal(db.selectValue('SELECT count(*) FROM quixi_records'),0);assert.equal(db.selectValue('SELECT count(*) FROM quixi_sync_ops'),0);db.close();
});

test('missing parents and dependency cycles report blocked work, while pause retains restartable scratch',()=>{
  for(const kind of ['missing','cycle'] as const){const {db,repository:repo}=open();const {run}=begin(repo);const scope={runId:run.runId,groupKey:'group'};
    repo.importWorkStage({...scope,operationId:id(),records:kind==='missing'?[record('child','absent')]:[record('a','b'),record('b','a')]});repo.importWorkSeal({...scope,operationId:id(),metadata:{}});
    assert.equal(repo.importWorkRead({...scope,state:'ready',page}).blocked,kind==='missing'?'missing_parent':'cycle');
    assert.throws(()=>repo.importWorkResolve({...scope,key:kind==='missing'?'child':'a',operationId:id(),result:{canonicalId:null,data:{}}}),/predecessor/);
    repo.importRunSetState({runId:run.runId,operationId:id(),state:'paused',summary:{}});
    assert.throws(()=>repo.importWorkResolve({...scope,key:'a',operationId:id(),result:{canonicalId:null,data:{}}}),/Resume/);
    assert.equal(repo.importWorkRead({...scope,state:'all',page}).items.length,kind==='missing'?1:2);
    repo.importRunSetState({runId:run.runId,operationId:id(),state:'running',summary:{}});repo.importGroupFinish({...scope,operationId:id(),outcome:'failed',normalizedImportId:null,report:{reason:kind}});
    assert.equal(repo.importRunSetState({runId:run.runId,operationId:id(),state:'complete',summary:{failed:1}}).state,'complete');db.close();
  }
});

test('SQLite allocation denial rolls back scratch and checkpoint before same-ID retry',()=>{
  const {db,repository:repo}=open();const {run}=begin(repo);const scope={runId:run.runId,groupKey:'allocation'};
  const args={...scope,operationId:id(),records:Array.from({length:8},(_,i)=>({...record(String(i),null),payload:{boundedMetadata:'x'.repeat(32000)}}))};
  const pages=Number(db.selectValue('PRAGMA page_count'));db.exec(`PRAGMA max_page_count=${pages+1}`);assert.throws(()=>repo.importWorkStage(args),/full/i);
  assert.equal(repo.importWorkGroupStatus(scope),null);assert.equal(db.selectValue('SELECT count(*) FROM quixi_import_work'),0);db.exec('PRAGMA max_page_count=1073741823');
  assert.equal(repo.importWorkStage(args).recordCount,8);assert.equal(db.selectValue('PRAGMA integrity_check'),'ok');db.close();
});

test('10,000 reverse-ordered parent dependencies have bounded ready results and no in-memory thread graph',()=>{
  const {db,repository:repo}=open();const {run}=begin(repo);const scope={runId:run.runId,groupKey:'large'};
  for(let end=10_000;end>0;end-=100)repo.importWorkStage({...scope,operationId:id(),records:Array.from({length:100},(_,i)=>record(String(end-i-1),end-i-1===0?null:String(end-i-2)))});
  repo.importWorkSeal({...scope,operationId:id(),metadata:{count:10_000}});
  for(let i=0;i<10_000;i++){
    const ready=repo.importWorkRead({...scope,state:'ready',page:{...page,maxItems:1}});assert.equal(ready.items[0]!.key,String(i));assert.ok(ready.bytes<1000);
    repo.importWorkResolve({...scope,operationId:id(),key:String(i),result:{canonicalId:null,data:{last:i}}});
  }
  assert.equal(repo.importWorkGroupStatus(scope)!.resolvedCount,10_000);assert.equal(db.selectValue('SELECT count(*) FROM quixi_records'),0);assert.equal(db.selectValue('PRAGMA integrity_check'),'ok');db.close();
});

test('control status recovers exact acknowledgments and operation IDs stay fenced across work, blob and normalized journals',()=>{
  const {db,repository:repo}=open();const {args,run}=begin(repo);
  assert.deepEqual(repo.operationStatus(args.operationId),{status:'committed',result:run});
  const blobOperation=id(),blobResult={transferId:id(),maxChunkBytes:1_048_576,maxInFlight:4};
  db.exec({sql:'INSERT INTO quixi_blob_operations VALUES(?,?,?)',bind:[blobOperation,'synthetic-control-identity',JSON.stringify(blobResult)]});
  assert.deepEqual(repo.operationStatus(blobOperation),{status:'committed',result:blobResult});
  assert.throws(()=>repo.importRunSetState({operationId:blobOperation,runId:run.runId,state:'paused',summary:{}}),/another action/);
  assert.throws(()=>db.exec({sql:'INSERT INTO quixi_blob_operations VALUES(?,?,?)',bind:[args.operationId,'conflict','{}']}),/identity/);
  const normalized={operationId:id(),importId:id(),threadId:id(),mode:'create' as const,expectedThreadRevision:null,recordedAt:1788870000000};
  repo.beginNormalizedImport(normalized);
  assert.throws(()=>repo.importRunSetState({operationId:normalized.operationId,runId:run.runId,state:'paused',summary:{}}),/another action/);
  assert.throws(()=>repo.beginNormalizedImport({...normalized,operationId:args.operationId,importId:id(),threadId:id()}),/reserved/);
  assert.throws(()=>repo.beginNormalizedImport({...normalized,operationId:blobOperation,importId:id(),threadId:id()}),/reserved/);
  assert.throws(()=>db.exec({sql:'INSERT INTO quixi_blob_operations VALUES(?,?,?)',bind:[normalized.operationId,'conflict','{}']}),/identity/);
  assert.deepEqual(repo.operationStatus(id()),{status:'not_found',result:null});db.close();
});
