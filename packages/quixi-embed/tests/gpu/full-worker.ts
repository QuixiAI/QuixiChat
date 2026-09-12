import {createGpuEncoderInternal,createWebGpuEncoder,type WebGpuEncoder,type GpuDiagnosticEncoder} from '../../src/gpu/encoder.ts';
import {observeTransfers} from './observe-transfers.ts';
let observer:ReturnType<typeof observeTransfers>|undefined;
let encoder:WebGpuEncoder;
async function request(data:any){
  if(data.method==='initialize'){
    const bytes=async(path:string)=>new Uint8Array(await(await fetch(path)).arrayBuffer());
    const [model,tokenizer,wasm,shader,tiledShader,halfShader,subgroupShader,attentionShader]=await Promise.all([bytes('/build/arctic-xs.qxmodel'),
      bytes('/build/arctic-xs.qxtokenizer'),bytes('/build/quixi-scalar.wasm'),
      fetch('/kernels/webgpu/1.0.0/baseline.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/tiled.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/half.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/subgroups.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/attention.wgsl').then(r=>r.text())]);
    observer=data.observeTransfers?observeTransfers():undefined;
    const options={...(observer?{gpu:observer.gpu}:{}),model,tokenizer,wasm,shader,tiledShader,halfShader,subgroupShader,attentionShader,attention:data.attention??'baseline',subgroups:data.subgroups===true,projection:data.projection??'baseline',maxBatch:data.maxBatch??32,profile:data.profile===true,memoryBudgetBytes:2*1024*1024*1024,diagnostic:data.diagnostic!==false};
    encoder=await(data.diagnostic===false&&!data.subgroups?createWebGpuEncoder(options):createGpuEncoderInternal(options));
    return{diagnostics:encoder.diagnostics()};
  }
  if(data.method==='dispose'){encoder.dispose();return{disposed:true};}
  if(data.method==='embed'){
    const values=data.role==='query'?[await encoder.embedQuery(data.texts[0])]:await encoder.embedDocuments(data.texts);
    const bytes=new Float32Array(values.length*384);values.forEach((value:Float32Array,i:number)=>bytes.set(value,i*384));
    return{bytes:bytes.buffer,diagnostics:encoder.diagnostics(),timing:encoder.lastTimings(),transferObservation:observer?.take()};
  }
  const test=data.test;
  const {ids,mask,tokens,capture}=await (encoder as GpuDiagnosticEncoder).capture(test.texts,test.role,test.stages);
  const arrays:Record<string,Uint32Array|Float32Array>={input_ids:ids,attention_mask:mask,
    token_type_ids:new Uint32Array(ids.length),pooled:capture.pooled,vectors:capture.vectors};
  if(test.stages)capture.stages.forEach((array,i)=>arrays[`stage_${i}`]=array);
  const bytes=new Uint8Array(Object.values(arrays).reduce((sum,array)=>sum+array.byteLength,0));
  const metadata:Record<string,unknown>={};let offset=0;
  for(const [name,array] of Object.entries(arrays)){
    bytes.set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength),offset);
    metadata[name]={offset,bytes:array.byteLength,dtype:array instanceof Uint32Array?'uint32':'float32',shape:test.arrays[name].shape};
    offset+=array.byteLength;
  }
  if(test.arrays.input_ids.shape[1]!==tokens)throw new Error('Token shape differs');
  return{bytes:bytes.buffer,metadata,timing:encoder.lastTimings(),transferObservation:observer?.take()};
}
self.onmessage=({data})=>{void request(data).then(result=>self.postMessage(result),error=>self.postMessage({error:String(error),stack:error.stack}));};
