import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import type {BlobPurpose} from '@quixi/core/contracts';
import type {JsonObject} from '@quixi/core/model';
import {WorkCheckpoint} from './storage.ts';
import {boundedBytes} from './bytes.ts';

export interface UploadedBlob {transferId:string;sha256:string;byteLength:number}
/** A cold restart may restart only an unfinished upload. Finalization and publication always retry the original identity. */
export async function upload(work:WorkCheckpoint,slot:string,purpose:BlobPurpose,open:()=>AsyncIterable<Uint8Array>,expectedBytes:number|null):Promise<UploadedBlob>{
 const session=work.session;let state=work.data[slot] as JsonObject|undefined;
 if(state?.phase==='verified')return{transferId:String(state.transferId),sha256:String(state.sha256),byteLength:Number(state.byteLength)};
 if(state?.phase==='uploading'){
  const prior=await session.request('operationStatus',{operationId:String(state.beginOperationId)});
  if(prior.status==='committed'&&prior.result&&typeof prior.result==='object'&&!Array.isArray(prior.result)&&typeof prior.result.transferId==='string')await session.request('discardBlobTransfer',{transferId:prior.result.transferId});
  state={phase:'new',attempt:Number(state.attempt)+1};
 }
 if(!state||state.phase==='new'){
  const attempt=Number(state?.attempt??0);const [beginOperationId,finishOperationId]=await session.ids(JSON.stringify(['blob-begin',work.groupKey,work.key,slot,attempt]),JSON.stringify(['blob-finish',work.groupKey,work.key,slot,attempt]));
  state={phase:'uploading',attempt,beginOperationId:beginOperationId!,finishOperationId:finishOperationId!};await work.save({...work.data,[slot]:state});
  const transfer=await session.request('beginBlobTransfer',{operationId:beginOperationId!,purpose,expectedBytes,expectedSha256:null});
  const hash=sha256.create();let offset=0,sequence=0;
  for await(const bytes of boundedBytes(open())){session.check();const byteLength=bytes.length;hash.update(bytes);await session.runtime.storage.sendChunk({transferId:transfer.transferId,sequence:sequence++,offset,bytes,final:false});offset+=byteLength;session.runtime.onProgress?.({runId:session.run.runId,phase:'preserving',processedBytes:offset,totalBytes:expectedBytes,groups:0,messages:0,parts:0});}
  if(expectedBytes!==null&&offset!==expectedBytes)throw new Error('Source byte count changed during preservation');
  await session.runtime.storage.sendChunk({transferId:transfer.transferId,sequence,offset,bytes:new Uint8Array(),final:true});
  state={...state,phase:'finishing',transferId:transfer.transferId,sha256:bytesToHex(hash.digest()),byteLength:offset};await work.save({...work.data,[slot]:state});
 }
 if(state.phase!=='finishing')throw new Error('Unknown durable upload phase');
 const result=await session.request('finishBlobTransfer',{operationId:String(state.finishOperationId),transferId:String(state.transferId),expectedBytes:Number(state.byteLength),expectedSha256:String(state.sha256)});
 await work.save({...work.data,[slot]:{...state,phase:'verified'}});return{transferId:result.transferId,sha256:result.sha256,byteLength:result.byteLength};
}
