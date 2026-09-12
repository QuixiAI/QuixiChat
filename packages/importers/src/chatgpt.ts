import type {ImportRun,ImportWorkGroup,ImportWorkRecord} from '@quixi/core/contracts';
import type {JsonObject,RawObject} from '@quixi/core/model';
import {ImportSession,WorkCheckpoint,withRunLease} from './storage.ts';
import {retainedSource} from './bytes.ts';
import {upload} from './upload.ts';
import {scanClaude} from './claude-scan.ts';
import {scanChatgpt} from './chatgpt-scan.ts';
import {chatgptControlRecord,normalizeChatgptGroup} from './normalize.ts';
import {CHATGPT_PROFILE,CLAUDE_PROFILE,IMPORTER_NAME,IMPORTER_VERSION} from './types.ts';
import type {ImportByteSource,ImportRuntime} from './types.ts';

export interface BeginChatgptImport {operationId:string;runId:string;workspaceId:string;accountScope:string;recordedAt:number}
export async function beginChatgptImport(runtime:ImportRuntime,args:BeginChatgptImport):Promise<ImportRun>{return runtime.storage.request(runtime.nextId(),'importRunBegin',{operationId:args.operationId,run:{runId:args.runId,workspaceId:args.workspaceId,accountScope:args.accountScope,recordedAt:args.recordedAt,provider:'openai',importerName:IMPORTER_NAME,importerVersion:IMPORTER_VERSION,formatProfile:CHATGPT_PROFILE}});}

