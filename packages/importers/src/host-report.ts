import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {HostClient} from '@quixi/core/contracts';
import type {ImportRuntime} from './types.ts';
import {exportImportReport} from './report.ts';
/** Stage a bounded stream for a separate user-gesture save action. The host's declared staging budget still applies. */
export async function prepareImportReport(runtime:ImportRuntime,host:HostClient,runId:string):Promise<{transferId:string;byteLength:number;sha256:string}>{
 const transfer=await host.beginTransfer(runtime.nextId(),{purpose:'file_save',expectedBytes:null,expectedSha256:null});let bytes=0,sequence=0;const hash=sha256.create();
 try{for await(const chunk of exportImportReport(runtime,{runId})){for(let offset=0;offset<chunk.length;offset+=transfer.maxChunkBytes){const copy=new Uint8Array(chunk.subarray(offset,offset+transfer.maxChunkBytes)),size=copy.length;hash.update(copy);await host.writeChunk({transferId:transfer.transferId,sequence:sequence++,offset:bytes,bytes:copy,final:false});bytes+=size;}}
  await host.writeChunk({transferId:transfer.transferId,sequence,offset:bytes,bytes:new Uint8Array(),final:true});const digest=bytesToHex(hash.digest());await host.finishTransfer(runtime.nextId(),transfer.transferId,{byteLength:bytes,sha256:digest});return{transferId:transfer.transferId,byteLength:bytes,sha256:digest};
 }catch(error){try{await host.releaseTransfer(runtime.nextId(),transfer.transferId);}catch{/* The host also releases its session's transfers on disposal. */}throw error;}
}
