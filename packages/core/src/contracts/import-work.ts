import type { JsonObject, JsonValue, QuixiId, SourceIdentity, CanonicalHistory } from '../model/types.ts';
import { isJsonValue, isQuixiId } from '../model/validation.ts';
import { jsonByteLength } from './serialization.ts';
import type { EntityPage, PageBudget } from './storage.ts';

export interface ImportRun {
  runId:QuixiId; provider:string; accountScope:string; workspaceId:QuixiId;
  importerName:string; importerVersion:string; formatProfile:string; recordedAt:number;
  state:'running'|'paused'|'complete'|'cancelled'; summary:JsonObject;
}
export interface ImportWorkRecord {
  key:string; parentKey:string|null; byteStart:number; byteEnd:number; payload:JsonObject;
}
export interface ImportWorkResult { canonicalId:QuixiId|null; data:JsonObject }
export interface ImportWorkItem extends ImportWorkRecord {
  ordinal:number; checkpoint:JsonObject;checkpointRevision:number;state:'pending'|'resolved'; result:ImportWorkResult|null; parentResult:ImportWorkResult|null;
}
export interface ImportWorkGroup {
  runId:QuixiId; groupKey:string; state:'staging'|'sealed'|'published'|'skipped'|'failed'|'complete';
  recordCount:number; resolvedCount:number; metadata:JsonObject; report:JsonObject;
  normalizedImportId:QuixiId|null;
}
export type SourceIdentityScope=Pick<SourceIdentity,'provider'|'accountScope'|'sourceThreadId'|'sourceContainerKey'|'entityKind'|'nativeId'>;
export interface ImportWorkOperations {
  resolveSourceIdentity:{args:{scope:SourceIdentityScope};result:QuixiId|null};
  readEntity:{args:{collection:Exclude<keyof CanonicalHistory,'version'>;id:QuixiId};result:JsonValue|null};
  importRunBegin:{args:{operationId:QuixiId;run:Omit<ImportRun,'state'|'summary'>};result:ImportRun};
  importRunList:{args:{state:ImportRun['state']|null;page:PageBudget};result:EntityPage};
  importRunStatus:{args:{runId:QuixiId};result:ImportRun};
  importRunSetState:{args:{operationId:QuixiId;runId:QuixiId;state:ImportRun['state'];summary:JsonObject};result:ImportRun};
  importRunReadGroups:{args:{runId:QuixiId;page:PageBudget};result:EntityPage};
  /** Key identity is the idempotency key. Storage injects a UUID only for a first allocation; retries return the same value. */
  importAllocateIds:{args:{runId:QuixiId;keys:string[]};result:{key:string;id:QuixiId}[]};
  importWorkStage:{args:{operationId:QuixiId;runId:QuixiId;groupKey:string;records:ImportWorkRecord[]};result:ImportWorkGroup};
  importWorkSeal:{args:{operationId:QuixiId;runId:QuixiId;groupKey:string;metadata:JsonObject};result:ImportWorkGroup};
  importWorkGroupStatus:{args:{runId:QuixiId;groupKey:string};result:ImportWorkGroup|null};
  /** Ready pages are queue peeks: cursor must be null; acknowledge results and query again. */
  importWorkRead:{args:{runId:QuixiId;groupKey:string;state:'ready'|'all';page:PageBudget};result:{items:ImportWorkItem[];nextCursor:string|null;bytes:number;blocked:'missing_parent'|'cycle'|null}};
  importWorkGet:{args:{runId:QuixiId;groupKey:string;key:string};result:ImportWorkItem|null};
  importWorkCheckpoint:{args:{operationId:QuixiId;runId:QuixiId;groupKey:string;key:string;expectedRevision:number;checkpoint:JsonObject};result:{revision:number;checkpoint:JsonObject}};
  importWorkResolve:{args:{operationId:QuixiId;runId:QuixiId;groupKey:string;key:string;result:ImportWorkResult};result:ImportWorkGroup};
  importGroupFinish:{args:{operationId:QuixiId;runId:QuixiId;groupKey:string;outcome:'published'|'skipped'|'failed'|'complete';normalizedImportId:QuixiId|null;report:JsonObject};result:ImportWorkGroup};
}
export const IMPORT_WORK_LIMITS=Object.freeze({maxItems:128,maxMetadataBytes:65_536,maxKeyCharacters:8192});
const key=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=IMPORT_WORK_LIMITS.maxKeyCharacters;
const integer=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const object=(value:unknown)=>{jsonByteLength(value,IMPORT_WORK_LIMITS.maxMetadataBytes);return value!==null&&typeof value==='object'&&!Array.isArray(value)&&isJsonValue(value);};
export function assertImportWorkArgs(operation:keyof ImportWorkOperations,value:unknown):void{
  jsonByteLength(value);if(!value||typeof value!=='object')throw new Error('Invalid import work arguments');const args=value as Record<string,unknown>;
  if(operation==='resolveSourceIdentity'){
    const s=args.scope as SourceIdentityScope|undefined;
    if(!s||!key(s.provider)||!key(s.accountScope)||!(s.sourceThreadId===null||key(s.sourceThreadId))||!key(s.sourceContainerKey)||!key(s.nativeId)||!['thread','message','generation','part','attachment','document','event'].includes(s.entityKind))throw new Error('Invalid source identity scope');return;
  }
  if(operation==='readEntity'){
    if(!isQuixiId(args.id)||!['summaryProposals','threads','threadStates','contexts','messages','generations','parts','events','attachments','documents','rawObjects','importSources','sourceIdentities','provenance','tombstones'].includes(String(args.collection)))throw new Error('Invalid canonical entity lookup');return;
  }
  if(operation==='importRunBegin'){
    const run=args.run as ImportRun|undefined;
    if(!isQuixiId(args.operationId)||!run||!isQuixiId(run.runId)||!isQuixiId(run.workspaceId)||![run.provider,run.accountScope,run.importerName,run.importerVersion,run.formatProfile].every(key)||!integer(run.recordedAt))throw new Error('Invalid import run declaration');return;
  }
  if(operation==='importRunList'){if(!(args.state===null||['running','paused','complete','cancelled'].includes(String(args.state))))throw new Error('Invalid import run filter');return;}
  if(!isQuixiId(args.runId))throw new Error('Invalid import run ID');
  if(['importRunSetState','importWorkStage','importWorkSeal','importWorkCheckpoint','importWorkResolve','importGroupFinish'].includes(operation)&&!isQuixiId(args.operationId))throw new Error('Invalid import work operation ID');
  if(operation.startsWith('importWork')||operation==='importGroupFinish')if(!key(args.groupKey))throw new Error('Invalid import work group key');
  switch(operation){
    case 'importRunStatus':case 'importRunReadGroups':case 'importWorkGroupStatus':break;
    case 'importRunSetState':if(!['running','paused','complete','cancelled'].includes(String(args.state))||!object(args.summary))throw new Error('Invalid import run state');break;
    case 'importAllocateIds':if(!Array.isArray(args.keys)||args.keys.length<1||args.keys.length>128||!args.keys.every(key)||new Set(args.keys).size!==args.keys.length)throw new Error('Invalid bounded ID allocation');break;
    case 'importWorkStage':{
      if(!Array.isArray(args.records)||args.records.length<1||args.records.length>128)throw new Error('Invalid bounded work staging');const seen=new Set<string>();
      for(const row of args.records as ImportWorkRecord[]){if(!row||!key(row.key)||seen.has(row.key)||!(row.parentKey===null||key(row.parentKey))||!integer(row.byteStart)||!integer(row.byteEnd)||row.byteEnd<row.byteStart||!object(row.payload))throw new Error('Invalid import work record');seen.add(row.key);}break;
    }
    case 'importWorkSeal':if(!object(args.metadata))throw new Error('Invalid import group metadata');break;
    case 'importWorkGet':if(!key(args.key))throw new Error('Invalid import work key');break;
    case 'importWorkRead':if(!['ready','all'].includes(String(args.state))||(args.state==='ready'&&(args.page as PageBudget)?.cursor!==null))throw new Error('Invalid import work queue request');break;
    case 'importWorkCheckpoint':if(!key(args.key)||!integer(args.expectedRevision)||!object(args.checkpoint))throw new Error('Invalid import work checkpoint');break;
    case 'importWorkResolve':{
      const result=args.result as ImportWorkResult|undefined;if(!key(args.key)||!result||!(result.canonicalId===null||isQuixiId(result.canonicalId))||!object(result.data))throw new Error('Invalid import work resolution');break;
    }
    case 'importGroupFinish':if(!['published','skipped','failed','complete'].includes(String(args.outcome))||!(args.normalizedImportId===null||isQuixiId(args.normalizedImportId))||!object(args.report))throw new Error('Invalid import group finish');break;
  }
}