/** Import one explicitly selected conversations JSON/shard. The caller keeps runId/sourceKey stable when resuming. */
export interface ImportSourceArgs {runId:string;sourceKey:string;source?:ImportByteSource}
export async function importChatgptSource(runtime:ImportRuntime,args:ImportSourceArgs):Promise<ImportWorkGroup>{return withRunLease(runtime,args.runId,leased=>importProviderSource(leased,args,'openai',CHATGPT_PROFILE,scanChatgpt));}
export async function beginClaudeImport(runtime:ImportRuntime,args:BeginChatgptImport):Promise<ImportRun>{return runtime.storage.request(runtime.nextId(),'importRunBegin',{operationId:args.operationId,run:{runId:args.runId,workspaceId:args.workspaceId,accountScope:args.accountScope,recordedAt:args.recordedAt,provider:'anthropic',importerName:IMPORTER_NAME,importerVersion:IMPORTER_VERSION,formatProfile:CLAUDE_PROFILE}});}
export async function importClaudeSource(runtime:ImportRuntime,args:ImportSourceArgs):Promise<ImportWorkGroup>{return withRunLease(runtime,args.runId,leased=>importProviderSource(leased,args,'anthropic',CLAUDE_PROFILE,scanClaude));}
async function importProviderSource(runtime:ImportRuntime,args:ImportSourceArgs,provider:string,profile:string,scanner:typeof scanChatgpt):Promise<ImportWorkGroup>{
 const run=await runtime.storage.request(runtime.nextId(),'importRunStatus',{runId:args.runId});
 if(run.provider!==provider||run.formatProfile!==profile||run.importerVersion!==IMPORTER_VERSION)throw new Error('Run requires its original importer version and format profile');
 const session=new ImportSession(runtime,run),sourceGroup=JSON.stringify(['source',args.sourceKey]);
 let group=await session.request('importWorkGroupStatus',{runId:run.runId,groupKey:sourceGroup});
 if(group?.state==='complete')return group;
 if(!group){
  if(!args.source)throw new Error('Select the original source to resume its unfinished byte preservation');
  const record:ImportWorkRecord={key:'bytes',parentKey:null,byteStart:0,byteEnd:args.source.byteLength,payload:{kind:'source',name:args.source.name,byteLength:args.source.byteLength,sourceKey:args.sourceKey}};
  await session.request('importWorkStage',{operationId:await session.operation(JSON.stringify([sourceGroup,'create'])),runId:run.runId,groupKey:sourceGroup,records:[record]});
  group=await session.request('importWorkSeal',{operationId:await session.operation(JSON.stringify([sourceGroup,'seal'])),runId:run.runId,groupKey:sourceGroup,metadata:{kind:'source',name:args.source.name,byteLength:args.source.byteLength,sourceKey:args.sourceKey}});
 }else if(group.state==='staging'){
  const item=await session.request('importWorkGet',{runId:run.runId,groupKey:sourceGroup,key:'bytes'});if(!item)throw new Error('Source preparation record missing');
  group=await session.request('importWorkSeal',{operationId:await session.operation(JSON.stringify([sourceGroup,'seal'])),runId:run.runId,groupKey:sourceGroup,metadata:{kind:'source',name:item.payload.name!,byteLength:item.payload.byteLength!,sourceKey:args.sourceKey}});
 }
 const item=await session.request('importWorkGet',{runId:run.runId,groupKey:sourceGroup,key:'bytes'});if(!item)throw new Error('Source checkpoint missing');
 const work=WorkCheckpoint.from(session,sourceGroup,item);let raw=work.data.raw as unknown as RawObject|undefined;
 if(!raw){
  const state=work.data.rawUpload as JsonObject|undefined;
  if(!args.source&&(!state||state.phase==='uploading'||state.phase==='new'))throw new Error('Select the original source to resume its unfinished byte preservation');
  if(args.source&&(args.source.byteLength!==group.metadata.byteLength||args.source.name!==group.metadata.name))throw new Error('Source selection does not match this durable capture');
  const blob=await upload(work,'rawUpload','raw_source',()=>{if(!args.source)throw new Error('Original source is required');return args.source.open();},Number(group.metadata.byteLength));
  const [rawObjectId,transactionId,operationId]=await session.ids(...['raw-object','raw-transaction','raw-operation'].map(kind=>JSON.stringify([sourceGroup,kind])));
  raw={id:rawObjectId!,availability:'available',sha256:blob.sha256,byteLength:blob.byteLength,mediaType:'application/json',storageRef:`sha256:${blob.sha256}`};
  await session.request('commit',{transactionId:transactionId!,mutations:[{version:1,operationId:operationId!,kind:'RegisterRawObject',recordedAt:run.recordedAt,payload:{rawObject:raw}}],expectedThreadRevisions:[],stagedBlobIds:[blob.transferId]});
  await work.save({...work.data,raw:raw as unknown as JsonObject});
 }
 if(!raw.sha256)throw new Error('Captured source digest missing');
 const source=await retainedSource(session,raw.sha256,String(group.metadata.name));let groups=Number(work.data.groups??0);
 try{
  let activeKey:string|null=null,existing:ImportWorkGroup|null=null;
  for await(const action of scanner(source,raw.sha256,runtime.cancelled)){
   if(activeKey!==action.groupKey){activeKey=action.groupKey;existing=await session.request('importWorkGroupStatus',{runId:run.runId,groupKey:activeKey});}
   if(action.kind==='work'){
    if(existing&&existing.state!=='staging')continue;
    await session.request('importWorkStage',{operationId:await session.operation(JSON.stringify([action.groupKey,'scan',action.record.key])),runId:run.runId,groupKey:action.groupKey,records:[action.record]});
   }else{
    if(!existing||existing.state==='staging'){
     const record=chatgptControlRecord(Number(action.metadata.byteStart),Number(action.metadata.byteEnd));
     await session.request('importWorkStage',{operationId:await session.operation(JSON.stringify([action.groupKey,'scan-control'])),runId:run.runId,groupKey:action.groupKey,records:[record]});
     existing=await session.request('importWorkSeal',{operationId:await session.operation(JSON.stringify([action.groupKey,'scan-seal'])),runId:run.runId,groupKey:action.groupKey,metadata:{...action.metadata,rawObjectId:raw.id}});
    }
    await normalizeChatgptGroup(session,source,raw.id,existing);groups++;
    runtime.onProgress?.({runId:run.runId,phase:'normalizing',processedBytes:Number(action.metadata.byteEnd),totalBytes:source.byteLength,groups,messages:0,parts:0});
   }
  }
 }finally{await source.close();}
 await session.request('importWorkResolve',{operationId:await session.operation(JSON.stringify([sourceGroup,'resolve'])),runId:run.runId,groupKey:sourceGroup,key:'bytes',result:{canonicalId:raw.id,data:{sha256:raw.sha256,byteLength:raw.byteLength}}});
 const completed=await session.request('importGroupFinish',{operationId:await session.operation(JSON.stringify([sourceGroup,'finish'])),runId:run.runId,groupKey:sourceGroup,outcome:'complete',normalizedImportId:null,report:{rawObjectId:raw.id,sha256:raw.sha256,groups}});
 runtime.onProgress?.({runId:run.runId,phase:'complete',processedBytes:source.byteLength,totalBytes:source.byteLength,groups,messages:0,parts:0});return completed;
}
