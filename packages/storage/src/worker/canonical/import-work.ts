import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {assertStorageRequest,canonicalJson,jsonByteLength} from '@quixi/core/contracts';
import type {ImportWorkOperations,ImportRun,ImportWorkGroup,ImportWorkItem,ImportWorkResult,EntityPage,PageBudget} from '@quixi/core/contracts';
import {isQuixiId} from '@quixi/core/model';
import type {JsonValue,JsonObject} from '@quixi/core/model';
import type {CanonicalSqlite,SqlValue} from './repository.ts';
type Operation=keyof ImportWorkOperations;
type Args<K extends Operation>=ImportWorkOperations[K]['args'];
type Row=Record<string,SqlValue>;
type Control='importRunBegin'|'importRunSetState'|'importWorkStage'|'importWorkSeal'|'importWorkCheckpoint'|'importWorkResolve'|'importGroupFinish';
const json=(value:unknown)=>canonicalJson(value as JsonValue);
const identity=(value:unknown)=>bytesToHex(sha256(new TextEncoder().encode(json(value))));
const fail=(message:string,code='CONFLICT'):never=>{throw Object.assign(new Error(message),{code});};
const requestId='00000000-0000-4000-8000-000000000000';
/** Generic bounded scratch/checkpoint persistence. It does not know provider fields or normalize conversation content. */
export class ImportWorkRepository{
  constructor(private db:CanonicalSqlite){}
  private rows(sql:string,bind:SqlValue[]=[]):Row[]{return this.db.exec({sql,...(bind.length?{bind}:{}),rowMode:'object',returnValue:'resultRows'}) as Row[];}
  private scalar(sql:string,bind:SqlValue[]=[]):number{return Number(bind.length?this.db.selectValue(sql,bind):this.db.selectValue(sql));}
  private write(sql:string,bind:SqlValue[]=[]):void{this.db.exec({sql,...(bind.length?{bind}:{})});}
  private check<K extends Operation>(operation:K,args:Args<K>):void{assertStorageRequest({version:1,requestId,operation,args} as Parameters<typeof assertStorageRequest>[0]);}
  private transaction<T>(work:()=>T):T{
    this.db.exec('BEGIN IMMEDIATE');try{const result=work();this.db.exec('COMMIT');return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{}
      if(error&&typeof error==='object'&&'resultCode'in error&&(Number(error.resultCode)&255)===19)fail(`Importer work constraint rejected the transaction: ${String(error)}`);throw error;}
  }
  private run(id:string):ImportRun{
    const row=this.rows('SELECT payload FROM quixi_import_runs WHERE id=?',[id])[0]??fail('Import run not found','NOT_FOUND');return JSON.parse(String(row.payload)) as ImportRun;
  }
  private group(runId:string,key:string):ImportWorkGroup|null{
    const row=this.rows('SELECT * FROM quixi_import_work_groups WHERE run_id=? AND group_key=?',[runId,key])[0];
    return row?{runId,groupKey:key,state:String(row.state) as ImportWorkGroup['state'],recordCount:Number(row.record_count),resolvedCount:Number(row.resolved_count),metadata:JSON.parse(String(row.metadata)) as JsonObject,report:JSON.parse(String(row.report)) as JsonObject,normalizedImportId:row.normalized_import_id===null?null:String(row.normalized_import_id)}:null;
  }
  private operation<K extends Control,T>(operation:K,args:Args<K>,work:()=>T):T{
    this.check(operation,args);const digest=identity({operation,args});const runId='run'in args?args.run.runId:args.runId;
    return this.transaction(()=>{
      const previous=this.rows('SELECT identity,result FROM quixi_import_work_operations WHERE operation_id=?',[args.operationId])[0];
      if(previous){if(previous.identity!==digest)fail('Importer work operation identity conflicts with earlier arguments');return JSON.parse(String(previous.result)) as T;}
      if(this.scalar('SELECT EXISTS(SELECT 1 FROM quixi_sync_ops WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_import_operations WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_blob_operations WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_import_record_identities WHERE operation_id=?)',[args.operationId,args.operationId,args.operationId,args.operationId]))fail('Importer work operation ID already belongs to another action');
      const result=work();jsonByteLength(result,1_000_000);
      this.write('INSERT INTO quixi_import_work_operations VALUES(?,?,?,?)',[args.operationId,runId,digest,json(result)]);return result;
    });
  }
  importRunBegin(args:Args<'importRunBegin'>):ImportRun{
    return this.operation('importRunBegin',args,()=>{
      if(this.rows('SELECT id FROM quixi_import_runs WHERE id=?',[args.run.runId]).length)fail('Run ID already exists; resume it or retry the original operation');
      const run:ImportRun={...args.run,state:'running',summary:{}};jsonByteLength(run,65536);this.write('INSERT INTO quixi_import_runs VALUES(?,?)',[run.runId,json(run)]);return run;
    });
  }
  importRunStatus(args:Args<'importRunStatus'>):ImportRun{this.check('importRunStatus',args);return this.run(args.runId);}
  importRunSetState(args:Args<'importRunSetState'>):ImportRun{
    return this.operation('importRunSetState',args,()=>{
      const previous=this.run(args.runId);
      if(previous.state==='complete'||previous.state==='cancelled')fail('Terminal import runs cannot restart');
      if((args.state==='complete'||args.state==='cancelled')&&this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_import_work_groups WHERE run_id=? AND state IN('staging','sealed'))",[args.runId]))fail('Finish or discard unfinished work before ending the run');
      const next={...previous,state:args.state,summary:args.summary};jsonByteLength(next,65536);this.write('UPDATE quixi_import_runs SET payload=? WHERE id=?',[json(next),args.runId]);return next;
    });
  }
  importAllocateIds(args:Args<'importAllocateIds'>,nextId:()=>string):{key:string;id:string}[]{
    this.check('importAllocateIds',args);this.run(args.runId);
    return this.transaction(()=>{
      const result:{key:string;id:string}[]=[];
      for(const key of args.keys){const previous=this.rows('SELECT id FROM quixi_import_allocated_ids WHERE run_id=? AND key=?',[args.runId,key])[0];
        if(previous){result.push({key,id:String(previous.id)});continue;}
        const id=nextId();if(!isQuixiId(id))fail('ID allocator must supply a UUIDv4','INVALID_REQUEST');
        this.write('INSERT INTO quixi_import_allocated_ids VALUES(?,?,?)',[args.runId,key,id]);result.push({key,id});
      }
      jsonByteLength(result,1_000_000);return result;
    });
  }
  private active(runId:string):void{if(this.run(runId).state!=='running')fail('Resume the import run before modifying its work');}
  private ensureGroup(runId:string,groupKey:string):ImportWorkGroup{
    this.active(runId);this.write("INSERT OR IGNORE INTO quixi_import_work_groups(run_id,group_key,state) VALUES(?,?,'staging')",[runId,groupKey]);return this.group(runId,groupKey)!;
  }
  importWorkStage(args:Args<'importWorkStage'>):ImportWorkGroup{
    return this.operation('importWorkStage',args,()=>{
      const group=this.ensureGroup(args.runId,args.groupKey);if(group.state!=='staging')fail('Importer work group is frozen');let ordinal=group.recordCount;
      for(const record of args.records)this.write('INSERT INTO quixi_import_work(run_id,group_key,key,ordinal,parent_key,byte_start,byte_end,payload) VALUES(?,?,?,?,?,?,?,?)',[args.runId,args.groupKey,record.key,ordinal++,record.parentKey,record.byteStart,record.byteEnd,json(record.payload)]);
      this.write('UPDATE quixi_import_work_groups SET record_count=? WHERE run_id=? AND group_key=?',[ordinal,args.runId,args.groupKey]);return this.group(args.runId,args.groupKey)!;
    });
  }
  importWorkSeal(args:Args<'importWorkSeal'>):ImportWorkGroup{
    return this.operation('importWorkSeal',args,()=>{
      const group=this.ensureGroup(args.runId,args.groupKey);if(group.state!=='staging')fail('Importer work group is already frozen');
      this.write('UPDATE quixi_import_work SET pending_links=CASE WHEN parent_key IS NULL THEN 0 ELSE 1 END WHERE run_id=? AND group_key=?',[args.runId,args.groupKey]);
      this.write("UPDATE quixi_import_work_groups SET state='sealed',metadata=? WHERE run_id=? AND group_key=?",[json(args.metadata),args.runId,args.groupKey]);return this.group(args.runId,args.groupKey)!;
    });
  }
  importWorkGroupStatus(args:Args<'importWorkGroupStatus'>):ImportWorkGroup|null{this.check('importWorkGroupStatus',args);this.run(args.runId);return this.group(args.runId,args.groupKey);}
  private item(row:Row):ImportWorkItem{
    return {key:String(row.key),parentKey:row.parent_key===null?null:String(row.parent_key),byteStart:Number(row.byte_start),byteEnd:Number(row.byte_end),payload:JSON.parse(String(row.payload)) as JsonObject,ordinal:Number(row.ordinal),checkpoint:JSON.parse(String(row.checkpoint)) as JsonObject,checkpointRevision:Number(row.checkpoint_revision),state:String(row.state) as ImportWorkItem['state'],result:row.result===null?null:JSON.parse(String(row.result)) as ImportWorkResult,parentResult:row.parent_result===null?null:JSON.parse(String(row.parent_result)) as ImportWorkResult};
  }
  private itemQuery(where:string):string{return `SELECT w.*,p.result AS parent_result FROM quixi_import_work w LEFT JOIN quixi_import_work p ON p.run_id=w.run_id AND p.group_key=w.group_key AND p.key=w.parent_key WHERE ${where}`;}
  importWorkGet(args:Args<'importWorkGet'>):ImportWorkItem|null{
    this.check('importWorkGet',args);this.run(args.runId);
    const row=this.rows(this.itemQuery('w.run_id=? AND w.group_key=? AND w.key=?'),[args.runId,args.groupKey,args.key])[0];return row?this.item(row):null;
  }
  importWorkCheckpoint(args:Args<'importWorkCheckpoint'>):{revision:number;checkpoint:JsonObject}{
    return this.operation('importWorkCheckpoint',args,()=>{
      this.active(args.runId);const row=this.rows('SELECT state,checkpoint_revision FROM quixi_import_work WHERE run_id=? AND group_key=? AND key=?',[args.runId,args.groupKey,args.key])[0]??fail('Import work item not found','NOT_FOUND');
      if(row.state!=='pending'||row.checkpoint_revision!==args.expectedRevision)fail('Pending work checkpoint revision changed');
      this.write('UPDATE quixi_import_work SET checkpoint=?,checkpoint_revision=checkpoint_revision+1 WHERE run_id=? AND group_key=? AND key=?',[json(args.checkpoint),args.runId,args.groupKey,args.key]);
      return {revision:args.expectedRevision+1,checkpoint:args.checkpoint};
    });
  }
  importWorkResolve(args:Args<'importWorkResolve'>):ImportWorkGroup{
    return this.operation('importWorkResolve',args,()=>{
      this.active(args.runId);const group=this.group(args.runId,args.groupKey)??fail('Import work group not found','NOT_FOUND');if(group.state!=='sealed')fail('Seal the input group before resolving work');
      const row=this.rows('SELECT state,pending_links FROM quixi_import_work WHERE run_id=? AND group_key=? AND key=?',[args.runId,args.groupKey,args.key])[0]??fail('Import work item not found','NOT_FOUND');
      if(row.state!=='pending'||row.pending_links!==0)fail('Work must be unresolved with its predecessor resolved');
      this.write("UPDATE quixi_import_work SET state='resolved',result=? WHERE run_id=? AND group_key=? AND key=?",[json(args.result),args.runId,args.groupKey,args.key]);
      this.write('UPDATE quixi_import_work SET pending_links=0 WHERE run_id=? AND group_key=? AND parent_key=?',[args.runId,args.groupKey,args.key]);
      this.write('UPDATE quixi_import_work_groups SET resolved_count=resolved_count+1 WHERE run_id=? AND group_key=?',[args.runId,args.groupKey]);return this.group(args.runId,args.groupKey)!;
    });
  }
  importWorkRead(args:Args<'importWorkRead'>):ImportWorkOperations['importWorkRead']['result']{
    this.check('importWorkRead',args);const group=this.group(args.runId,args.groupKey)??fail('Import work group not found','NOT_FOUND');
    if(args.state==='ready'&&group.state!=='sealed')fail('Seal the input group before reading its ready queue');
    let after=-1;if(args.page.cursor!==null){const cursor=this.cursor(args.page.cursor,{runId:args.runId,groupKey:args.groupKey,state:args.state});if(typeof cursor.after!=='number'||!Number.isSafeInteger(cursor.after)||cursor.after<0)fail('Invalid work ordinal cursor','INVALID_REQUEST');after=Number(cursor.after);}
    const ready=args.state==='ready'?" AND w.state='pending' AND w.pending_links=0":'';const items:ImportWorkItem[]=[];let bytes=2,last=after,more=false;
    for(let i=0;i<=args.page.maxItems;i++){
      const row=this.rows(this.itemQuery(`w.run_id=? AND w.group_key=? AND w.ordinal>?${ready} ORDER BY w.ordinal LIMIT 1`),[args.runId,args.groupKey,last])[0];if(!row)break;
      const item=this.item(row),additional=jsonByteLength(item)+(items.length?1:0);
      if(i===args.page.maxItems||bytes+additional>Math.min(args.page.maxBytes,1_000_000)){if(!items.length)fail('Work page cannot fit the next bounded record','INVALID_REQUEST');more=true;break;}
      items.push(item);bytes+=additional;last=item.ordinal;
    }
    let blocked:'missing_parent'|'cycle'|null=null;
    if(args.state==='ready'&&!items.length&&group.resolvedCount<group.recordCount){blocked=this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_import_work w LEFT JOIN quixi_import_work p ON p.run_id=w.run_id AND p.group_key=w.group_key AND p.key=w.parent_key WHERE w.run_id=? AND w.group_key=? AND w.state='pending' AND w.parent_key IS NOT NULL AND p.key IS NULL)",[args.runId,args.groupKey])?'missing_parent':'cycle';}
    return {items,bytes,blocked,nextCursor:more&&args.state==='all'?json({runId:args.runId,groupKey:args.groupKey,state:args.state,after:last}):null};
  }
  importGroupFinish(args:Args<'importGroupFinish'>):ImportWorkGroup{
    return this.operation('importGroupFinish',args,()=>{
      this.active(args.runId);const group=this.ensureGroup(args.runId,args.groupKey);if(!['staging','sealed'].includes(group.state))fail('Import work group is already finished');
      if(args.outcome==='published'){
        if(group.state!=='sealed'||group.resolvedCount!==group.recordCount||!args.normalizedImportId)fail('Publication requires resolved work and its canonical group');
        if(!this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_import_jobs WHERE id=? AND state='published')",[args.normalizedImportId]))fail('Canonical import publication has not committed');
      }else if(args.outcome==='complete'){if(group.state!=='sealed'||group.resolvedCount!==group.recordCount||args.normalizedImportId!==null)fail('Generic work completion requires all work resolved and no canonical publication claim');
      }else if(args.normalizedImportId&&!this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_import_jobs WHERE id=? AND state='cancelled')",[args.normalizedImportId]))fail('Cancel unfinished canonical staging before discarding work');
      this.write('DELETE FROM quixi_import_work WHERE run_id=? AND group_key=?',[args.runId,args.groupKey]);
      this.write('UPDATE quixi_import_work_groups SET state=?,report=?,normalized_import_id=? WHERE run_id=? AND group_key=?',[args.outcome,json(args.report),args.normalizedImportId,args.runId,args.groupKey]);return this.group(args.runId,args.groupKey)!;
    });
  }
  private cursor(value:string,scope:Record<string,unknown>):Record<string,unknown>{
    let cursor:Record<string,unknown>|undefined;try{cursor=JSON.parse(value) as typeof cursor;}catch{fail('Invalid importer page cursor','INVALID_REQUEST');}
    if(!cursor||typeof cursor!=='object'||Object.entries(scope).some(([key,value])=>cursor![key]!==value))fail('Importer cursor belongs to another query','INVALID_REQUEST');return cursor!;
  }
  private page(page:PageBudget,scope:Record<string,unknown>,next:(after:string)=>{key:string;item:JsonValue}|null):EntityPage{
    let after='';if(page.cursor!==null){const cursor=this.cursor(page.cursor,scope);if(typeof cursor.after!=='string')fail('Invalid importer key cursor','INVALID_REQUEST');after=cursor.after as string;}
    const items:JsonValue[]=[];let bytes=2,last=after,more=false;
    for(let i=0;i<=page.maxItems;i++){const row=next(last);if(!row)break;const additional=jsonByteLength(row.item)+(items.length?1:0);
      if(i===page.maxItems||bytes+additional>Math.min(page.maxBytes,1_000_000)){if(!items.length)fail('Importer page budget is too small','INVALID_REQUEST');more=true;break;}
      items.push(row.item);bytes+=additional;last=row.key;
    }
    return {items,bytes,nextCursor:more?json({...scope,after:last}):null};
  }
  importRunReadGroups(args:Args<'importRunReadGroups'>):EntityPage{
    this.check('importRunReadGroups',args);this.run(args.runId);
    return this.page(args.page,{runId:args.runId},after=>{const row=this.rows('SELECT group_key FROM quixi_import_work_groups WHERE run_id=? AND group_key>? ORDER BY group_key LIMIT 1',[args.runId,after])[0];return row?{key:String(row.group_key),item:this.group(args.runId,String(row.group_key)) as unknown as JsonValue}:null;});
  }
  importRunList(args:Args<'importRunList'>):EntityPage{
    this.check('importRunList',args);
    return this.page(args.page,{state:args.state},after=>{const row=this.rows(`SELECT id,payload FROM quixi_import_runs WHERE id>?${args.state===null?'':" AND json_extract(payload,'$.state')=?"} ORDER BY id LIMIT 1`,args.state===null?[after]:[after,args.state])[0];return row?{key:String(row.id),item:JSON.parse(String(row.payload)) as JsonValue}:null;});
  }
}
