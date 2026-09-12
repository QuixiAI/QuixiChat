import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {installSqlObserver,observeSqlOperation} from './runtime.mjs';
import {transformSqlObserver} from './plugin.mjs';
const calls=[];const marker=new Error('synthetic private error not retained');
class Database {
 filename='/archive.sqlite3';
 exec(arg){calls.push({receiver:this,arg});if(arg==='THROW')throw marker;return this;}
 selectValue(sql,bind){calls.push({receiver:this,sql,bind});return 17;}
 selectValues(sql,bind){return [this.selectValue(sql,bind)];}
 selectArray(sql,bind){return [this.selectValue(sql,bind)];}
 selectArrays(sql,bind){this.exec({sql,bind});return [[17]];}
 selectObject(sql,bind){return {value:this.selectValue(sql,bind)};}
 selectObjects(sql,bind){this.exec({sql,bind});return [{value:17}];}
}
const sqlite={oo1:{DB:Database}};
test('observer preserves receiver, bindings, returns, thrown identity and exact transaction sequence',async()=>{
 assert.equal(installSqlObserver(sqlite),sqlite);installSqlObserver(sqlite);
 const db=new Database(),bind=['synthetic-private-payload'];const args={sql:'INSERT INTO quixi_extract_text_batches VALUES(?)',bind};
 await observeSqlOperation({kind:'request',request:{operation:'stagePageText',args:{secret:'do-not-record'}}},async()=>{
  assert.equal(db.exec('BEGIN IMMEDIATE'),db);assert.equal(db.exec(args),db);assert.equal(db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name=?",bind),17);assert.deepEqual(db.selectObjects('SELECT x FROM quixi_extract_map_batches',bind),[{value:17}]);assert.throws(()=>db.exec('THROW'),error=>error===marker);db.exec('COMMIT');
 });
 assert.equal(calls[1].arg,args);assert.equal(calls[1].receiver,db);assert.equal(calls[2].bind,bind);
 assert.deepEqual(calls.map(c=>c.arg??c.sql),['BEGIN IMMEDIATE',args,"SELECT count(*) FROM sqlite_schema WHERE name=?",{sql:'SELECT x FROM quixi_extract_map_batches',bind},'THROW','COMMIT']);
 const snapshot=globalThis.__quixiSqlDiagnostic.snapshot(true),serialized=JSON.stringify(snapshot);
 assert.equal(snapshot.nestedCalls,1);assert.equal(snapshot.rows.reduce((sum,row)=>sum+row.count,0),6);assert.equal(snapshot.rows.reduce((sum,row)=>sum+row.errors,0),1);assert.equal(snapshot.operations[0].operation,'stagePageText');assert.equal(snapshot.operations[0].count,1);
 for(const forbidden of ['synthetic-private','do-not-record','INSERT INTO','SELECT count','private error'])assert(!serialized.includes(forbidden));
 assert(snapshot.rows.some(row=>row.category==='transaction.commit'));assert(snapshot.rows.some(row=>row.category==='schema.read'));assert(snapshot.rows.some(row=>row.category==='extraction.text.write'));
});
test('operation overlap and unsupported labels use fixed buckets; active reset refused',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});
 const first=observeSqlOperation({kind:'request',request:{operation:'caller-controlled-secret'}},()=>wait);
 assert.throws(()=>globalThis.__quixiSqlDiagnostic.snapshot(true));
 await observeSqlOperation({kind:'request',request:{operation:'stagePageText'}},async()=>{new Database().exec('COMMIT');});release();await first;
 const result=globalThis.__quixiSqlDiagnostic.snapshot(true);assert.equal(result.overlapScopes,1);assert.equal(result.rows[0].operation,'overlap');assert(!JSON.stringify(result).includes('caller-controlled-secret'));
});
test('transform rejects stale source and changes only reviewed anchors',()=>{
 for(const path of ['packages/storage/src/worker/sqlite-module.ts','packages/storage/src/worker/archive-runtime.ts']){
  const source=readFileSync(new URL('../../../'+path,import.meta.url),'utf8');
  const transformed=transformSqlObserver(source,path);assert(transformed);assert.equal(transformed.evidence.changes,1);assert.notEqual(transformed.evidence.sourceSha256,transformed.evidence.transformedSha256);
  assert.throws(()=>transformSqlObserver(source+'\n',path),/hash mismatch/);
  assert.equal(transformSqlObserver(source,'not-a-target.ts'),null);
 }
});
