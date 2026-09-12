import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {jsonEvents} from './json/tokens.ts';
import type {ImportByteSource} from './types.ts';
import type {ImportSession} from './storage.ts';

export async function hashRange(source:ImportByteSource,start=0,end=source.byteLength,cancelled:()=>boolean=()=>false):Promise<string>{
 const hash=sha256.create();let count=0;
 for await(const chunk of source.open(start,end)){if(cancelled())throw new Error('Import paused while hashing');if(chunk.length>1_048_576)throw new Error('Input adapter exceeded chunk bound');hash.update(chunk);count+=chunk.length;}
 if(count!==end-start)throw new Error('Source range byte count changed');return bytesToHex(hash.digest());
}
export interface RetainedByteSource extends ImportByteSource {close():Promise<void>}
/** Keep one verified handle pinned; every parser pass consumes bounded child ranges with acknowledgments. */
export async function retainedSource(session:ImportSession,sha256:string,name:string):Promise<RetainedByteSource>{
 const anchor=await session.request('readBlobTransfer',{sha256});let closed=false;
 return{name,byteLength:anchor.byteLength,async*open(start=0,end=anchor.byteLength){
  if(closed||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>anchor.byteLength)throw new Error('Invalid retained source range');
  const range=await session.request('sliceBlobTransfer',{transferId:anchor.transferId,offset:start,byteLength:end-start});let offset=0,sequence=0;
  try{while(true){session.check();const chunk=await session.runtime.storage.readChunk(range.transferId);
    if(chunk.transferId!==range.transferId||chunk.offset!==offset||chunk.sequence!==sequence++||chunk.bytes.length>1_048_576||offset+chunk.bytes.length>end-start)throw new Error('Blob range sequence or length mismatch');
    offset+=chunk.bytes.length;
    if(chunk.bytes.length)yield chunk.bytes;
    await session.runtime.storage.acknowledgeChunk({transferId:range.transferId,sequence:chunk.sequence,committedOffset:offset});
    if(chunk.final){if(offset!==end-start)throw new Error('Retained source ended early');break;}
   }
  }finally{await session.runtime.storage.request(session.runtime.nextId(),'discardBlobTransfer',{transferId:range.transferId});}
 },async close(){if(!closed){closed=true;await session.runtime.storage.request(session.runtime.nextId(),'discardBlobTransfer',{transferId:anchor.transferId});}}};
}
/** Copy bounded views so transferring a chunk cannot detach the caller's complete File/ZIP buffer. */
export async function* boundedBytes(source:AsyncIterable<Uint8Array>):AsyncGenerator<Uint8Array>{for await(const input of source){if(input.length>1_048_576)throw new Error('Input adapter exceeded chunk bound');if(input.length)yield new Uint8Array(input);}}

/** Last-resort source fingerprint excludes mutable display metadata. It is explicitly heuristic, never a provider-native ID. */
export async function contentFingerprint(source:ImportByteSource,start:number,end:number):Promise<string>{
 const hash=sha256.create(),encoder=new TextEncoder();
 const ignored=new Set(['title','name','update_time','updated_at','current_node','is_archived','is_starred']);
 for await(const event of jsonEvents(source.open(start,end))){
  if(event.path.length&&ignored.has(String(event.path[0])))continue;
  if(event.kind==='stringChunk')hash.update(encoder.encode(event.value));
  else hash.update(encoder.encode(JSON.stringify([event.kind,event.path,event.kind==='number'?event.raw:event.kind==='boolean'?event.value:null])));
 }
 return bytesToHex(hash.digest());
}
