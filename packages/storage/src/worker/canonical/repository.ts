import { assertSummaryCutoff, readSummaryOutputText, summarySourceInfo, summaryTextDigest } from './summary-source.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertStorageRequest, canonicalJson, jsonByteLength, STORAGE_BOUNDARIES } from '@quixi/core/contracts';
import type { CanonicalMutation, CommitResult, EntityPage, MutationBatch, NormalizedImportOperations, StorageOperations } from '@quixi/core/contracts';
import { contextSummary, SUMMARY_INSTRUCTION, assertGenerationTransition, isQuixiId, ModelValidationError, validateEntityShape } from '@quixi/core/model';
import type { CanonicalHistory, ContextSnapshot, ReviewedSummary, ContentPart, EntityKind, EntityReference, Generation, JsonValue, Message, SourceIdentity, ThreadState, Tombstone } from '@quixi/core/model';
import { ImportWorkRepository } from './import-work.ts';
import { NormalizedImportRepository } from './imports.ts';
import { CANONICAL_MIGRATIONS } from '../../../migrations/index.ts';

export type SqlValue = string | number | null | Uint8Array;
export interface CanonicalSqlite {
  exec(options: string | {sql:string;bind?:SqlValue[];rowMode?:'object';returnValue?:'resultRows'}): unknown;
  selectValue(sql:string,bind?:SqlValue[]): SqlValue;
}
type Collection = Exclude<keyof CanonicalHistory,'version'>;
type RecordFor<K extends Collection> = NonNullable<CanonicalHistory[K]>[number];
const kinds:Record<Collection,EntityKind>={summaryProposals:'summaryProposal',threads:'thread',threadStates:'threadState',contexts:'context',messages:'message',generations:'generation',parts:'part',events:'event',attachments:'attachment',documents:'document',rawObjects:'rawObject',importSources:'importSource',sourceIdentities:'sourceIdentity',provenance:'provenance',tombstones:'tombstone'};
const collections=Object.fromEntries(Object.entries(kinds).map(([collection,kind])=>[kind,collection])) as Record<EntityKind,Collection>;
export const CANONICAL_LIMITS=Object.freeze({maxRecordBytes:262_144,maxRecoveryBatch:32,maxPageBytes:1_000_000});
export class CanonicalStorageError extends Error {
  constructor(readonly code:'INVALID_REQUEST'|'CONFLICT'|'NOT_FOUND'|'MIGRATION_FAILED',message:string){super(message);this.name='CanonicalStorageError';}
}
export interface CanonicalRepositoryOptions {
  /** Synchronous verified catalog lookup; byte publication/verification precedes SQL. */
  assertBlobAvailable(sha256:string,byteLength:number,stagedBlobIds:readonly string[],requiredEncoding?:"utf-8"):void;
  /** Failure injection only. Called after all record/op writes but before COMMIT. */
  beforeCommit?:()=>void;
}
const json=(value:unknown)=>canonicalJson(value as JsonValue);
const identity=(value:unknown)=>bytesToHex(sha256(new TextEncoder().encode(json(value))));
function fail(code:CanonicalStorageError['code'],message:string):never{throw new CanonicalStorageError(code,message);}

/** Sole-worker-owned SQL repository. Public methods are synchronous and never yield inside a transaction. */
export class CanonicalRepository {
  private changes=new Map<string,EntityReference>();
  private stages:readonly string[]=[];
  private insertedMessages=new Set<string>();
  private importRepository:NormalizedImportRepository|null=null;
  private workRepository:ImportWorkRepository|null=null;
  private work():ImportWorkRepository{return this.workRepository??=new ImportWorkRepository(this.db);}
  constructor(private readonly db:CanonicalSqlite,private readonly options:CanonicalRepositoryOptions){}
  private imports():NormalizedImportRepository{
    return this.importRepository??=new NormalizedImportRepository(this.db,this.options,(scope,collection,id,stages)=>{
      const validator=new CanonicalRepository(scope,this.options);validator.stages=stages;
      if(collection==='messages')validator.insertedMessages.add(id);
      validator.validate({kind:kinds[collection],id});
      if(collection==='messages'){
        const message=validator.require('messages',id);
        if(validator.hidden(message.threadId,id))fail('CONFLICT','Cannot import history into a deleted subtree');
        if(message.parentId&&!validator.require('messages',message.parentId).sealed)fail('CONFLICT','Imported history requires a sealed parent');
      }
    });
  }
  importRunBegin(args:StorageOperations['importRunBegin']['args']){return this.work().importRunBegin(args);}
  importRunStatus(args:StorageOperations['importRunStatus']['args']){return this.work().importRunStatus(args);}
  importRunSetState(args:StorageOperations['importRunSetState']['args']){return this.work().importRunSetState(args);}
  importRunReadGroups(args:StorageOperations['importRunReadGroups']['args']){return this.work().importRunReadGroups(args);}
  importRunList(args:StorageOperations['importRunList']['args']){return this.work().importRunList(args);}
  importWorkStage(args:StorageOperations['importWorkStage']['args']){return this.work().importWorkStage(args);}
  importWorkSeal(args:StorageOperations['importWorkSeal']['args']){return this.work().importWorkSeal(args);}
  importWorkGroupStatus(args:StorageOperations['importWorkGroupStatus']['args']){return this.work().importWorkGroupStatus(args);}
  importWorkRead(args:StorageOperations['importWorkRead']['args']){return this.work().importWorkRead(args);}
  importWorkGet(args:StorageOperations['importWorkGet']['args']){return this.work().importWorkGet(args);}
  importWorkCheckpoint(args:StorageOperations['importWorkCheckpoint']['args']){return this.work().importWorkCheckpoint(args);}
  importWorkResolve(args:StorageOperations['importWorkResolve']['args']){return this.work().importWorkResolve(args);}
  importGroupFinish(args:StorageOperations['importGroupFinish']['args']){return this.work().importGroupFinish(args);}
  importAllocateIds(args:StorageOperations['importAllocateIds']['args'],nextId:()=>string){return this.work().importAllocateIds(args,nextId);}
  committedImportOperation<K extends Exclude<keyof NormalizedImportOperations,'normalizedImportStatus'|'readStagedImportRecords'>>(operation:K,args:NormalizedImportOperations[K]['args']){return this.imports().committedImportOperation(operation,args);}
  importValidationRecords(args:{importId:string;maxRecords:number}){return this.imports().importValidationRecords(args);}
  recordImportBlobTransfers(importId:string,transferIds:readonly string[]){this.imports().recordImportBlobTransfers(importId,transferIds);}
  readImportBlobTransfers(importId:string,page:{after:string|null;maxItems:number}){return this.imports().readImportBlobTransfers(importId,page);}
  forgetImportBlobTransfer(importId:string,transferId:string){this.imports().forgetImportBlobTransfer(importId,transferId);}
  completeImportBlobPreparation(args:StorageOperations['prepareImportBlobs']['args']){return this.imports().completeImportBlobPreparation(args);}
  beginNormalizedImport(args:StorageOperations['beginNormalizedImport']['args']){return this.imports().beginNormalizedImport(args);}
  stageImportRecords(args:StorageOperations['stageImportRecords']['args']){return this.imports().stageImportRecords(args);}
  validateImportStep(args:StorageOperations['validateImportStep']['args']){return this.imports().validateImportStep(args);}
  finalizeNormalizedImport(args:StorageOperations['finalizeNormalizedImport']['args']){return this.imports().finalizeNormalizedImport(args);}
  cancelNormalizedImport(args:StorageOperations['cancelNormalizedImport']['args']){return this.imports().cancelNormalizedImport(args);}
  normalizedImportStatus(args:StorageOperations['normalizedImportStatus']['args']){return this.imports().normalizedImportStatus(args);}
  readStagedImportRecords(args:StorageOperations['readStagedImportRecords']['args']){return this.imports().readStagedImportRecords(args);}

