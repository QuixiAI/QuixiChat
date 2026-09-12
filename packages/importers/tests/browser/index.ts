import { createIsolatedStorageClient as createStorageClient } from "../../../storage/tests/isolated-client.ts";
import type {StorageClient,StorageOperations} from '@quixi/core/contracts';
import type {ContentPart,JsonObject,Message,RawObject} from '@quixi/core/model';
import {beginChatgptImport,beginClaudeImport,importChatgptSource,importClaudeSource,importProviderZip,exportImportReport} from '../../src/index.ts';
import type {ImportRuntime,ImportByteSource} from '../../src/index.ts';
const id=()=>crypto.randomUUID(),page={maxItems:64,maxBytes:900_000,cursor:null};let client:ReturnType<typeof createStorageClient>,paused=false;let releaseRun:(()=>void)|null=null,heldRun:Promise<unknown>|null=null;
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function source(file:Blob,name:string):ImportByteSource{return{name,byteLength:file.size,async*open(start=0,end=file.size){const reader=file.slice(start,end).stream().getReader();try{while(true){const chunk=await reader.read();if(chunk.done)break;for(let offset=0;offset<chunk.value.length;offset+=1_048_576)yield chunk.value.subarray(offset,offset+1_048_576);}}finally{await reader.cancel();reader.releaseLock();}}};}
const progress:{phase:string;processedBytes:number}[]=[];
function runtime(storage:StorageClient=client):ImportRuntime{return{storage,nextId:id,now:()=>Date.now(),cancelled:()=>paused,onProgress:value=>{if(progress.length>=128)progress.shift();progress.push({phase:value.phase,processedBytes:value.processedBytes});}};}
async function begin(provider:'openai'|'anthropic',accountScope:string){const runId=id(),args={operationId:id(),runId,workspaceId:id(),accountScope,recordedAt:1788870000000};await(provider==='openai'?beginChatgptImport:beginClaudeImport)(runtime(),args);return runId;}
async function all(collection:'threads'|'messages'|'rawObjects'|'attachments'|'parts'|'events'){const items:JsonObject[]=[];let cursor:string|null=null;do{const result:StorageOperations['readEntities']['result']=await client.request(id(),'readEntities',{collection,threadId:null,page:{...page,cursor}});items.push(...result.items as JsonObject[]);cursor=result.nextCursor;}while(cursor);return items;}
async function readBytes(sha256:string):Promise<Uint8Array>{const transfer=await client.request(id(),'readBlobTransfer',{sha256}),bytes=new Uint8Array(transfer.byteLength);try{while(true){const chunk=await client.readChunk(transfer.transferId);bytes.set(chunk.bytes,chunk.offset);await client.acknowledgeChunk({transferId:transfer.transferId,sequence:chunk.sequence,committedOffset:chunk.offset+chunk.bytes.length});if(chunk.final)break;}return bytes;}finally{await client.request(id(),'discardBlobTransfer',{transferId:transfer.transferId});}}
async function verify(){
 const diagnostics=await client.request(id(),'diagnostics',null);assert(diagnostics.integrity==='ok','SQLite integrity failed');
 const threads=await all('threads'),messages=await all('messages') as unknown as Message[],raw=await all('rawObjects') as unknown as RawObject[],attachments=await all('attachments');
 let textBlobs=0,parts=0,artifacts=0;
 for(const message of messages){let cursor:string|null=null,count=0;do{const result:StorageOperations['readMessageParts']['result']=await client.request(id(),'readMessageParts',{messageId:message.id,page:{...page,cursor}});for(const value of result.items){const part=value as unknown as ContentPart;assert(part.order===count++,'Part order/count changed');if(part.kind==='ProviderArtifact')artifacts++;if(part.kind==='Text'&&part.data.textBlob){const bytes=await readBytes(part.data.textBlob.sha256);assert(bytes.length===part.data.textBlob.byteLength,'Long text blob truncated');new TextDecoder('utf-8',{fatal:true}).decode(bytes);textBlobs++;}}cursor=result.nextCursor;}while(cursor);assert(count===message.partCount,'Sealed message part count changed');parts+=count;}
 for(const object of raw){assert(object.sha256&&object.byteLength!==null,'Raw source unavailable');const bytes=await readBytes(object.sha256);const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(n=>n.toString(16).padStart(2,'0')).join('');assert(hash===object.sha256&&bytes.length===object.byteLength,'Original source bytes changed');}
 return{diagnostics,threads:threads.length,messages:messages.length,parts,textBlobs,artifacts,rawObjects:raw.length,availableAttachments:attachments.filter(a=>a.availability==='available').length,progress};
}
const api=async(operation:string,value:unknown):Promise<unknown>=>{
 switch(operation){
  case 'open':client=createStorageClient({archiveId:String(value),timeoutMs:60_000});paused=false;return client.request(id(),'diagnostics',null);
  case 'hold_run':{let acquired!:()=>void;const ready=new Promise<void>(resolve=>{acquired=resolve;});const held=new Promise<void>(resolve=>{releaseRun=resolve;});heldRun=navigator.locks.request(`quixi:import-run:${String(value)}`,{mode:'exclusive'},async()=>{acquired();await held;});await ready;return null;}
  case 'release_run':releaseRun?.();await heldRun;releaseRun=null;heldRun=null;return null;
  case 'check_run_busy':{try{await importChatgptSource(runtime(),{runId:String(value),sourceKey:'resume-file'});throw new Error('Expected competing executor rejection');}catch(error){assert(String(error).includes('active in another tab'),'Unexpected lease result '+String(error));return{busy:true,visibleThreads:(await all('threads')).length};}}
  case 'diagnostics':return client.request(id(),'diagnostics',null);
  case 'zip':{const runId=await begin('openai','chatgpt-fixture');const file=await(await fetch('/fixtures/export.zip')).blob();const result=await importProviderZip(runtime(),{runId,sourceKey:'selected-export',source:source(file,'export.zip'),maxEntryBytes:16_000_000});return{runId,result,verification:await verify()};}
  case 'claude':{const runId=await begin('anthropic','claude-fixture'),file=await(await fetch('/fixtures/claude.json')).blob();await importClaudeSource(runtime(),{runId,sourceKey:'claude-json',source:source(file,'conversations.json')});return{runId,verification:await verify()};}
  case 'prepare_resume':{const runId=await begin('openai','resume-fixture'),file=await(await fetch('/fixtures/resume.json')).blob();let injected=false;
   const wrapped:StorageClient={request:async<K extends keyof StorageOperations>(requestId:string,name:K,args:StorageOperations[K]['args']):Promise<StorageOperations[K]['result']>=>{const result=await client.request(requestId,name,args);if(name==='stageImportRecords'&&!injected){injected=true;throw new Error('injected lost acknowledgment after actual SQL staging');}return result;},sendChunk:chunk=>client.sendChunk(chunk),readChunk:transferId=>client.readChunk(transferId),acknowledgeChunk:ack=>client.acknowledgeChunk(ack),cancel:(requestId,operationId)=>client.cancel(requestId,operationId),onProgress:listener=>client.onProgress(listener),onChange:listener=>client.onChange(listener),close:()=>client.close()};
   try{await importChatgptSource(runtime(wrapped),{runId,sourceKey:'resume-file',source:source(file,'conversations.json')});throw new Error('Expected staging interruption');}catch(error){assert(String(error).includes('injected lost acknowledgment'),'Unexpected importer interruption: '+String(error));}
   return{runId,visibleThreads:(await all('threads')).length,diagnostics:await client.request(id(),'diagnostics',null)};
  }
  case 'resume':{await importChatgptSource(runtime(),{runId:String(value),sourceKey:'resume-file'});return verify();}
  case 'report':{let lines=0,warnings=0;for await(const chunk of exportImportReport(runtime(),{runId:String(value)})){assert(chunk.length<1_048_576,'Report record exceeded bound');const record=JSON.parse(new TextDecoder().decode(chunk));lines++;if(record.type==='import-warning')warnings++;}return{lines,warnings};}
  case 'verify':return verify();
  case 'close':await client.close();return null;
  default:throw new Error('Unknown importer test operation');
 }
};
(globalThis as typeof globalThis&{importerTest:typeof api}).importerTest=api;
