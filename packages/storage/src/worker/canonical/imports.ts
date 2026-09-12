import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertStorageRequest, canonicalJson, jsonByteLength, NORMALIZED_IMPORT_LIMITS } from '@quixi/core/contracts';
import type { NormalizedImportOperations, NormalizedImportStatus, StagedImportRecord, ImportCollection } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import type { EntityKind, JsonValue, Message, Generation, ContentPart, ThreadState, Thread, Document } from '@quixi/core/model';
import type { CanonicalSqlite, CanonicalRepositoryOptions, SqlValue } from './repository.ts';

type Row=Record<string,SqlValue>;
type Job=Row;
type Operation=keyof NormalizedImportOperations;
type Args<K extends Operation>=NormalizedImportOperations[K]['args'];
const kinds:Record<ImportCollection,EntityKind>={summaryProposals:'summaryProposal',threads:'thread',threadStates:'threadState',contexts:'context',messages:'message',generations:'generation',parts:'part',events:'event',attachments:'attachment',documents:'document',rawObjects:'rawObject',importSources:'importSource',sourceIdentities:'sourceIdentity',provenance:'provenance'};
const json=(value:unknown)=>canonicalJson(value as JsonValue);
const hash=(value:unknown)=>bytesToHex(sha256(new TextEncoder().encode(json(value))));
const fail=(message:string,code:'CONFLICT'|'NOT_FOUND'|'INVALID_REQUEST'='CONFLICT'):never=>{throw Object.assign(new Error(message),{code});};
const requestId='00000000-0000-4000-8000-000000000000';
/** All SQL is private and synchronous. Staging never changes canonical records or allocates a sync sequence. */
export class NormalizedImportRepository {
  // At most maxActiveJobs entries. A new owner must revalidate catalog evidence and live references.
  private sessions=new Map<string,number>();
  constructor(private db:CanonicalSqlite,private options:CanonicalRepositoryOptions,
    private validateRecord:(scope:CanonicalSqlite,collection:ImportCollection,id:string,stages:readonly string[])=>void){}
  private rows(sql:string,bind:SqlValue[]=[]):Row[]{return this.db.exec({sql,...(bind.length?{bind}:{}),rowMode:'object',returnValue:'resultRows'}) as Row[];}
  private scalar(sql:string,bind:SqlValue[]=[]):number{return Number(bind.length?this.db.selectValue(sql,bind):this.db.selectValue(sql));}
  private write(sql:string,bind:SqlValue[]=[]):void{this.db.exec({sql,...(bind.length?{bind}:{})});}
  private job(id:string):Job{return this.rows('SELECT * FROM quixi_import_jobs WHERE id=?',[id])[0]??fail('Normalized import not found','NOT_FOUND');}
  private highWater():number{return this.scalar('SELECT coalesce(max(sequence),0) FROM quixi_sync_ops');}
  private status(job:Job):NormalizedImportStatus{
    let state=String(job.state) as NormalizedImportStatus['state'];
    if(state==='ready'&&this.sessions.get(String(job.id))!==this.highWater())state='validating';
    return {importId:String(job.id),threadId:String(job.thread_id),mode:String(job.mode) as 'create'|'extend',state,nextSequence:Number(job.next_sequence),recordCount:Number(job.record_count),validatedRecords:Number(job.validation_cursor)+1,manifestDigest:String(job.manifest_digest),publicationOperationId:job.publication_operation_id===null?null:String(job.publication_operation_id)};
  }
  private check<K extends Operation>(operation:K,args:Args<K>):void{
    assertStorageRequest({version:1,requestId,operation,args} as Parameters<typeof assertStorageRequest>[0]);
  }
  committedImportOperation<K extends Exclude<Operation,'normalizedImportStatus'|'readStagedImportRecords'>>(operation:K,args:Args<K>):NormalizedImportStatus|null{
    this.check(operation,args);
    const row=this.rows('SELECT identity,result FROM quixi_import_operations WHERE operation_id=?',[args.operationId])[0];
    if(!row)return null;if(row.identity!==hash({operation,args}))fail('Import operation identity reused with different payload');
    return JSON.parse(String(row.result)) as NormalizedImportStatus;
  }
  private operation<K extends Exclude<Operation,'normalizedImportStatus'|'readStagedImportRecords'>>(operation:K,args:Args<K>,work:()=>NormalizedImportStatus):NormalizedImportStatus{
    this.check(operation,args);const identity=hash({operation,args});
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.rows('SELECT identity,result FROM quixi_import_operations WHERE operation_id=?',[args.operationId])[0];
      if(previous){if(previous.identity!==identity)fail('Import operation identity reused with different payload');this.db.exec('COMMIT');return JSON.parse(String(previous.result)) as NormalizedImportStatus;}
      if(this.scalar('SELECT EXISTS(SELECT 1 FROM quixi_sync_ops WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_import_record_identities WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_blob_operations WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_import_work_operations WHERE operation_id=?)',[args.operationId,args.operationId,args.operationId,args.operationId]))fail('Operation identity is already reserved');
      const result=work();
      this.write('INSERT INTO quixi_import_operations VALUES(?,?,?,?)',[args.operationId,args.importId,identity,json(result)]);
      this.db.exec('COMMIT');return result;
    }catch(error){try{this.db.exec('ROLLBACK');}catch{/* FULL/IO may already have rolled back. */}
      if(error&&typeof error==='object'&&'resultCode'in error&&(Number(error.resultCode)&255)===19)fail(`Import SQL constraint rejected publication: ${String(error)}`);
      throw error;
    }
  }
  private checkBase(job:Job):void{
    const thread=this.rows("SELECT payload FROM quixi_records WHERE collection='threads' AND id=?",[job.thread_id!])[0];
    if(job.mode==='create'){if(thread)fail('Import target thread already exists');}
    else{
      const state=this.rows("SELECT json_extract(payload,'$.revision') AS revision FROM quixi_records WHERE collection='threadStates' AND id=?",[job.thread_id!])[0];
      if(!thread||!state)fail('Import extension target is missing','NOT_FOUND');
      if(state!.revision!==job.expected_revision)fail('Import extension thread revision changed');
      if(this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_records WHERE collection='tombstones' AND thread_id=? AND json_extract(payload,'$.rootMessageId') IS NULL)",[job.thread_id!]))fail('Cannot extend a deleted thread');
    }
  }
  /** Owner records links and awaits catalog publication before this durable acknowledgement. */
  completeImportBlobPreparation(args:Args<'prepareImportBlobs'>):NormalizedImportStatus{
    return this.operation('prepareImportBlobs',args,()=>{
      const job=this.job(args.importId);if(job.state==='published'||job.state==='cancelled')fail('Import is no longer preparing bytes');
      for(const transferId of args.stagedBlobIds)if(!this.scalar('SELECT EXISTS(SELECT 1 FROM quixi_import_blob_transfers WHERE import_id=? AND transfer_id=?)',[args.importId,transferId]))fail('Import transfer must be durably linked before acknowledgement');
      return this.status(job);
    });
  }
  beginNormalizedImport(args:Args<'beginNormalizedImport'>):NormalizedImportStatus{
    return this.operation('beginNormalizedImport',args,()=>{
      if(this.rows('SELECT id FROM quixi_import_jobs WHERE id=?',[args.importId]).length)fail('Import ID already exists; retry its original begin operation');
      if(this.scalar("SELECT count(*) FROM quixi_import_jobs WHERE state NOT IN('published','cancelled')")>=NORMALIZED_IMPORT_LIMITS.maxActiveJobs)fail('Too many unfinished import groups; resume or cancel an existing group');
      const job={thread_id:args.threadId,mode:args.mode,expected_revision:args.expectedThreadRevision};this.checkBase(job);
      this.write("INSERT INTO quixi_import_jobs(id,thread_id,mode,expected_revision,recorded_at,state) VALUES(?,?,?,?,?,'staging')",[args.importId,args.threadId,args.mode,args.expectedThreadRevision,args.recordedAt]);
      return this.status(this.job(args.importId));
    });
  }
  stageImportRecords(args:Args<'stageImportRecords'>):NormalizedImportStatus{
    return this.operation('stageImportRecords',args,()=>{
      const job=this.job(args.importId);if(job.state!=='staging')fail('Import records are frozen');
      if(job.next_sequence!==args.sequence)fail('Import sequence must advance exactly once');
      let ordinal=Number(job.record_count),digest=String(job.manifest_digest);
      for(const entry of args.records){
        const {collection,record,operationId,recordedAt}=entry;const id='id'in record?record.id:record.threadId;
        if(this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_records WHERE id=? AND(collection=? OR(collection!='threadStates' AND ?!='threadStates')))",[id,collection,collection]))fail('Import records must add new immutable identities; resolve existing source identities before staging');
        if(this.scalar('SELECT EXISTS(SELECT 1 FROM quixi_sync_ops WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_import_operations WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_blob_operations WHERE operation_id=? UNION ALL SELECT 1 FROM quixi_import_work_operations WHERE operation_id=?)',[operationId,operationId,operationId,operationId]))fail('Imported operation identity already exists');
        if('threadId'in record&&record.threadId!==job.thread_id)fail('Imported record belongs to another thread','INVALID_REQUEST');
        if(collection==='threads'&&(id!==job.thread_id||job.mode!=='create'))fail('Only create imports may stage their declared thread','INVALID_REQUEST');
        if(collection==='threadStates'&&job.mode!=='create')fail('Import extensions preserve existing user state','INVALID_REQUEST');
        if(collection==='messages'&&!(record as Message).sealed)fail('Imported messages must be sealed','INVALID_REQUEST');
        if(collection==='generations'&&(record as Generation).status==='streaming')fail('Imported attempts cannot claim an active producer','INVALID_REQUEST');
        if(collection==='sourceIdentities'){
          const r=record as Extract<StagedImportRecord,{collection:'sourceIdentities'}>['record'];
          if(this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_records WHERE collection='sourceIdentities' AND json_extract(payload,'$.provider')=? AND json_extract(payload,'$.accountScope')=? AND coalesce(json_extract(payload,'$.sourceThreadId'),'')=? AND json_extract(payload,'$.sourceContainerKey')=? AND json_extract(payload,'$.entityKind')=? AND json_extract(payload,'$.nativeId')=?)",[r.provider,r.accountScope,r.sourceThreadId??'',r.sourceContainerKey,r.entityKind,r.nativeId]))fail('Native source identity already has a canonical mapping');
        }
        const payload={importId:args.importId,ordinal,collection,record};
        const operation={version:1,operationId,kind:'ImportRecord',recordedAt,payload};const identity=hash(operation);
        const affects=[{kind:kinds[collection],id}];
        this.write('INSERT INTO quixi_import_record_identities VALUES(?,?,?)',[operationId,args.importId,identity]);
        this.write('INSERT INTO quixi_import_records(import_id,ordinal,collection,id,payload,operation_id,recorded_at,identity,sync_payload,affects) VALUES(?,?,?,?,?,?,?,?,?,?)',[args.importId,ordinal,collection,id,json(record),operationId,recordedAt,identity,json(payload),json(affects)]);
        digest=hash([digest,identity]);ordinal++;
      }
      this.write('UPDATE quixi_import_jobs SET next_sequence=next_sequence+1,record_count=?,manifest_digest=? WHERE id=?',[ordinal,digest,args.importId]);
      return this.status(this.job(args.importId));
    });
  }
  /** Validation queries see exactly this frozen group plus committed records. No other job can satisfy references. */
  private scopedDb(importId:string):CanonicalSqlite{
    // importId has already passed the UUID envelope validator; no caller SQL is interpolated.
    const scope=`(SELECT collection,id,payload,thread_id,parent_id,message_id,generation_id FROM quixi_import_records WHERE import_id='${importId}' UNION ALL SELECT collection,id,payload,thread_id,parent_id,message_id,generation_id FROM quixi_records)`;
    const transform=(sql:string):string=>{
      if(sql.startsWith('INSERT INTO quixi_edges VALUES('))return sql.replace('INSERT INTO quixi_edges VALUES(',`INSERT INTO quixi_import_edges VALUES('${importId}',`);
      if(sql.startsWith('DELETE FROM quixi_edges WHERE '))return sql.replace('DELETE FROM quixi_edges WHERE ',`DELETE FROM quixi_import_edges WHERE import_id='${importId}' AND `);
      return sql.replaceAll('quixi_records',scope);
    };
    return {exec:(options)=>this.db.exec(typeof options==='string'?transform(options):{...options,sql:transform(options.sql)}),selectValue:(sql,bind)=>bind?.length?this.db.selectValue(transform(sql),bind):this.db.selectValue(transform(sql))};
  }
  private resetValidation(job:Job,highWater:number):void{
    const id=String(job.id);this.checkBase(job);
    if(job.mode==='create'&&this.scalar("SELECT count(*) FROM quixi_import_records WHERE import_id=? AND collection IN('threads','threadStates')",[id])!==2)fail('Complete import requires its thread and explicit state','INVALID_REQUEST');
    if(Number(job.record_count)===0)fail('Empty import group','INVALID_REQUEST');
    this.write('DELETE FROM quixi_import_edges WHERE import_id=?',[id]);
    // Missing links cannot become ready. Existing records are immutable, and both ancestry/edit links must form a DAG.
    this.write(`UPDATE quixi_import_records AS m SET topology_checked=0,pending_links=
      CASE WHEN m.parent_id IS NULL THEN 0 WHEN EXISTS(SELECT 1 FROM quixi_import_records p WHERE p.import_id=m.import_id AND p.collection='messages' AND p.id=m.parent_id) THEN 1 WHEN EXISTS(SELECT 1 FROM quixi_records p WHERE p.collection='messages' AND p.id=m.parent_id) THEN 0 ELSE 3 END+
      CASE WHEN m.edited_from IS NULL THEN 0 WHEN EXISTS(SELECT 1 FROM quixi_import_records p WHERE p.import_id=m.import_id AND p.collection='messages' AND p.id=m.edited_from) THEN 1 WHEN EXISTS(SELECT 1 FROM quixi_records p WHERE p.collection='messages' AND p.id=m.edited_from) THEN 0 ELSE 3 END
      WHERE import_id=? AND collection='messages'`,[id]);
    this.write("UPDATE quixi_import_jobs SET state='validating',validation_cursor=-1,validation_phase='topology',topology_remaining=(SELECT count(*) FROM quixi_import_records WHERE import_id=?2 AND collection='messages'),validation_high_water=?1 WHERE id=?2",[highWater,id]);
  }
  validateImportStep(args:Args<'validateImportStep'>):NormalizedImportStatus{
    let session:number|undefined;
    const result=this.operation('validateImportStep',args,()=>{
      let job=this.job(args.importId);if(job.state==='published'||job.state==='cancelled')return this.status(job);
      const highWater=this.highWater();
      if(job.state==='staging'||this.sessions.get(args.importId)!==highWater||job.validation_high_water!==highWater)this.resetValidation(job,highWater);
      job=this.job(args.importId);session=highWater;
      let remaining=args.maxRecords;const initialRemaining=remaining;
      if(job.validation_phase==='topology'){
        while(remaining>0){
          const next=this.rows("SELECT id FROM quixi_import_records WHERE import_id=? AND collection='messages' AND topology_checked=0 AND pending_links=0 ORDER BY ordinal LIMIT 1",[args.importId])[0];
          if(!next){
            if(this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_import_records WHERE import_id=? AND collection='messages' AND topology_checked=0)",[args.importId]))fail('Import message graph has a cycle or missing predecessor','INVALID_REQUEST');
            this.write("UPDATE quixi_import_jobs SET validation_phase='records' WHERE id=?",[args.importId]);break;
          }
          this.write("UPDATE quixi_import_records SET topology_checked=1 WHERE import_id=? AND collection='messages' AND id=?",[args.importId,next.id!]);
          this.write("UPDATE quixi_import_records SET pending_links=pending_links-1 WHERE import_id=? AND collection='messages' AND parent_id=?",[args.importId,next.id!]);
          this.write("UPDATE quixi_import_records SET pending_links=pending_links-1 WHERE import_id=? AND collection='messages' AND edited_from=?",[args.importId,next.id!]);remaining--;
        }
      }
      this.write('UPDATE quixi_import_jobs SET topology_remaining=topology_remaining-? WHERE id=?',[initialRemaining-remaining,args.importId]);
      job=this.job(args.importId);
      if(job.validation_phase==='records'){
        const scope=this.scopedDb(args.importId);let cursor=Number(job.validation_cursor);
        while(remaining>0){
          const row=this.rows('SELECT ordinal,collection,id,payload FROM quixi_import_records WHERE import_id=? AND ordinal>? ORDER BY ordinal LIMIT 1',[args.importId,cursor])[0];
          if(!row)break;
          const collection=String(row.collection) as ImportCollection;
          const record=JSON.parse(String(row.payload)) as StagedImportRecord['record'];
          if(collection==='parts'&&!this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_import_records WHERE import_id=? AND collection='messages' AND id=?)",[args.importId,(record as ContentPart).messageId]))fail('Imported parts must belong to a new staged message; sealed history is immutable','INVALID_REQUEST');
          if(collection==='generations'&&!this.scalar("SELECT EXISTS(SELECT 1 FROM quixi_import_records WHERE import_id=? AND collection='messages' AND id=?)",[args.importId,(record as Generation).outputMessageId]))fail('Imported generation requires its new staged output','INVALID_REQUEST');
          if(collection==='documents'){
            const threadPayload=scope.selectValue("SELECT payload FROM quixi_records WHERE collection='threads' AND id=?",[job.thread_id!]);
            if(!threadPayload||(record as Document).workspaceId!==(JSON.parse(String(threadPayload)) as Thread).workspaceId)fail('Imported document workspace differs from its group','INVALID_REQUEST');
          }
          this.validateRecord(scope,collection,String(row.id),args.stagedBlobIds);
          cursor=Number(row.ordinal);remaining--;
        }
        this.write('UPDATE quixi_import_jobs SET validation_cursor=? WHERE id=?',[cursor,args.importId]);
        if(cursor+1===Number(job.record_count))this.write("UPDATE quixi_import_jobs SET state='ready' WHERE id=?",[args.importId]);
      }
      const status=this.status(this.job(args.importId));
      // Session proof is installed only after COMMIT; this call's response reflects its successful work.
      if(this.job(args.importId).state==='ready')status.state='ready';return status;
    });
    if(session!==undefined)this.sessions.set(args.importId,session);
    return result;
  }
  finalizeNormalizedImport(args:Args<'finalizeNormalizedImport'>):NormalizedImportStatus{
    const result=this.operation('finalizeNormalizedImport',args,()=>{
      const job=this.job(args.importId);
      if(job.state==='published')fail('Import already published; retry the original publication identity');
      if(job.state!=='ready'||this.sessions.get(args.importId)!==this.highWater()||job.validation_high_water!==this.highWater())fail('Import needs incremental validation in this owner against current canonical state');
      if(job.record_count!==args.expectedRecordCount||job.manifest_digest!==args.expectedManifestDigest)fail('Publication count/digest does not match frozen records');
      this.checkBase(job);
      // Verification may have been revoked by a failed read without changing the canonical sync high-water.
      // Recheck one bounded catalog reference at a time. No file I/O or whole manifest is materialized here.
      let blobOrdinal=-1;
      while(true){
        const row=this.rows("SELECT ordinal,collection,payload FROM quixi_import_records WHERE import_id=? AND ordinal>? AND(collection IN('attachments','rawObjects') OR(collection='parts' AND json_type(payload,'$.data.textBlob')='object')) ORDER BY ordinal LIMIT 1",[args.importId,blobOrdinal]);
        if(!row[0])break;const item=row[0];blobOrdinal=Number(item.ordinal);
        const record=JSON.parse(String(item.payload)) as Record<string,unknown>;
        if(item.collection==='parts'){
          const blob=(record.data as {textBlob:{sha256:string;byteLength:number}}).textBlob;
          this.options.assertBlobAvailable(blob.sha256,blob.byteLength,[],'utf-8');
        }else if(record.availability==='available'){
          this.options.assertBlobAvailable(String(record.blobSha256??record.sha256),Number(record.sizeBytes??record.byteLength),[]);
        }
      }
      this.write("UPDATE quixi_import_jobs SET state='publishing' WHERE id=?",[args.importId]);
      this.write('INSERT INTO quixi_records(collection,id,payload) SELECT collection,id,payload FROM quixi_import_records WHERE import_id=? ORDER BY ordinal',[args.importId]);
      this.write('INSERT INTO quixi_edges SELECT owner_collection,owner_id,field,target_collection,target_id FROM quixi_import_edges WHERE import_id=?',[args.importId]);
      this.write("INSERT INTO quixi_sync_ops(operation_id,kind,recorded_at,identity,payload,affects,result) SELECT operation_id,'ImportRecord',recorded_at,identity,sync_payload,affects,json_object('importId',import_id,'ordinal',ordinal) FROM quixi_import_records WHERE import_id=? ORDER BY ordinal",[args.importId]);
      const payload={importId:args.importId,threadId:String(job.thread_id),mode:String(job.mode),recordCount:args.expectedRecordCount,manifestDigest:args.expectedManifestDigest};
      const marker={version:1,operationId:args.operationId,kind:'PublishImport',recordedAt:args.recordedAt,payload};
      this.write("INSERT INTO quixi_sync_ops(operation_id,kind,recorded_at,identity,payload,affects,result) VALUES(?,'PublishImport',?,?,?,'[]',?)",[args.operationId,args.recordedAt,hash(marker),json(payload),json({importId:args.importId,state:'published'})]);
      this.write("UPDATE quixi_import_jobs SET state='published',publication_operation_id=? WHERE id=?",[args.operationId,args.importId]);
      this.write('DELETE FROM quixi_import_edges WHERE import_id=?',[args.importId]);
      this.write('DELETE FROM quixi_import_records WHERE import_id=?',[args.importId]);
      this.options.beforeCommit?.();return this.status(this.job(args.importId));
    });
    this.sessions.delete(args.importId);return result;
  }
  cancelNormalizedImport(args:Args<'cancelNormalizedImport'>):NormalizedImportStatus{
    const result=this.operation('cancelNormalizedImport',args,()=>{
      const job=this.job(args.importId);if(job.state==='published'||job.state==='cancelled')return this.status(job);
      this.write('DELETE FROM quixi_import_edges WHERE import_id=?',[args.importId]);this.write('DELETE FROM quixi_import_records WHERE import_id=?',[args.importId]);
      this.write("UPDATE quixi_import_jobs SET state='cancelled' WHERE id=?",[args.importId]);return this.status(this.job(args.importId));
    });this.sessions.delete(args.importId);return result;
  }
  /** No OO statement is held across a yield. Caller may await bounded byte verification between records. */
  *importValidationRecords(args:{importId:string;maxRecords:number}):IterableIterator<StagedImportRecord>{
    this.check('validateImportStep',{...args,operationId:requestId,stagedBlobIds:[]});
    const job=this.job(args.importId);if(job.state==='published'||job.state==='cancelled')return;
    const reset=job.state==='staging'||this.sessions.get(args.importId)!==this.highWater()||job.validation_high_water!==this.highWater();
    const topology=reset?this.scalar("SELECT count(*) FROM quixi_import_records WHERE import_id=? AND collection='messages'",[args.importId]):Number(job.topology_remaining);
    let remaining=Math.max(0,args.maxRecords-topology),cursor=reset?-1:Number(job.validation_cursor);
    while(remaining-->0){
      const row=this.rows('SELECT ordinal,collection,payload,operation_id,recorded_at FROM quixi_import_records WHERE import_id=? AND ordinal>? ORDER BY ordinal LIMIT 1',[args.importId,cursor])[0];if(!row)break;
      cursor=Number(row.ordinal);
      yield {collection:String(row.collection),record:JSON.parse(String(row.payload)),operationId:String(row.operation_id),recordedAt:Number(row.recorded_at)} as StagedImportRecord;
    }
  }
  recordImportBlobTransfers(importId:string,transferIds:readonly string[]):void{
    if(!isQuixiId(importId)||transferIds.length>128||!transferIds.every(isQuixiId))fail('Invalid bounded import transfers','INVALID_REQUEST');
    const job=this.job(importId);if(job.state==='published'||job.state==='cancelled')fail('Import is no longer accepting staged transfers');
    this.db.exec('BEGIN IMMEDIATE');try{
      for(const id of transferIds)this.write('INSERT OR IGNORE INTO quixi_import_blob_transfers VALUES(?,?)',[importId,id]);
      this.db.exec('COMMIT');
    }catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  readImportBlobTransfers(importId:string,page:{after:string|null;maxItems:number}):string[]{
    if(!isQuixiId(importId)||(page.after!==null&&!isQuixiId(page.after))||!Number.isSafeInteger(page.maxItems)||page.maxItems<1||page.maxItems>128)fail('Invalid import transfer page','INVALID_REQUEST');
    this.job(importId);return this.rows('SELECT transfer_id FROM quixi_import_blob_transfers WHERE import_id=? AND transfer_id>? ORDER BY transfer_id LIMIT ?',[importId,page.after??'',page.maxItems]).map(row=>String(row.transfer_id));
  }
  forgetImportBlobTransfer(importId:string,transferId:string):void{
    if(!isQuixiId(importId)||!isQuixiId(transferId))fail('Invalid import transfer identity','INVALID_REQUEST');
    this.write('DELETE FROM quixi_import_blob_transfers WHERE import_id=? AND transfer_id=?',[importId,transferId]);
  }
  normalizedImportStatus(args:Args<'normalizedImportStatus'>):NormalizedImportStatus{this.check('normalizedImportStatus',args);return this.status(this.job(args.importId));}
  readStagedImportRecords(args:Args<'readStagedImportRecords'>):NormalizedImportOperations['readStagedImportRecords']['result']{
    this.check('readStagedImportRecords',args);this.job(args.importId);let after=-1;
    if(args.page.cursor!==null){let cursor:{importId?:string;after?:number}|undefined;try{cursor=JSON.parse(args.page.cursor) as typeof cursor;}catch{fail('Invalid import cursor','INVALID_REQUEST');}
      if(!cursor||cursor.importId!==args.importId||!Number.isSafeInteger(cursor.after)||cursor.after!<0)fail('Import cursor belongs to another query','INVALID_REQUEST');after=cursor!.after!;}
    const items:JsonValue[]=[];let bytes=2,last=after,more=false;
    for(let i=0;i<=args.page.maxItems;i++){
      const row=this.rows('SELECT ordinal,collection,payload,operation_id,recorded_at FROM quixi_import_records WHERE import_id=? AND ordinal>? ORDER BY ordinal LIMIT 1',[args.importId,last])[0];if(!row)break;
      const item={collection:String(row.collection),record:JSON.parse(String(row.payload)) as JsonValue,operationId:String(row.operation_id),recordedAt:Number(row.recorded_at)};
      const additional=jsonByteLength(item)+(items.length?1:0);
      if(i===args.page.maxItems||bytes+additional>Math.min(args.page.maxBytes,1_000_000)){if(!items.length)fail('Import page byte budget is too small','INVALID_REQUEST');more=true;break;}
      items.push(item);bytes+=additional;last=Number(row.ordinal);
    }
    return {items,bytes,nextCursor:more?JSON.stringify({importId:args.importId,after:last}):null};
  }
}
