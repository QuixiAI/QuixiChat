import type {ImportRuntime} from './types.ts';
import type {ImportRun,ImportWorkGroup,EntityPage} from '@quixi/core/contracts';
import type {JsonObject} from '@quixi/core/model';
/** Newline-delimited JSON report, emitted one bounded record at a time for a host-owned streaming destination. */
export async function* exportImportReport(runtime:ImportRuntime,args:{runId:string}):AsyncGenerator<Uint8Array>{
 const encoder=new TextEncoder(),line=(value:unknown)=>encoder.encode(JSON.stringify(value)+'\n');
 const run=await runtime.storage.request(runtime.nextId(),'importRunStatus',{runId:args.runId});yield line({type:'import-run',version:1,run});
 let cursor:string|null=null;
 do{
  const result:EntityPage=await runtime.storage.request(runtime.nextId(),'importRunReadGroups',{runId:args.runId,page:{maxItems:16,maxBytes:900_000,cursor}});
  for(const value of result.items){const group=value as unknown as ImportWorkGroup;yield line({type:'import-group',group});
   const threadId=group.report.threadId,importSourceId=group.report.importSourceId;if(typeof threadId!=='string'||typeof importSourceId!=='string')continue;
   let eventsCursor:string|null=null;do{const events:EntityPage=await runtime.storage.request(runtime.nextId(),'readEntities',{collection:'events',threadId,page:{maxItems:64,maxBytes:900_000,cursor:eventsCursor}});for(const event of events.items){const entry=event as JsonObject;if((entry.details as JsonObject)?.importSourceId===importSourceId)yield line({type:'import-warning',event});}eventsCursor=events.nextCursor;}while(eventsCursor);
  }
  cursor=result.nextCursor;
 }while(cursor);
}
/** Caller supplies the durable action ID, including when a timeout leaves this control's outcome unknown. */
export async function setImportRunState(runtime:ImportRuntime,args:{operationId:string;runId:string;state:ImportRun['state'];summary:JsonObject}):Promise<ImportRun>{return runtime.storage.request(runtime.nextId(),'importRunSetState',args);}
