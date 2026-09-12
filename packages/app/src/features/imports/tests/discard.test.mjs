import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {StorageHarness} from '../../../../../importers/tests/storage-harness.ts';
import {beginChatgptImport,importChatgptSource} from '../../../../../importers/src/index.ts';
import {discardUnfinishedImport} from '../discard.ts';
const input=JSON.stringify([{conversation_id:'discard-fixture',title:'Retained original',mapping:{a:{parent:null,message:{id:'source-a',author:{role:'user'},content:{content_type:'text',parts:['Original retained text']}}}}}]);
const bytes=new TextEncoder().encode(input),source={name:'conversations.json',byteLength:bytes.length,async*open(start=0,end=bytes.length){yield bytes.slice(start,end);}};
async function prepare(stop){const h=new StorageHarness(),runtime={storage:h.client,withRunLock:async(_id,work)=>work(),nextId:randomUUID,now:()=>1788870000000,cancelled:()=>false},runId=randomUUID(),beginId=randomUUID();await beginChatgptImport(runtime,{operationId:beginId,runId,workspaceId:randomUUID(),accountScope:'discard',recordedAt:1788870000000});let hit=false;h.afterRequest=operation=>{if(operation===stop&&!hit){hit=true;throw new Error('lost original acknowledgment');}};await assert.rejects(importChatgptSource(runtime,{runId,sourceKey:'file-0',source}),/lost original/);h.afterRequest=null;return{h,runtime,runId,beginId};}

test('discard removes hidden normalized work and owned staging while retaining committed original bytes',async()=>{
 const {h,runtime,runId}=await prepare('stageImportRecords'),args={runId,operationId:randomUUID()};const raw=h.repository.readEntities({collection:'rawObjects',threadId:null,page:{maxItems:10,maxBytes:100_000,cursor:null}}).items[0];
 assert.equal((await discardUnfinishedImport(runtime,args)).state,'cancelled');assert.equal(h.db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='threads'"),0);assert.equal(h.db.selectValue('SELECT count(*) FROM quixi_import_records'),0);assert.equal(h.db.selectValue('SELECT count(*) FROM quixi_import_work'),0);assert.equal(new TextDecoder().decode(h.published.get(raw.sha256).bytes),input);assert.equal((await discardUnfinishedImport(runtime,args)).state,'cancelled');await h.client.close();
});

test('discard after an unknown final publication preserves the complete canonical thread and original sync history',async()=>{
 const {h,runtime,runId}=await prepare('finalizeNormalizedImport');const sync=h.db.selectValue('SELECT count(*) FROM quixi_sync_ops');assert.equal((await discardUnfinishedImport(runtime,{runId,operationId:randomUUID()})).state,'cancelled');assert.equal(h.db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='threads'"),1);assert.equal(h.db.selectValue("SELECT count(*) FROM quixi_records WHERE collection='messages'"),1);assert.equal(h.db.selectValue('SELECT count(*) FROM quixi_sync_ops'),sync);assert.equal(h.db.selectValue('SELECT count(*) FROM quixi_import_work'),0);assert.equal(h.db.selectValue('PRAGMA integrity_check'),'ok');await h.client.close();
});

test('discard resumes its stable action after a lost group acknowledgment and rejects conflicting identity before cleanup',async()=>{
 const {h,runtime,runId,beginId}=await prepare('stageImportRecords');const before=h.db.selectValue('SELECT count(*) FROM quixi_import_records');await assert.rejects(discardUnfinishedImport(runtime,{runId,operationId:beginId}),/identity/);assert.equal(h.db.selectValue('SELECT count(*) FROM quixi_import_records'),before);
 const args={runId,operationId:randomUUID()};let lost=false;h.afterRequest=operation=>{if(operation==='importGroupFinish'&&!lost){lost=true;throw new Error('lost discard acknowledgment');}};await assert.rejects(discardUnfinishedImport(runtime,args),/lost discard/);h.afterRequest=null;h.restart();assert.equal((await discardUnfinishedImport(runtime,args)).state,'cancelled');assert.equal(h.db.selectValue('SELECT count(*) FROM quixi_import_work'),0);await h.client.close();
});
