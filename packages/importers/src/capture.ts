import type {ImportRuntime,ImportByteSource} from './types.ts';
import type {JsonObject,RawObject} from '@quixi/core/model';
import {ImportSession,WorkCheckpoint,withRunLease} from './storage.ts';
import {upload} from './upload.ts';

/** Preserve an archive/sidecar independently of normalized conversations, with a restartable durable capture record. */
export interface PreserveFileArgs {runId:string;sourceKey:string;mediaType:string;source?:ImportByteSource}
export async function preserveImportFile(runtime:ImportRuntime,args:PreserveFileArgs):Promise<RawObject>{return withRunLease(runtime,args.runId,leased=>capture(leased,args));}
async function capture(runtime:ImportRuntime,args:PreserveFileArgs):Promise<RawObject>{
 const run=await runtime.storage.request(runtime.nextId(),'importRunStatus',{runId:args.runId}),session=new ImportSession(runtime,run),groupKey=JSON.stringify(['retained-file',args.sourceKey]);
 let group=await session.request('importWorkGroupStatus',{runId:run.runId,groupKey});
 if(group?.state==='complete'){const raw=await session.request('readEntity',{collection:'rawObjects',id:String(group.report.rawObjectId)});if(!raw)throw new Error('Retained archive record is missing');return raw as unknown as RawObject;}
 if(!group){if(!args.source)throw new Error('Select the original file to finish byte preservation');await session.request('importWorkStage',{operationId:await session.operation(JSON.stringify([groupKey,'create'])),runId:run.runId,groupKey,records:[{key:'bytes',parentKey:null,byteStart:0,byteEnd:args.source.byteLength,payload:{kind:'retained-file',name:args.source.name,byteLength:args.source.byteLength,mediaType:args.mediaType}}]});}
 const item=await session.request('importWorkGet',{runId:run.runId,groupKey,key:'bytes'});if(!item)throw new Error('Retained-file checkpoint missing');
 if(item.payload.mediaType!==args.mediaType)throw new Error('Capture media type changed');
 if(!group||group.state==='staging')group=await session.request('importWorkSeal',{operationId:await session.operation(JSON.stringify([groupKey,'seal'])),runId:run.runId,groupKey,metadata:item.payload});
 const work=WorkCheckpoint.from(session,groupKey,item);let raw=work.data.raw as unknown as RawObject|undefined;
 if(!raw){const state=work.data.upload as JsonObject|undefined;if(!args.source&&(!state||state.phase==='uploading'||state.phase==='new'))throw new Error('Select the original file to finish byte preservation');
  if(args.source&&(args.source.name!==item.payload.name||args.source.byteLength!==item.payload.byteLength))throw new Error('Original archive selection changed');
  const blob=await upload(work,'upload','raw_source',()=>{if(!args.source)throw new Error('Original archive bytes are required');return args.source.open();},Number(item.payload.byteLength));
  const [id,transactionId,operationId]=await session.ids(...['raw','transaction','operation'].map(key=>JSON.stringify([groupKey,key])));
  raw={id:id!,availability:'available',sha256:blob.sha256,byteLength:blob.byteLength,mediaType:args.mediaType,storageRef:`sha256:${blob.sha256}`};
  await session.request('commit',{transactionId:transactionId!,mutations:[{version:1,operationId:operationId!,kind:'RegisterRawObject',recordedAt:run.recordedAt,payload:{rawObject:raw}}],expectedThreadRevisions:[],stagedBlobIds:[blob.transferId]});await work.save({...work.data,raw:raw as unknown as JsonObject});
 }
 await session.request('importWorkResolve',{operationId:await session.operation(JSON.stringify([groupKey,'resolve'])),runId:run.runId,groupKey,key:'bytes',result:{canonicalId:raw.id,data:{sha256:raw.sha256}}});
 await session.request('importGroupFinish',{operationId:await session.operation(JSON.stringify([groupKey,'finish'])),runId:run.runId,groupKey,outcome:'complete',normalizedImportId:null,report:{rawObjectId:raw.id,sha256:raw.sha256,byteLength:raw.byteLength}});return raw;
}
