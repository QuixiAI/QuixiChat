import type {ImportRuntime,ImportByteSource} from '../types.ts';
import type {ImportWorkGroup,StorageOperations} from '@quixi/core/contracts';
import type {JsonObject} from '@quixi/core/model';
import {ImportSession,withRunLease} from '../storage.ts';
import {preserveImportFile} from '../capture.ts';
import {retainedSource} from '../bytes.ts';
import {importChatgptSource,importClaudeSource} from '../chatgpt.ts';
import {zipEntries,openZipEntry} from './reader.ts';
import type {ZipEntryDescriptor} from './reader.ts';

export interface ImportZipArgs {runId:string;sourceKey:string;source?:ImportByteSource;maxEntryBytes:number}
function entrySource(archive:ImportByteSource,entry:ZipEntryDescriptor,maxEntryBytes:number,cancelled:()=>boolean):ImportByteSource{
 return{name:entry.name,byteLength:entry.byteLength,async*open(start=0,end=entry.byteLength){
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>entry.byteLength)throw new Error('Invalid ZIP entry range');let offset=0;
  for await(const bytes of openZipEntry(archive,entry,{maxEntryBytes,cancelled})){const from=Math.max(0,start-offset),to=Math.min(bytes.length,end-offset);if(to>from)yield bytes.subarray(from,to);offset+=bytes.length;}
 }};
}
/** Captures the exact ZIP first, indexes names/offsets in SQL, then imports one JSON/shard at a time. */
export async function importProviderZip(runtime:ImportRuntime,args:ImportZipArgs):Promise<ImportWorkGroup>{return withRunLease(runtime,args.runId,leased=>importZip(leased,args));}
async function importZip(runtime:ImportRuntime,args:ImportZipArgs):Promise<ImportWorkGroup>{
 const run=await runtime.storage.request(runtime.nextId(),'importRunStatus',{runId:args.runId}),session=new ImportSession(runtime,run);
 if(!['openai','anthropic'].includes(run.provider))throw new Error('Unsupported provider archive');
 const raw=await preserveImportFile(runtime,{runId:run.runId,sourceKey:args.sourceKey,mediaType:'application/zip',...(args.source?{source:args.source}:{})});if(!raw.sha256)throw new Error('Archive digest is absent');
 const groupKey=JSON.stringify(['zip-directory',raw.sha256]);let group=await session.request('importWorkGroupStatus',{runId:run.runId,groupKey});if(group?.state==='complete')return group;
 const archive=await retainedSource(session,raw.sha256,args.source?.name??'retained-export.zip');
 try{
  if(!group||group.state==='staging'){
   let count=0;for await(const entry of zipEntries(archive,{maxEntryBytes:args.maxEntryBytes,cancelled:runtime.cancelled})){const {open:_,...descriptor}=entry;
    await session.request('importWorkStage',{operationId:await session.operation(JSON.stringify([groupKey,'entry',entry.ordinal])),runId:run.runId,groupKey,records:[{key:entry.name,parentKey:null,byteStart:entry.localOffset,byteEnd:entry.directoryOffset,payload:descriptor as unknown as JsonObject}]});count++;
   }
   if(!count)throw new Error('Export ZIP contains no entries');
   group=await session.request('importWorkSeal',{operationId:await session.operation(JSON.stringify([groupKey,'seal'])),runId:run.runId,groupKey,metadata:{kind:'zip-directory',rawObjectId:raw.id,sha256:raw.sha256,entries:count}});
  }
  const assets={async resolve(name:string){const item=await session.request('importWorkGet',{runId:run.runId,groupKey,key:name});if(!item||item.payload.directory)return null;return{source:entrySource(archive,item.payload as unknown as ZipEntryDescriptor,args.maxEntryBytes,runtime.cancelled),rawObjectId:raw.id,locator:`zip-entry:${name}`};}};
  let selected=0,cursor:string|null=null;
  do{
   const page:StorageOperations['importWorkRead']['result']=await session.request('importWorkRead',{runId:run.runId,groupKey,state:'all',page:{maxItems:32,maxBytes:900_000,cursor}});
   for(const item of page.items){
    const entry=item.payload as unknown as ZipEntryDescriptor;const selectedSource=!entry.directory&&/(^|\/)conversations(?:-\d+)?\.json$/i.test(entry.name);if(selectedSource)selected++;
    if(item.state==='resolved')continue;
    if(selectedSource){const importer=run.provider==='openai'?importChatgptSource:importClaudeSource;await importer({...runtime,assets},{runId:run.runId,sourceKey:JSON.stringify([raw.sha256,entry.ordinal,entry.name]),source:entrySource(archive,entry,args.maxEntryBytes,runtime.cancelled)});}
    await session.request('importWorkResolve',{operationId:await session.operation(JSON.stringify([groupKey,'resolve',item.key])),runId:run.runId,groupKey,key:item.key,result:{canonicalId:null,data:{selectedSource,retainedInArchive:true}}});
   }
   cursor=page.nextCursor;
  }while(cursor);
  if(!selected)throw new Error('ZIP contains no supported conversations JSON file or numbered shard; original archive is retained');
  return await session.request('importGroupFinish',{operationId:await session.operation(JSON.stringify([groupKey,'finish'])),runId:run.runId,groupKey,outcome:'complete',normalizedImportId:null,report:{rawObjectId:raw.id,sha256:raw.sha256,selectedSources:selected,assetMatching:'exact_archive_path_only',otherEntries:'retained_in_original_archive'}});
 }finally{await archive.close();}
}
