import {withImportRunLease,IMPORTER_NAME,IMPORTER_VERSION} from '@quixi/importers';
import type {ImportRuntime} from '@quixi/importers';
import type {ImportRun,ImportWorkGroup,StorageOperations,NormalizedImportStatus} from '@quixi/core/contracts';
import {isQuixiId} from '@quixi/core/model';
import type {JsonObject,JsonValue} from '@quixi/core/model';
const object=(value:JsonValue|undefined):JsonObject=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
/** Only hidden scratch and this run's owned upload handles are discarded. Already published canonical records and bytes stay intact. */
export async function discardUnfinishedImport(runtime:ImportRuntime,args:{runId:string;operationId:string}):Promise<ImportRun>{
 if(!isQuixiId(args.runId)||!isQuixiId(args.operationId))throw new Error('Invalid discard identity');
 return withImportRunLease(runtime,args.runId,async leased=>{
  const request=<K extends keyof StorageOperations>(operation:K,value:StorageOperations[K]['args'])=>leased.storage.request(leased.nextId(),operation,value);
  const key=async(...parts:string[])=>{const bytes=new TextEncoder().encode(JSON.stringify(['discard',args.operationId,...parts]));const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');return(await request('importAllocateIds',{runId:args.runId,keys:[`discard:${hash}`]}))[0]!.id;};
  let run=await request('importRunStatus',{runId:args.runId});if(run.state==='cancelled'||run.state==='complete')return run;
  if(run.importerName!==IMPORTER_NAME||run.importerVersion!==IMPORTER_VERSION)throw new Error('This import needs its original version to safely discard unfinished work');
  if(typeof run.summary.discardOperationId==='string'&&run.summary.discardOperationId!==args.operationId)throw new Error('Resume the saved discard action using its original identity');
  run=await request('importRunSetState',{operationId:args.operationId,runId:args.runId,state:'running',summary:{...run.summary,discardOperationId:args.operationId,lastMessage:'Discarding unfinished work. Saved conversations and original files are retained.'}});
  let cursor:string|null=null;
  do{
   const page:StorageOperations['importRunReadGroups']['result']=await request('importRunReadGroups',{runId:args.runId,page:{maxItems:16,maxBytes:900_000,cursor}});
   for(const value of page.items){const group=value as unknown as ImportWorkGroup;if(group.state!=='staging'&&group.state!=='sealed')continue;
    const control=await request('importWorkGet',{runId:args.runId,groupKey:group.groupKey,key:'control'}),plan=object(control?.checkpoint.plan);let normalized:NormalizedImportStatus|null=null;
    if(typeof plan.importId==='string'){try{normalized=await request('normalizedImportStatus',{importId:plan.importId});}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='NOT_FOUND'))throw error;}}
    if(normalized?.state==='published'){
     while(true){const ready=await request('importWorkRead',{runId:args.runId,groupKey:group.groupKey,state:'ready',page:{maxItems:64,maxBytes:900_000,cursor:null}});if(!ready.items.length){if(ready.blocked)throw new Error('Published import has inconsistent scratch dependencies; its saved history is preserved');break;}
      for(const item of ready.items)await request('importWorkResolve',{operationId:await key(group.groupKey,'published-work',item.key),runId:args.runId,groupKey:group.groupKey,key:item.key,result:{canonicalId:null,data:{publicationAlreadyCommitted:true,discardedScratch:true}}});
     }
     await request('importGroupFinish',{operationId:await key(group.groupKey,'finish-published'),runId:args.runId,groupKey:group.groupKey,outcome:'published',normalizedImportId:normalized.importId,report:{threadId:normalized.threadId,importSourceId:plan.importSourceId??null,records:normalized.recordCount,publicationAlreadyCommitted:true}});continue;
    }
    if(normalized)await request('cancelNormalizedImport',{operationId:await key(group.groupKey,'cancel-normalized'),importId:normalized.importId});
    let workCursor:string|null=null;
    do{const work:StorageOperations['importWorkRead']['result']=await request('importWorkRead',{runId:args.runId,groupKey:group.groupKey,state:'all',page:{maxItems:32,maxBytes:900_000,cursor:workCursor}});
     for(const item of work.items)for(const slot of ['rawUpload','upload','textBlob','imageBlob','attachmentBlob','resolvedAttachment']){
      const upload=object(item.checkpoint[slot]);let transferId=typeof upload.transferId==='string'?upload.transferId:null;
      if(!transferId&&typeof upload.beginOperationId==='string'){const status=await request('operationStatus',{operationId:upload.beginOperationId});if(status.status==='committed'){const result=object(status.result);if(typeof result.transferId==='string')transferId=result.transferId;}}
      if(transferId)await request('discardBlobTransfer',{transferId});
     }
     workCursor=work.nextCursor;
    }while(workCursor);
    await request('importGroupFinish',{operationId:await key(group.groupKey,'finish-discarded'),runId:args.runId,groupKey:group.groupKey,outcome:'failed',normalizedImportId:normalized?.importId??null,report:{reason:'user_discarded_unfinished_work',originalSourcesRetained:true}});
   }
   cursor=page.nextCursor;
  }while(cursor);
  return request('importRunSetState',{operationId:await key('finish'),runId:args.runId,state:'cancelled',summary:{...run.summary,discardOperationId:null,lastMessage:'Unfinished work discarded. Saved conversations and original files are retained.'}});
 });
}
