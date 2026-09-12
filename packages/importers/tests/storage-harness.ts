/** Test adapter: real pinned SQLite WASM/MEMFS; byte transport is an explicitly in-memory test double, not OPFS evidence. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import initialize from '../../storage/sqlite/dist/sqlite3.mjs';
import {CanonicalRepository} from '../../storage/src/worker/canonical/index.ts';
import type {CanonicalSqlite} from '../../storage/src/worker/canonical/index.ts';
import type {JsonValue} from '@quixi/core/model';
import {assertStorageRequest,canonicalJson} from '@quixi/core/contracts';
import type {StorageClient,StorageOperations,ByteChunk} from '@quixi/core/contracts';
const wasm=await readFile(new URL('../../storage/sqlite/dist/sqlite3.wasm',import.meta.url));
const manifest=JSON.parse(await readFile(new URL('../../storage/sqlite/artifacts.json',import.meta.url),'utf8'));
assert.equal(createHash('sha256').update(wasm).digest('hex'),manifest.artifacts['sqlite3.wasm'].sha256);
(globalThis as typeof globalThis & {sqlite3ApiConfig:unknown}).sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};
const initOptions={instantiateWasm:async(imports:WebAssembly.Imports,success:(instance:WebAssembly.Instance,module:WebAssembly.Module)=>void)=>{const {instance,module}=await WebAssembly.instantiate(wasm,imports);success(instance,module);},print:()=>{},printErr:()=>{}};
const sqlite=await initialize(initOptions) as {oo1:{DB:new(filename:string,flags:string)=>CanonicalSqlite&{close():void}}};
interface Stage {purpose:string;state:'writing'|'verified'|'interrupted';chunks:Uint8Array[];offset:number;sequence:number;final:boolean;sha256:string|null}
interface Reader {bytes:Uint8Array;offset:number;sequence:number;pending:ByteChunk|null}
export class StorageHarness {
 readonly db=new sqlite.oo1.DB(`/importer-${randomUUID()}.db`,'c');repository:CanonicalRepository;
 readonly stages=new Map<string,Stage>();readonly published=new Map<string,{bytes:Uint8Array;utf8:boolean}>();readonly readers=new Map<string,Reader>();
 afterRequest:((operation:keyof StorageOperations,args:unknown,result:unknown)=>void)|null=null;
 requests=0;maxRequestBytes=0;maxReaders=0;
 constructor(){this.repository=this.openRepository();this.repository.migrate();}
 openRepository():CanonicalRepository{return new CanonicalRepository(this.db,{assertBlobAvailable:(hash,size,_stages,encoding)=>{const blob=this.published.get(hash);assert.ok(blob,'blob must be published before canonical validation');assert.equal(blob.bytes.length,size);if(encoding)assert.ok(blob.utf8,'text must have verified UTF8');}});}
 restart():void{this.repository=this.openRepository();for(const stage of this.stages.values())if(stage.state==='writing')stage.state='interrupted';this.readers.clear();}
 private publish(ids:readonly string[]):void{for(const id of ids){const stage=this.stages.get(id);assert.ok(stage?.state==='verified'&&stage.sha256);const bytes=this.join(stage);if(stage.purpose==='canonical_text')new TextDecoder('utf-8',{fatal:true}).decode(bytes);this.published.set(stage.sha256,{bytes,utf8:stage.purpose==='canonical_text'});}}
 private join(stage:Stage):Uint8Array{const bytes=new Uint8Array(stage.offset);let offset=0;for(const chunk of stage.chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;}
 private blobControl(operation:string,args:{operationId:string},work:()=>unknown):unknown{const identity=canonicalJson({operation,args} as unknown as JsonValue);const previous=this.db.exec({sql:'SELECT identity,result FROM quixi_blob_operations WHERE operation_id=?',bind:[args.operationId],rowMode:'object',returnValue:'resultRows'}) as {identity:string;result:string}[];if(previous[0]){assert.equal(previous[0].identity,identity);return JSON.parse(previous[0].result);}const result=work();this.db.exec({sql:'INSERT INTO quixi_blob_operations VALUES(?,?,?)',bind:[args.operationId,identity,JSON.stringify(result)]});return result;}
 private async dispatch<K extends keyof StorageOperations>(operation:K,args:StorageOperations[K]['args']):Promise<unknown>{
  const repo=this.repository;
  switch(operation){
   case 'operationStatus':return repo.operationStatus((args as StorageOperations['operationStatus']['args']).operationId);
   case 'readEntity':{const a=args as StorageOperations['readEntity']['args'];return repo.get(a.collection,a.id);}
   case 'resolveSourceIdentity':return repo.resolveSourceIdentity((args as StorageOperations['resolveSourceIdentity']['args']).scope);
   case 'importAllocateIds':return repo.importAllocateIds(args as StorageOperations['importAllocateIds']['args'],randomUUID);
   case 'beginBlobTransfer':{const a=args as StorageOperations['beginBlobTransfer']['args'];return this.blobControl(operation,a,()=>{const transferId=randomUUID();this.stages.set(transferId,{purpose:a.purpose,state:'writing',chunks:[],offset:0,sequence:0,final:false,sha256:null});return{transferId,maxChunkBytes:1_048_576,maxInFlight:4};});}
   case 'finishBlobTransfer':{const a=args as StorageOperations['finishBlobTransfer']['args'];return this.blobControl(operation,a,()=>{const stage=this.stages.get(a.transferId)!;assert.equal(stage.state,'writing');assert.ok(stage.final);const bytes=this.join(stage);assert.equal(stage.offset,a.expectedBytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),a.expectedSha256);if(stage.purpose==='canonical_text')new TextDecoder('utf-8',{fatal:true}).decode(bytes);stage.state='verified';stage.sha256=a.expectedSha256;return{transferId:a.transferId,sha256:a.expectedSha256,byteLength:a.expectedBytes,state:'verified_staged'};});}
   case 'discardBlobTransfer':{const {transferId}=args as StorageOperations['discardBlobTransfer']['args'];return{discarded:this.readers.delete(transferId)||this.stages.delete(transferId)};}
   case 'readBlobTransfer':{const a=args as StorageOperations['readBlobTransfer']['args'];const blob=this.published.get(a.sha256);assert.ok(blob);const transferId=randomUUID();this.readers.set(transferId,{bytes:blob.bytes,offset:0,sequence:0,pending:null});this.maxReaders=Math.max(this.maxReaders,this.readers.size);return{transferId,sha256:a.sha256,byteLength:blob.bytes.length};}
   case 'sliceBlobTransfer':{const a=args as StorageOperations['sliceBlobTransfer']['args'];const parent=this.readers.get(a.transferId);assert.ok(parent);const transferId=randomUUID();this.readers.set(transferId,{bytes:parent.bytes.subarray(a.offset,a.offset+a.byteLength),offset:0,sequence:0,pending:null});this.maxReaders=Math.max(this.maxReaders,this.readers.size);return{transferId,sha256:'a'.repeat(64),byteLength:parent.bytes.length,range:{offset:a.offset,byteLength:a.byteLength}};}
   case 'commit':{const a=args as StorageOperations['commit']['args'];const previous=repo.committedTransaction(a);if(previous)return previous;this.publish(a.stagedBlobIds);return repo.commit(a);}
   case 'prepareImportBlobs':{const a=args as StorageOperations['prepareImportBlobs']['args'];const previous=repo.committedImportOperation(operation,a);if(previous)return previous;repo.recordImportBlobTransfers(a.importId,a.stagedBlobIds);this.publish(a.stagedBlobIds);return repo.completeImportBlobPreparation(a);}
   default:{const method=(repo as unknown as Record<string,(args:unknown)=>unknown>)[operation];if(typeof method!=='function')throw new Error(`Harness route absent: ${operation}`);return method.call(repo,args);}
  }
 }
 readonly client:StorageClient={
  request:async<K extends keyof StorageOperations>(requestId:string,operation:K,args:StorageOperations[K]['args']):Promise<StorageOperations[K]['result']>=>{assertStorageRequest({version:1,requestId,operation,args} as Parameters<typeof assertStorageRequest>[0]);this.requests++;this.maxRequestBytes=Math.max(this.maxRequestBytes,new TextEncoder().encode(JSON.stringify(args)).length);const result=await this.dispatch(operation,args);this.afterRequest?.(operation,args,result);return result as StorageOperations[K]['result'];},
  sendChunk:async chunk=>{const stage=this.stages.get(chunk.transferId)!;assert.equal(stage.state,'writing');assert.equal(stage.offset,chunk.offset);assert.equal(stage.sequence++,chunk.sequence);assert.ok(!stage.final);const length=chunk.bytes.length;stage.chunks.push(structuredClone(chunk.bytes,{transfer:[chunk.bytes.buffer as ArrayBuffer]}));stage.offset+=length;stage.final=chunk.final;return{transferId:chunk.transferId,sequence:chunk.sequence,committedOffset:stage.offset};},
  readChunk:async transferId=>{const reader=this.readers.get(transferId)!;assert.ok(reader);assert.equal(reader.pending,null);const bytes=reader.bytes.slice(reader.offset,reader.offset+8192);const chunk={transferId,sequence:reader.sequence++,offset:reader.offset,bytes,final:reader.offset+bytes.length===reader.bytes.length};reader.offset+=bytes.length;reader.pending=chunk;return chunk;},
  acknowledgeChunk:async ack=>{const reader=this.readers.get(ack.transferId)!;assert.equal(reader.pending?.sequence,ack.sequence);assert.equal(reader.offset,ack.committedOffset);reader.pending=null;},
  cancel:async(requestId,operationId)=>({requestId,operationId,outcome:'cancelled_before_commit'}),onProgress:()=>()=>{},onChange:()=>()=>{},close:async()=>{this.db.close();},
 };
}