  private rows(sql:string,bind:SqlValue[]=[]):Record<string,SqlValue>[] {return this.db.exec({sql,...(bind.length?{bind}:{}),rowMode:'object',returnValue:'resultRows'}) as Record<string,SqlValue>[];}
  private count(sql:string,bind:SqlValue[]=[]):number{return Number(bind.length?this.db.selectValue(sql,bind):this.db.selectValue(sql));}
  private transaction<T>(work:()=>T):T{
    this.db.exec('BEGIN IMMEDIATE');
    try{const result=work();this.db.exec('COMMIT');return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{/* SQLite may already have rolled back. */}
      if(error&&typeof error==='object'&&'resultCode'in error&&(Number(error.resultCode)&255)===19)throw new CanonicalStorageError('CONFLICT',`Canonical SQL constraint rejected the transaction: ${String(error)}`);
      throw error;}
  }
  migrate(targetVersion:number=CANONICAL_MIGRATIONS.length):number{
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE;');
    this.db.exec('CREATE TABLE IF NOT EXISTS quixi_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL) STRICT');
    const current=this.count('SELECT coalesce(max(version),0) FROM quixi_schema_migrations');
    if(current>targetVersion||targetVersion>CANONICAL_MIGRATIONS.length||!Number.isInteger(targetVersion)||targetVersion<0)fail('MIGRATION_FAILED','Unsupported canonical schema version; preserve database and use a compatible application/export path');
    for(const migration of CANONICAL_MIGRATIONS){
      const checksum=identity(migration.sql);
      if(migration.version<=current){
        const row=this.rows('SELECT name,checksum FROM quixi_schema_migrations WHERE version=?',[migration.version])[0];
        if(!row||row.name!==migration.name||row.checksum!==checksum)fail('MIGRATION_FAILED','Canonical migration history differs from this build; preserve existing database');
      }else if(migration.version<=targetVersion){
        try{this.transaction(()=>{
          this.db.exec(migration.sql);
          this.db.exec({sql:'INSERT INTO quixi_schema_migrations VALUES(?,?,?)',bind:[migration.version,migration.name,checksum]});
        });}catch(error){throw new CanonicalStorageError('MIGRATION_FAILED',`Canonical migration ${migration.version} rolled back; keep existing data for recovery: ${String(error)}`);}
      }
    }
    return targetVersion;
  }
  get<K extends Collection>(collection:K,id:string):RecordFor<K>|null{
    const row=this.rows('SELECT payload FROM quixi_records WHERE collection=? AND id=?',[collection,id])[0];
    return row?JSON.parse(String(row.payload)) as RecordFor<K>:null;
  }
  private require<K extends Collection>(collection:K,id:string):RecordFor<K>{return this.get(collection,id)??fail('NOT_FOUND',`Missing ${collection}/${id}`);}
  private write<K extends Collection>(collection:K,record:RecordFor<K>,mode:'insert'|'update'='insert'):void{
    jsonByteLength(record,CANONICAL_LIMITS.maxRecordBytes);
    const issues=validateEntityShape(collection,record);if(issues.length)throw new ModelValidationError(issues);
    const id='id' in record?record.id:record.threadId;
    if(mode==='update'&&!this.get(collection,id))fail('NOT_FOUND',`Missing update target ${collection}/${id}`);
    this.db.exec({sql:mode==='insert'?'INSERT INTO quixi_records(collection,id,payload) VALUES(?,?,?)':'UPDATE quixi_records SET payload=?3 WHERE collection=?1 AND id=?2',bind:[collection,id,json(record)]});
    if(collection==='messages'&&mode==='insert')this.insertedMessages.add(id);
    this.changes.set(`${collection}:${id}`,{kind:kinds[collection],id});
  }
  private state(threadId:string,patch:Partial<ThreadState>):void{
    const previous=this.require('threadStates',threadId);this.write('threadStates',{...previous,...patch,threadId,revision:previous.revision+1},'update');
  }
  private edge(owner:EntityReference,field:string,target:Collection,id:string|null,threadId?:string):void{
    if(id===null)return;
    const targetRecord=this.require(target,id);
    if(threadId!==undefined&&(!('threadId'in targetRecord)||targetRecord.threadId!==threadId))fail('INVALID_REQUEST',`Cross-thread ${field}`);
    this.db.exec({sql:'INSERT INTO quixi_edges VALUES(?,?,?,?,?)',bind:[collections[owner.kind],owner.id,field,target,id]});
  }
  private ancestor(ancestor:string,child:string):boolean{
    return this.count(`WITH RECURSIVE chain(id,parent_id) AS (
      SELECT id,parent_id FROM quixi_records WHERE collection='messages' AND id=?
      UNION ALL SELECT r.id,r.parent_id FROM quixi_records r JOIN chain c ON r.id=c.parent_id WHERE r.collection='messages'
    ) SELECT EXISTS(SELECT 1 FROM chain WHERE id=?)`,[child,ancestor])===1;
  }
  private hidden(threadId:string,messageId:string):boolean{
    if(!this.count("SELECT EXISTS(SELECT 1 FROM quixi_records WHERE collection='tombstones' AND thread_id=?)",[threadId]))return false;
    return this.count(`WITH RECURSIVE chain(id,parent_id) AS (
      SELECT id,parent_id FROM quixi_records WHERE collection='messages' AND id=?
      UNION ALL SELECT r.id,r.parent_id FROM quixi_records r JOIN chain c ON r.id=c.parent_id WHERE r.collection='messages'
    ) SELECT EXISTS(SELECT 1 FROM quixi_records t WHERE collection='tombstones' AND thread_id=? AND (json_extract(t.payload,'$.rootMessageId') IS NULL OR json_extract(t.payload,'$.rootMessageId') IN(SELECT id FROM chain)))`,[messageId,threadId])===1;
  }
  /** Recheck only touched, bounded records. Indexed probes and SQL traversal keep graph size out of JS memory. */
  private validate(reference:EntityReference):void{
    const collection=collections[reference.kind];const record=this.require(collection,reference.id);
    this.db.exec({sql:'DELETE FROM quixi_edges WHERE owner_collection=? AND owner_id=?',bind:[collection,reference.id]});
    const edge=(field:string,target:Collection,id:string|null,thread?:string)=>this.edge(reference,field,target,id,thread);
    switch(collection){
      case 'summaryProposals': {
        const r=record as RecordFor<'summaryProposals'>;
        edge('threadId','threads',r.threadId);edge('generationId','generations',r.generationId,r.threadId);
        for(const key of ['sourceContextSnapshotId','requestContextSnapshotId'] as const)edge(key,'contexts',r[key],r.threadId);
        for(const key of ['throughMessageId','sourceLeafMessageId'] as const)edge(key,'messages',r[key],r.threadId);
        edge('baseSummaryProposalId','summaryProposals',r.baseSummaryProposalId,r.threadId);edge('baseSummaryContextId','contexts',r.baseSummaryContextId,r.threadId);edge('inputRawObjectId','rawObjects',r.inputRawObjectId);
        assertSummaryCutoff(this.db,r.throughMessageId,r.sourceLeafMessageId);
        const generation=this.require('generations',r.generationId),source=this.require('contexts',r.sourceContextSnapshotId),request=this.require('contexts',r.requestContextSnapshotId),input=this.require('rawObjects',r.inputRawObjectId),base=contextSummary(source);
        if(generation.purpose!=='context_summary'||generation.parentMessageId!==r.throughMessageId||generation.contextSnapshotId!==r.requestContextSnapshotId||request.systemPrompt!==SUMMARY_INSTRUCTION||r.requestContextSnapshotId===r.sourceContextSnapshotId||input.availability!=='available'||input.sha256!==r.inputSha256||input.byteLength!==r.inputByteLength||input.mediaType!=='application/vnd.quixi.summary-input+json'||r.baseSummaryProposalId!==(base?.proposalId??null)||r.baseSummaryContextId!==(base?source.id:null))fail('INVALID_REQUEST','Summary proposal source, input or attempt provenance differs');
        break;
      }
      case 'threads':{
        const r=record as RecordFor<'threads'>;edge('state','threadStates',r.id);edge('importSourceId','importSources',r.importSourceId);
        const initial=this.rows("SELECT payload FROM quixi_records WHERE collection='contexts' AND thread_id=? AND json_extract(payload,'$.version')=1 LIMIT 2",[r.id]);
        const context=initial[0]?JSON.parse(String(initial[0].payload)) as RecordFor<'contexts'>:null;
        if(initial.length!==1||!context||context.systemPrompt!==r.systemPrompt||json(context.preferredRoute)!==json(r.preferredRoute))fail('INVALID_REQUEST','Thread initial context must match its retained prompt/route');break;
      }
      case 'threadStates':{
        const r=record as ThreadState;edge('threadId','threads',r.threadId);edge('contextSnapshotId','contexts',r.contextSnapshotId,r.threadId);edge('activeLeafMessageId','messages',r.activeLeafMessageId,r.threadId);
        if(new Set(r.tags).size!==r.tags.length)fail('INVALID_REQUEST','Thread tags must be unique');
        if(r.activeLeafMessageId){const selected=this.require('messages',r.activeLeafMessageId);if(selected.generationId&&this.require('generations',selected.generationId).purpose)fail('INVALID_REQUEST','Summary proposals cannot be selected as ordinary answers');}
        if(r.activeLeafMessageId&&this.hidden(r.threadId,r.activeLeafMessageId))fail('INVALID_REQUEST','Active selection is deleted');break;
      }
      case 'contexts':{
        const r=record as RecordFor<'contexts'>;edge('threadId','threads',r.threadId);edge('previousId','contexts',r.previousId,r.threadId);
        for (const [index, partId] of (r.compaction?.excludedPartIds ?? []).entries()) {
          const part = this.require('parts', partId);
          if (!['Image','File','Audio'].includes(part.kind) || this.require('messages', part.messageId).threadId !== r.threadId)
            fail('INVALID_REQUEST', 'Context exclusions must reference attachment parts in the same thread');
          edge(`compaction.excludedPartIds[${index}]`, 'parts', partId);
        }
        const summary=contextSummary(r);
        if(summary){edge('compaction.summary.proposalId','summaryProposals',summary.proposalId,r.threadId);edge('compaction.summary.throughMessageId','messages',summary.throughMessageId,r.threadId);const proposal=this.require('summaryProposals',summary.proposalId),generation=this.require('generations',proposal.generationId);
          if(proposal.throughMessageId!==summary.throughMessageId||generation.status!=='complete'||!this.require('messages',generation.outputMessageId).sealed||summaryTextDigest(summary.reviewedText)!==summary.reviewedTextSha256)fail('INVALID_REQUEST','A reviewed summary requires complete output, its exact boundary and text digest');
          readSummaryOutputText(this.db,generation,this.require('messages',generation.outputMessageId));
        }
        if(r.previousId===null?r.version!==1:this.require('contexts',r.previousId).version!==r.version-1)fail('INVALID_REQUEST','Context versions must advance from an existing immutable predecessor');
        if(r.version===1&&this.count("SELECT count(*) FROM quixi_records WHERE collection='contexts' AND thread_id=? AND json_extract(payload,'$.version')=1",[r.threadId])!==1)fail('CONFLICT','Duplicate initial context');break;
      }
      case 'messages':{
        const r=record as Message;edge('threadId','threads',r.threadId);edge('parentId','messages',r.parentId,r.threadId);edge('editedFromMessageId','messages',r.editedFromMessageId,r.threadId);edge('generationId','generations',r.generationId,r.threadId);
        if(r.parentId){const parent=this.require('messages',r.parentId);if(parent.generationId&&this.require('generations',parent.generationId).purpose)fail('INVALID_REQUEST','Summary outputs cannot be continued as chat');}
        if(r.parentId===r.id||r.editedFromMessageId===r.id)fail('INVALID_REQUEST','Message cannot refer to itself');
        if(r.editedFromMessageId){const previous=this.require('messages',r.editedFromMessageId);if(!previous.sealed||previous.parentId!==r.parentId||previous.role!==r.role||r.generationId!==null)fail('INVALID_REQUEST','Edit must be a same-role sibling of immutable history');}
        if(r.generationId){const g=this.require('generations',r.generationId);if(g.outputMessageId!==r.id||g.parentMessageId!==r.parentId||r.role!=='assistant'||r.sealed!==(g.status!=='streaming'))fail('INVALID_REQUEST','Generation output backlink/sealing mismatch');}
        else if(!r.sealed)fail('INVALID_REQUEST','Only streaming generation outputs may be unsealed');
        if(this.insertedMessages.has(r.id)){const summary=this.rows("SELECT count(*) AS count,coalesce(min(json_extract(payload,'$.order')),0) AS first,coalesce(max(json_extract(payload,'$.order')),-1) AS last FROM quixi_records WHERE collection='parts' AND message_id=?",[r.id])[0]!;
        if(Number(summary.count)!==r.partCount||(r.partCount>0&&(Number(summary.first)!==0||Number(summary.last)!==r.partCount-1)))fail('INVALID_REQUEST','Message part count/consecutive ordering mismatch');}break;
      }
      case 'generations':{
        const r=record as Generation;edge('threadId','threads',r.threadId);edge('parentMessageId','messages',r.parentMessageId,r.threadId);edge('outputMessageId','messages',r.outputMessageId,r.threadId);edge('contextSnapshotId','contexts',r.contextSnapshotId,r.threadId);edge('rawResponseId','rawObjects',r.rawResponseId);
        const parent=this.require('messages',r.parentMessageId),output=this.require('messages',r.outputMessageId);
        if(!parent.sealed||output.generationId!==r.id||output.parentId!==r.parentMessageId||output.role!=='assistant'||output.sealed!==(r.status!=='streaming'))fail('INVALID_REQUEST','Invalid generation parent/output lifecycle');
        if((r.status==='streaming'&&r.completedAt!==null)||(r.createdAt!==null&&r.completedAt!==null&&r.completedAt<r.createdAt))fail('INVALID_REQUEST','Invalid generation completion time');break;
      }
      case 'parts':{
        const r=record as ContentPart;edge('messageId','messages',r.messageId);const message=this.require('messages',r.messageId);
        if(r.order>=message.partCount)fail('INVALID_REQUEST','Part is not projected by owning message');
        if(r.kind==='File'||r.kind==='Image'||r.kind==='Audio')edge('attachmentId','attachments',r.data.attachmentId);
        if((r.kind==='Text'||r.kind==='Note')&&r.data.textBlob)this.options.assertBlobAvailable(r.data.textBlob.sha256,r.data.textBlob.byteLength,this.stages,"utf-8");
        if(r.kind==='ProviderArtifact')edge('rawObjectId','rawObjects',r.data.rawObjectId);
        if(r.kind==='Citation')edge('sourcePartId','parts',r.data.sourcePartId);
        if(r.kind==='ToolResult'){
          if((r.data.callPartId===null)===(r.data.unresolvedProviderCallId===null))fail('INVALID_REQUEST','Tool result needs exactly one resolved/unresolved call reference');
          if(r.data.callPartId){edge('callPartId','parts',r.data.callPartId);const call=this.require('parts',r.data.callPartId);
            if(call.kind!=='ToolCall'||(call.messageId===r.messageId?call.order>=r.order:!this.ancestor(call.messageId,message.parentId??'')))fail('INVALID_REQUEST','Tool result call must precede it on the same path');
          }
        }break;
      }
      case 'events':{
        const r=record as RecordFor<'events'>;edge('threadId','threads',r.threadId);edge('messageId','messages',r.messageId,r.threadId);edge('generationId','generations',r.generationId,r.threadId);break;
      }
      case 'attachments':{
        const r=record as RecordFor<'attachments'>;edge('rawObjectId','rawObjects',r.rawObjectId);
        if(r.availability==='available'){if(r.blobSha256===null||r.sizeBytes===null)fail('INVALID_REQUEST','Available attachment requires verified bytes');this.options.assertBlobAvailable(r.blobSha256,r.sizeBytes,this.stages);}
        else if(r.blobSha256!==null)fail('INVALID_REQUEST','Missing attachment cannot claim verified bytes');break;
      }
      case 'documents':{
        const r=record as RecordFor<'documents'>;edge('attachmentId','attachments',r.attachmentId);edge('importSourceId','importSources',r.importSourceId);break;
      }
      case 'rawObjects':{
        const r=record as RecordFor<'rawObjects'>;
        if(r.availability==='available'){if(r.sha256===null||r.byteLength===null||r.storageRef===null)fail('INVALID_REQUEST','Available raw source requires verified bytes');this.options.assertBlobAvailable(r.sha256,r.byteLength,this.stages);}
        else if(r.sha256!==null||r.storageRef!==null)fail('INVALID_REQUEST','Missing raw source cannot claim verified bytes');break;
      }
      case 'sourceIdentities':{const r=record as SourceIdentity;edge('quixiId',collections[r.entityKind],r.quixiId);break;}
      case 'provenance':{
        const r=record as RecordFor<'provenance'>;edge('entityId',collections[r.entityKind],r.entityId);edge('importSourceId','importSources',r.importSourceId);edge('rawObjectId','rawObjects',r.rawObjectId);
        if(r.locator!==null&&r.rawObjectId===null)fail('INVALID_REQUEST','Raw locator requires a raw object');break;
      }
      case 'tombstones':{
        const r=record as Tombstone;edge('threadId','threads',r.threadId);edge('rootMessageId','messages',r.rootMessageId,r.threadId);
        break;
      }
      case 'importSources':break;
    }
  }
  private insertMessage(message:Message,parts:ContentPart[]):void{
    // New parent/edit targets must already exist, making cycles impossible without a reparent mutation.
    if(this.hidden(message.threadId,message.parentId??message.id))fail('CONFLICT','Cannot add history to a deleted thread/subtree');
    if(message.parentId)this.require('messages',message.parentId);
    if(message.editedFromMessageId)this.require('messages',message.editedFromMessageId);
    this.write('messages',message);for(const part of parts)this.write('parts',part);
  }
  private append(generationId:string,sequence:number,newParts:ContentPart[],textAppend:{partId:string;text:string}|null):void{
    const generation=this.require('generations',generationId);const output=this.require('messages',generation.outputMessageId);
    if(generation.status!=='streaming'||output.sealed||this.hidden(output.threadId,output.id))fail('CONFLICT','Generation output is sealed');
    if(sequence!==generation.lastSequence+1)fail('CONFLICT','Generation checkpoint sequence must advance exactly once');
    if(textAppend){
      const part=this.require('parts',textAppend.partId);
      if(part.messageId!==output.id||part.kind!=='Text'||typeof part.data.text!=='string'||this.db.selectValue(`SELECT EXISTS(SELECT 1 FROM quixi_records
        WHERE collection='parts' AND message_id=? AND json_extract(payload,'$.order')>?
        AND NOT coalesce(json_extract(payload,'$.kind')='ProviderArtifact' AND json_extract(payload,'$.data.providerKind') IN('quixi.provider.raw-stream-chunk','quixi.provider.response-manifest'),0))`,[output.id,part.order]))fail('INVALID_REQUEST','Only the last unfinished semantic part can be appended');
      this.write('parts',{...part,data:{text:part.data.text+textAppend.text}},'update');
    }
    for(const [index,part]of newParts.entries()){
      if(part.messageId!==output.id||part.order!==output.partCount+index)fail('INVALID_REQUEST','Appended part owner/order mismatch');
      this.write('parts',part);
    }
    this.write('messages',{...output,partCount:output.partCount+newParts.length},'update');
    this.write('generations',{...generation,lastSequence:sequence},'update');
  }
  private apply(mutation:CanonicalMutation):void{
    switch(mutation.kind){
      case 'CreateThread':this.write('threads',mutation.payload.thread);this.write('contexts',mutation.payload.context);this.write('threadStates',mutation.payload.state);break;
      case 'CreateMessage':{
        const {message,parts}=mutation.payload;
        if(message.editedFromMessageId!==null||message.generationId!==null)fail('INVALID_REQUEST','Use linked edit/generation command');
        this.insertMessage(message,parts);break;
      }
      case 'EditMessage':{
        const {previousId,message,parts}=mutation.payload;const previous=this.require('messages',previousId);
        if(this.hidden(previous.threadId,previous.id))fail('CONFLICT','Cannot edit deleted history');
        const expected={...previous,id:message.id,createdAt:mutation.recordedAt,recordedAt:mutation.recordedAt,generationId:null,editedFromMessageId:previousId,partCount:parts.length,sealed:true};
        if(!previous.sealed||json(expected)!==json(message))fail('INVALID_REQUEST','Edit must retain previous parent/role and create new immutable history');
        this.insertMessage(message,parts);break;
      }
      case 'RegisterSummaryProposal': {
        const {proposal}=mutation.payload,state=this.require('threadStates',proposal.threadId);
        if(state.revision!==proposal.sourceThreadRevision||state.contextSnapshotId!==proposal.sourceContextSnapshotId||state.activeLeafMessageId!==proposal.sourceLeafMessageId)fail('CONFLICT','The summary source selection changed before generation');
        assertSummaryCutoff(this.db,proposal.throughMessageId,proposal.sourceLeafMessageId);
        const info=summarySourceInfo(this.db,proposal.sourceContextSnapshotId,proposal.throughMessageId);
        if(info.sourceFingerprint!==proposal.sourceFingerprint||info.sourceMessageCount!==proposal.sourceMessageCount||info.sourcePartCount!==proposal.sourcePartCount)fail('CONFLICT','The summary source changed before generation');
        this.write('summaryProposals',proposal);break;
      }
      case 'CreateGeneration':{
        const {generation,output,parts}=mutation.payload;
        this.require('messages',generation.parentMessageId);
        this.write('generations',generation);this.insertMessage(output,parts);break;
      }
      case 'AppendGenerationOutput':this.append(mutation.payload.generationId,mutation.payload.sequence,mutation.payload.newParts,mutation.payload.textAppend);break;
      case 'AttachContent':{
        const {messageId,sequence,parts}=mutation.payload;const message=this.require('messages',messageId);
        if(message.sealed||message.generationId===null)fail('CONFLICT','Adding content to sealed history requires an edit');
        this.append(message.generationId,sequence,parts,null);break;
      }
      case 'CompleteGeneration':{
        const {generationId,status,completedAt,tokensIn,tokensOut,cachedTokens,estimatedCost,reportedCost,rawResponseId}=mutation.payload;
        const previous=this.require('generations',generationId);assertGenerationTransition(previous.status,status);
        this.write('generations',{...previous,status,completedAt,tokensIn,tokensOut,cachedTokens,estimatedCost,reportedCost,rawResponseId},'update');
        this.write('messages',{...this.require('messages',previous.outputMessageId),sealed:true},'update');break;
      }
      case 'CreateThreadEvent':this.write('events',mutation.payload.event);break;
      case 'SetTitle':this.state(mutation.payload.threadId,{title:mutation.payload.value});break;
      case 'SetTags':this.state(mutation.payload.threadId,{tags:mutation.payload.value});break;
      case 'SetPinned':this.state(mutation.payload.threadId,{pinned:mutation.payload.value});break;
      case 'SetArchived':this.state(mutation.payload.threadId,{archived:mutation.payload.value});break;
      case 'SetActiveBranch':this.state(mutation.payload.threadId,{activeLeafMessageId:mutation.payload.value});break;
      case 'SetRoutingProfile':this.state(mutation.payload.threadId,{routingProfile:mutation.payload.value});break;
      case 'CreateContextSnapshot': {
        const {context,select}=mutation.payload,summary=contextSummary(context),previous=context.previousId?this.require('contexts',context.previousId):null;
        if(summary&&json(summary)!==json(contextSummary(previous??{}))){const proposal=this.require('summaryProposals',summary.proposalId),state=this.require('threadStates',context.threadId);
          if(!select||state.revision!==proposal.sourceThreadRevision||context.previousId!==state.contextSnapshotId||context.previousId!==proposal.sourceContextSnapshotId||state.activeLeafMessageId!==proposal.sourceLeafMessageId||summarySourceInfo(this.db,proposal.sourceContextSnapshotId,proposal.throughMessageId).sourceFingerprint!==proposal.sourceFingerprint)fail('CONFLICT','The summary source changed; generate and review a fresh proposal');
        }
        this.write('contexts',context);if(select)this.state(context.threadId,{contextSnapshotId:context.id});break;
      }
      case 'RegisterRawObject':this.write('rawObjects',mutation.payload.rawObject);break;
      case 'RegisterImportSource':this.write('importSources',mutation.payload.source);for(const raw of mutation.payload.rawObjects)this.write('rawObjects',raw);break;
      case 'AttachProvenance':for(const item of mutation.payload.provenance)this.write('provenance',item);for(const item of mutation.payload.identities)this.write('sourceIdentities',item);break;
      case 'RegisterAttachment':this.write('attachments',mutation.payload.attachment);break;
      case 'RegisterDocument':this.write('documents',mutation.payload.document);break;
      case 'SetDocumentTitle':this.write('documents',{...this.require('documents',mutation.payload.documentId),title:mutation.payload.value},'update');break;
      case 'ResolveAttachment':{
        const {attachmentId,blobSha256,sizeBytes,provenance}=mutation.payload;const previous=this.require('attachments',attachmentId);
        if(previous.availability==='available'&&(previous.blobSha256!==blobSha256||previous.sizeBytes!==sizeBytes))fail('CONFLICT','Published attachment bytes cannot be replaced');
        this.write('attachments',{...previous,availability:'available',blobSha256,sizeBytes},'update');for(const item of provenance)this.write('provenance',item);break;
      }
      case 'TombstoneThread':case 'TombstoneBranch':{
        const {tombstone,state}=mutation.payload;
        if((mutation.kind==='TombstoneThread')!==(tombstone.rootMessageId===null))fail('INVALID_REQUEST','Tombstone scope mismatch');
        const previous=this.require('threadStates',tombstone.threadId);let active=previous.activeLeafMessageId;
        if(tombstone.rootMessageId===null)active=null;
        else if(active&&this.ancestor(tombstone.rootMessageId,active))active=this.require('messages',tombstone.rootMessageId).parentId;
        const expected={...previous,activeLeafMessageId:active,revision:previous.revision+1};
        if(json(state)!==json(expected))fail('INVALID_REQUEST','Tombstone must retain state and select closest visible ancestor');
        this.write('tombstones',tombstone);this.write('threadStates',state,'update');break;
      }
      default:fail('INVALID_REQUEST','Unknown canonical mutation');
    }
  }
  /** Check before expensive external prepublication; commit repeats this check under its SQL transaction. */
  committedTransaction(batch:MutationBatch):CommitResult|null{
    assertStorageRequest({version:1,requestId:batch.transactionId,operation:'commit',args:batch});
    const row=this.rows('SELECT identity,result FROM quixi_transactions WHERE transaction_id=?',[batch.transactionId])[0];
    if(!row)return null;
    if(row.identity!==identity(batch))fail('CONFLICT','Transaction ID was already used with different payload');
    return JSON.parse(String(row.result)) as CommitResult;
  }
  /** A branch review describes the pre-transaction selection, never an intermediate mutation result. */
  private validateFreshBranch(batch:MutationBatch,existing:Map<string,Record<string,SqlValue>>):void{
    const branches=batch.mutations.filter(mutation=>mutation.kind==='CreateThreadEvent'&&mutation.payload.event.type==='ContextCompaction'&&mutation.payload.event.details.action==='start_branch');
    if(!branches.length||existing.size===batch.mutations.length)return;
    if(branches.length!==1||existing.size)fail('INVALID_REQUEST','Fresh branch must be one new atomic batch');
    const branch=branches[0]!;
    if(branch.kind!=='CreateThreadEvent')return;
    const event=branch.payload.event,state=this.require('threadStates',event.threadId),source=this.require('contexts',state.contextSnapshotId);
    if(state.activeLeafMessageId===null)fail('CONFLICT','Fresh branch requires a nonempty selected source');
    const leaf=this.require('messages',state.activeLeafMessageId);
    if(!leaf.sealed||leaf.generationId&&this.require('generations',leaf.generationId).purpose==='context_summary'||this.hidden(event.threadId,leaf.id))fail('CONFLICT','Fresh branch requires a visible sealed conversation source');
    if(this.count("SELECT count(*) FROM quixi_records WHERE collection='generations' AND thread_id=? AND json_extract(payload,'$.status')='streaming'",[event.threadId]))fail('CONFLICT','Fresh branch cannot interrupt a live generation in this thread');
    if(batch.expectedThreadRevisions.length!==1||batch.expectedThreadRevisions[0]!.threadId!==event.threadId||batch.expectedThreadRevisions[0]!.revision!==state.revision)fail('INVALID_REQUEST','Fresh branch requires the selected thread revision');
    const contexts=batch.mutations.filter(mutation=>mutation.kind==='CreateContextSnapshot'),selections=batch.mutations.filter(mutation=>mutation.kind==='SetActiveBranch');
    if(contexts.length!==1||selections.length!==1)fail('INVALID_REQUEST','Fresh branch requires one context and one empty selection');
    const creation=contexts[0]!,selection=selections[0]!;
    if(creation.kind!=='CreateContextSnapshot'||selection.kind!=='SetActiveBranch')return;
    const context=creation.payload.context;
    const expectedContext={...source,id:context.id,previousId:source.id,version:source.version+1,recordedAt:context.recordedAt,...(source.compaction?.version===2?{compaction:{...source.compaction,summary:null}}:{})};
    if(!creation.payload.select||context.id===source.id||json(context)!==json(expectedContext)||selection.payload.threadId!==event.threadId||selection.payload.value!==null)fail('INVALID_REQUEST','Fresh branch must preserve its source settings and select an empty path');
    const details={version:1,action:'start_branch',retainedContext:'system_prompt_only',sourceThreadRevision:state.revision,sourceLeafMessageId:leaf.id,previousContextSnapshotId:source.id,contextSnapshotId:context.id};
    if(event.messageId!==leaf.id||event.generationId!==null||json(event.details)!==json(details))fail('INVALID_REQUEST','Fresh branch audit does not match the selected source');
    const clear=batch.mutations.filter(mutation=>mutation.kind==='CreateThreadEvent'&&mutation!==branch);
    const hasSummary=contextSummary(source)!==null;
    if(batch.stagedBlobIds.length||batch.mutations.length!==(hasSummary?4:3)||clear.length!==(hasSummary?1:0))fail('INVALID_REQUEST','Fresh branch cannot include unrelated mutations');
    if(hasSummary){
      const command=clear[0]!;
      if(command.kind!=='CreateThreadEvent')return;
      const audit=command.payload.event;
      if(audit.threadId!==event.threadId||audit.type!=='ContextCompaction'||audit.messageId!==leaf.id||audit.generationId!==null||json(audit.details)!==json({action:'clear_summary',contextSnapshotId:context.id,previousContextSnapshotId:source.id,reason:'start_branch'}))fail('INVALID_REQUEST','Fresh branch must record its matching summary clear');
    }
  }
  commit(batch:MutationBatch):CommitResult{
    // Envelope preflight happens before hashing/serialization or any SQL mutation.
    assertStorageRequest({version:1,requestId:batch.transactionId,operation:'commit',args:batch});
    const batchIdentity=identity(batch);
    return this.transaction(()=>{
      const previous=this.rows('SELECT identity,result FROM quixi_transactions WHERE transaction_id=?',[batch.transactionId])[0];
      if(previous){if(previous.identity!==batchIdentity)fail('CONFLICT','Transaction ID was already used with different payload');return JSON.parse(String(previous.result)) as CommitResult;}
      const existing=new Map<string,Record<string,SqlValue>>();
      for(const mutation of batch.mutations){
        const row=this.rows('SELECT identity,result FROM quixi_sync_ops WHERE operation_id=?',[mutation.operationId])[0];
        if(row){if(row.identity!==identity(mutation))fail('CONFLICT','Operation ID was already used with different payload');existing.set(mutation.operationId,row);}
      }
      // Full replay succeeds after revisions have advanced. Mixed new work still checks the requested base state.
      if(existing.size!==batch.mutations.length)for(const expected of batch.expectedThreadRevisions)if(this.require('threadStates',expected.threadId).revision!==expected.revision)fail('CONFLICT','Thread revision changed before commit');
      this.validateFreshBranch(batch,existing);
      const result:CommitResult={transactionId:batch.transactionId,operations:[]};this.stages=batch.stagedBlobIds;
      const summaryTransitions:Array<{context:ContextSnapshot;summary:ReviewedSummary|null;revision:number}>=[];
      for(const mutation of batch.mutations){
        const replay=existing.get(mutation.operationId);
        if(replay){result.operations.push({operationId:mutation.operationId,outcome:'already_committed',result:JSON.parse(String(replay.result)) as JsonValue});continue;}
        if(mutation.kind==='CreateContextSnapshot'&&mutation.payload.select){
          const context=mutation.payload.context,state=this.require('threadStates',context.threadId),before=contextSummary(this.require('contexts',state.contextSnapshotId)),summary=contextSummary(context);
          if(json(before)!==json(summary)){
            if(context.previousId!==state.contextSnapshotId)fail('CONFLICT','Summary context changes must extend the current selected context');
            summaryTransitions.push({context,summary,revision:state.revision});
          }
        }
        this.changes=new Map();this.insertedMessages=new Set();this.apply(mutation);
        for(const change of this.changes.values())this.validate(change);
        const effects=[...this.changes.values()];
        jsonByteLength({version:1,operationId:mutation.operationId,kind:mutation.kind,recordedAt:mutation.recordedAt,payload:mutation.payload,affects:effects},CANONICAL_LIMITS.maxPageBytes-1024);
        const operationResult:JsonValue={affected:effects as unknown as JsonValue};
        this.db.exec({sql:'INSERT INTO quixi_sync_ops(operation_id,kind,recorded_at,identity,payload,affects,result) VALUES(?,?,?,?,?,?,?)',bind:[mutation.operationId,mutation.kind,mutation.recordedAt,identity(mutation),json(mutation.payload),json(effects),json(operationResult)]});
        result.operations.push({operationId:mutation.operationId,outcome:'committed',result:operationResult});
      }
      for(const mutation of batch.mutations)if(mutation.kind==='CreateGeneration'&&mutation.payload.generation.purpose==='context_summary'&&this.count("SELECT count(*) FROM quixi_records WHERE collection='summaryProposals' AND generation_id=?",[mutation.payload.generation.id])!==1)fail('INVALID_REQUEST','Summary attempt and proposal must be committed together');
      for(const {context,summary,revision} of summaryTransitions){
        if(!batch.expectedThreadRevisions.some(expected=>expected.threadId===context.threadId&&expected.revision===revision))fail('INVALID_REQUEST','Summary apply and clear require the selected thread revision');
        const action=summary?'apply_summary':'clear_summary';
        const paired=batch.mutations.some(mutation=>{
          if(mutation.kind!=='CreateThreadEvent')return false;
          const event=mutation.payload.event;
          return event.threadId===context.threadId&&event.type==='ContextCompaction'&&event.details.action===action&&event.details.contextSnapshotId===context.id&&(!summary||event.details.proposalId===summary.proposalId&&event.generationId===this.require('summaryProposals',summary.proposalId).generationId);
        });
        if(!paired)fail('INVALID_REQUEST','Summary apply and clear must commit their matching audit event in the same batch');
      }
      jsonByteLength(result,STORAGE_BOUNDARIES.maxResponseBytes-1024);
      this.db.exec({sql:'INSERT INTO quixi_transactions VALUES(?,?,?)',bind:[batch.transactionId,batchIdentity,json(result)]});
      this.options.beforeCommit?.();this.stages=[];return result;
    });
  }
  operationStatus(operationId:string):StorageOperations['operationStatus']['result']{
    if(!isQuixiId(operationId))fail('INVALID_REQUEST','Invalid operation ID');
    const row=this.rows('SELECT result FROM quixi_sync_ops WHERE operation_id=? UNION ALL SELECT result FROM quixi_import_operations WHERE operation_id=? UNION ALL SELECT result FROM quixi_blob_operations WHERE operation_id=? UNION ALL SELECT result FROM quixi_import_work_operations WHERE operation_id=? LIMIT 1',[operationId,operationId,operationId,operationId])[0];
    return row?{status:'committed',result:JSON.parse(String(row.result)) as JsonValue}:{status:'not_found',result:null};
  }
  /** Resolve scoped provider IDs before import construction; unique SQL index also fences overlap/races. */
  resolveSourceIdentity(scope:Pick<SourceIdentity,'provider'|'accountScope'|'sourceThreadId'|'sourceContainerKey'|'entityKind'|'nativeId'>):string|null{
    jsonByteLength(scope,16384);
    const row=this.rows(`SELECT json_extract(payload,'$.quixiId') AS id FROM quixi_records WHERE collection='sourceIdentities' AND json_extract(payload,'$.provider')=? AND json_extract(payload,'$.accountScope')=? AND coalesce(json_extract(payload,'$.sourceThreadId'),'')=? AND json_extract(payload,'$.sourceContainerKey')=? AND json_extract(payload,'$.entityKind')=? AND json_extract(payload,'$.nativeId')=?`,[scope.provider,scope.accountScope,scope.sourceThreadId??'',scope.sourceContainerKey,scope.entityKind,scope.nativeId])[0];
    return row?String(row.id):null;
  }
  readEntities(args:StorageOperations['readEntities']['args']):EntityPage{
    // Local fixed UUID only for envelope validation; it is not a canonical operation identity.
    assertStorageRequest({version:1,requestId:'00000000-0000-4000-8000-000000000000',operation:'readEntities',args});
    const {collection,threadId,page}=args;const maxBytes=Math.min(page.maxBytes,CANONICAL_LIMITS.maxPageBytes);
    let after='';
    if(page.cursor!==null){
      let parsed:unknown;try{parsed=JSON.parse(page.cursor);}catch{fail('INVALID_REQUEST','Invalid page cursor');}
      const cursor=parsed as {version?:number;collection?:string;threadId?:string|null;after?:string};
      if(!cursor||cursor.version!==1||cursor.collection!==collection||cursor.threadId!==threadId||!isQuixiId(cursor.after))fail('INVALID_REQUEST','Cursor belongs to another query');after=cursor.after;
    }
    const direct=['summaryProposals','threads','threadStates','contexts','messages','generations','events','tombstones'];
    if(threadId!==null&&!direct.includes(collection)&&collection!=='parts')fail('INVALID_REQUEST','Use global pagination for shared attachment/document/provenance collections; thread owner filters apply to thread records and parts');
    const filter=threadId===null?'':collection==='parts'?" AND message_id IN(SELECT id FROM quixi_records WHERE collection='messages' AND thread_id=?)":' AND thread_id=?';
    const items:JsonValue[]=[];let bytes=2;let last=after;let more=false;
    // One bounded row at a time; LIMIT maxItems would materialize maxItems*maxRecordBytes in OO resultRows.
    for(let index=0;index<=page.maxItems;index++){
      const row=this.rows(`SELECT id,payload,length(CAST(payload AS BLOB)) AS bytes FROM quixi_records WHERE collection=? AND id>?${filter} ORDER BY id LIMIT 1`,threadId===null?[collection,last]:[collection,last,threadId])[0];
      if(!row)break;
      const additional=Number(row.bytes)+(items.length?1:0);
      if(index===page.maxItems||bytes+additional>maxBytes){more=true;if(!items.length)fail('INVALID_REQUEST','Page byte budget is too small for the next record; raise maxBytes');break;}
      items.push(JSON.parse(String(row.payload)) as JsonValue);bytes+=additional;last=String(row.id);
    }
    return {items,nextCursor:more?JSON.stringify({version:1,collection,threadId,after:last}):null,bytes};
  }
  readSyncOperations(args:StorageOperations['readSyncOperations']['args']):StorageOperations['readSyncOperations']['result']{
    assertStorageRequest({version:1,requestId:'00000000-0000-4000-8000-000000000000',operation:'readSyncOperations',args});
    let after=args.afterSequence;let through=this.count('SELECT coalesce(max(sequence),0) FROM quixi_sync_ops');
    if(args.page.cursor!==null){let cursor:{after?:number;through?:number;start?:number};try{cursor=JSON.parse(args.page.cursor) as typeof cursor;}catch{fail('INVALID_REQUEST','Invalid sync cursor');}
      if(!cursor||cursor.start!==args.afterSequence||!Number.isSafeInteger(cursor.after)||!Number.isSafeInteger(cursor.through)||cursor.after!<args.afterSequence||cursor.through!<cursor.after!||cursor.through!>through)fail('INVALID_REQUEST','Invalid sync cursor sequence/scope');after=cursor.after!;through=cursor.through!;}
    const items:StorageOperations['readSyncOperations']['result']['items']=[];let bytes=2,more=false,last=after;
    for(let index=0;index<=args.page.maxItems;index++){
      const row=this.rows('SELECT sequence,operation_id,kind,recorded_at,payload,affects FROM quixi_sync_ops WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT 1',[last,through])[0];if(!row)break;
      const item={sequence:Number(row.sequence),version:1 as const,operationId:String(row.operation_id),kind:String(row.kind) as StorageOperations['readSyncOperations']['result']['items'][number]['kind'],recordedAt:Number(row.recorded_at),payload:JSON.parse(String(row.payload)) as JsonValue,affects:JSON.parse(String(row.affects)) as EntityReference[]};
      const additional=jsonByteLength(item)+(items.length?1:0);
      if(index===args.page.maxItems||bytes+additional>Math.min(args.page.maxBytes,CANONICAL_LIMITS.maxPageBytes)){more=true;if(!items.length)fail('INVALID_REQUEST','Sync page is too small for next operation');break;}
      items.push(item);bytes+=additional;last=item.sequence;
    }
    return {items,bytes,lastSequence:last,highWaterSequence:through,nextCursor:more?JSON.stringify({start:args.afterSequence,after:last,through}):null};
  }
  readMessageParts(args:StorageOperations['readMessageParts']['args']):EntityPage{
    assertStorageRequest({version:1,requestId:'00000000-0000-4000-8000-000000000000',operation:'readMessageParts',args});
    this.require('messages',args.messageId);let after=-1;
    if(args.page.cursor!==null){let cursor:{messageId?:string;after?:number};try{cursor=JSON.parse(args.page.cursor) as typeof cursor;}catch{fail('INVALID_REQUEST','Invalid part cursor');}
      if(!cursor||cursor.messageId!==args.messageId||!Number.isSafeInteger(cursor.after)||cursor.after!<0)fail('INVALID_REQUEST','Part cursor belongs to a different query');after=cursor.after!;}
    const items:JsonValue[]=[];let bytes=2,more=false,last=after;
    for(let index=0;index<=args.page.maxItems;index++){
      const row=this.rows("SELECT payload,json_extract(payload,'$.order') AS ordinal,length(CAST(payload AS BLOB)) AS bytes FROM quixi_records WHERE collection='parts' AND message_id=? AND json_extract(payload,'$.order')>? ORDER BY json_extract(payload,'$.order') LIMIT 1",[args.messageId,last])[0];if(!row)break;
      const additional=Number(row.bytes)+(items.length?1:0);
      if(index===args.page.maxItems||bytes+additional>Math.min(args.page.maxBytes,CANONICAL_LIMITS.maxPageBytes)){more=true;if(!items.length)fail('INVALID_REQUEST','Page is too small for next part');break;}
      items.push(JSON.parse(String(row.payload)) as JsonValue);bytes+=additional;last=Number(row.ordinal);
    }
    return {items,bytes,nextCursor:more?JSON.stringify({messageId:args.messageId,after:last}):null};
  }
  /** Coordinator supplies only confirmed lost producer IDs. Ordinary owner handoff is not evidence of interruption. */
  recoverInterrupted(options:{generationIds:readonly string[];nextId:()=>string;now:()=>number}):{recovered:number}{
    if(options.generationIds.length>CANONICAL_LIMITS.maxRecoveryBatch||new Set(options.generationIds).size!==options.generationIds.length||!options.generationIds.every(isQuixiId))fail('INVALID_REQUEST','Invalid bounded confirmed interruption list');
    let recovered=0;
    for(const generationId of options.generationIds){
      const generation=this.require('generations',generationId);if(generation.status!=='streaming')continue;const time=options.now();
      this.commit({transactionId:options.nextId(),expectedThreadRevisions:[],stagedBlobIds:[],mutations:[
        {version:1,operationId:options.nextId(),kind:'CompleteGeneration',recordedAt:time,payload:{generationId:generation.id,status:'partial',completedAt:Math.max(time,generation.createdAt??0),tokensIn:generation.tokensIn,tokensOut:generation.tokensOut,cachedTokens:generation.cachedTokens,estimatedCost:generation.estimatedCost,reportedCost:generation.reportedCost,rawResponseId:generation.rawResponseId}},
        {version:1,operationId:options.nextId(),kind:'CreateThreadEvent',recordedAt:time,payload:{event:{id:options.nextId(),threadId:generation.threadId,type:'Migration',createdAt:time,recordedAt:time,messageId:generation.outputMessageId,generationId:generation.id,details:{reason:'producer_interrupted_generation',retainedStatus:'partial'}}}},
      ]});recovered++;
    }
    return {recovered};
  }
}
