/** Fixed artifact parsing/transfer metadata only; no JavaScript tensor kernels. */
export const MODEL_SHA256='e1ef345cd35088b06f70c199f5a4e0311bda5983716ad6a3e7d0a604202efffc';
export const MODEL_BYTES=90_785_583;
export interface GpuTensor { offset:number; bytes:number; rows:number; columns:number }
export async function sha256(bytes:Uint8Array):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function verifyGpuModel(input:Uint8Array):Promise<{
  weights:Uint8Array; tensors:Map<string,GpuTensor>;
}>{
  if(input.byteLength!==MODEL_BYTES)throw new Error('Frozen model length mismatch');
  // Copy before asynchronous verification to prevent mutation of the supplied asset.
  const owned=input.slice();
  if(await sha256(owned)!==MODEL_SHA256)throw new Error('Frozen model SHA-256 mismatch');
  const view=new DataView(owned.buffer);const decode=new TextDecoder();
  const weightStart=9984,weightBytes=90_261_504;
  const tensors=new Map<string,GpuTensor>();
  for(let i=0;i<101;i++){
    const at=256+i*96;
    const name=decode.decode(owned.subarray(at,at+64)).replace(/\0.*$/s,'');
    const offset=Number(view.getBigUint64(at+64,true));
    const bytes=Number(view.getBigUint64(at+72,true));
    tensors.set(name,{offset:(offset-weightStart)/4,bytes,rows:view.getUint32(at+80,true),columns:view.getUint32(at+84,true)});
  }
  return{weights:owned.subarray(weightStart,weightStart+weightBytes),tensors};
}
