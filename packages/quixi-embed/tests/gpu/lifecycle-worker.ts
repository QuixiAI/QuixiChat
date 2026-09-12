import {createWebGpuEncoder,GpuBackendError,type GpuOptions} from '../../src/gpu/encoder.ts';
import {createSimdEncoder} from '../../src/simd.ts';
import type {TuningRecord} from '../../src/gpu/tuning.ts';
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
async function rejects(operation:()=>Promise<unknown>,codes:string[]){
  try{await operation();}catch(error){assert(error instanceof GpuBackendError&&codes.includes(error.code),`Unexpected rejection: ${error}`);return;}
  throw new Error(`Expected rejection ${codes}`);
}
function observe(failAllocation=0){
  const state={device:null as GPUDevice|null,created:0,destroyed:0,liveBytes:0,peakBytes:0};
  const gpu={requestAdapter:async(options?:GPURequestAdapterOptions)=>{
    const adapter=await navigator.gpu.requestAdapter(options);if(!adapter)return null;
    return new Proxy(adapter,{get(target,key){
      if(key==='requestDevice')return async(descriptor:GPUDeviceDescriptor)=>{
        const device=await target.requestDevice(descriptor);state.device=device;
        return new Proxy(device,{get(target,key){
          if(key==='createBuffer')return(descriptor:GPUBufferDescriptor)=>{
            if(failAllocation&&state.created+1===failAllocation)throw new Error('Injected bounded allocation failure');
            const buffer=target.createBuffer(descriptor);state.created++;state.liveBytes+=buffer.size;state.peakBytes=Math.max(state.peakBytes,state.liveBytes);
            const destroy=buffer.destroy.bind(buffer);let destroyed=false;
            Object.defineProperty(buffer,'destroy',{value:()=>{if(!destroyed){destroyed=true;state.destroyed++;state.liveBytes-=buffer.size;}destroy();}});
            return buffer;
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  }} as GPU;
  return{gpu,state};
}
async function main(){
  const bytes=async(path:string)=>new Uint8Array(await(await fetch(path)).arrayBuffer());
  const [model,tokenizer,wasm,simdWasm,shader,tiledShader,attentionShader,fixtures]=await Promise.all([
    bytes('/build/arctic-xs.qxmodel'),bytes('/build/arctic-xs.qxtokenizer'),bytes('/build/quixi-scalar.wasm'),bytes('/build/quixi-simd.wasm'),
    fetch('/kernels/webgpu/1.0.0/baseline.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/tiled.wgsl').then(r=>r.text()),
    fetch('/kernels/webgpu/1.0.0/attention.wgsl').then(r=>r.text()),fetch('/tests/browser-fixtures.json').then(r=>r.json())]);
  const options:GpuOptions={model,tokenizer,wasm,shader,tiledShader,attentionShader,projection:'auto',attention:'fused',maxBatch:4};
  const rejectedAdapter={requestAdapter:async()=>{throw new Error('Adapter request rejected');}} as unknown as GPU;
  await rejects(()=>createWebGpuEncoder({...options,gpu:rejectedAdapter}),['initialization']);
  await rejects(()=>createWebGpuEncoder({...options,...{subgroups:true}}),['unavailable']);
  const halfShader=await(await fetch('/kernels/webgpu/1.0.0/half.wgsl')).text();
  const noHalf={requestAdapter:async()=>({features:new Set(),info:{isFallbackAdapter:false}})} as unknown as GPU;
  await rejects(()=>createWebGpuEncoder({...options,gpu:noHalf,projection:'half',halfShader}),['unavailable']);
  const unavailable={requestAdapter:async()=>null} as unknown as GPU;
  await rejects(()=>createWebGpuEncoder({...options,gpu:unavailable}),['unavailable']);
  const software={requestAdapter:async()=>({info:{isFallbackAdapter:true}})} as unknown as GPU;
  await rejects(()=>createWebGpuEncoder({...options,gpu:software}),['unavailable']);
  await rejects(()=>createWebGpuEncoder({...options,shader:shader+' '}),['initialization']);
  const limit=observe();await rejects(()=>createWebGpuEncoder({...options,gpu:limit.gpu,memoryBudgetBytes:1}),['limits']);assert(limit.state.created===0,'Budget allocated buffers');
  const failed=observe(3);await rejects(()=>createWebGpuEncoder({...options,gpu:failed.gpu}),['initialization']);assert(failed.state.liveBytes===0,'Failed initialization leaked buffers');
  const cache=new Map<string,TuningRecord>(),cacheApi={get:async(key:string)=>cache.get(key),set:async(key:string,value:TuningRecord)=>{cache.set(key,value);}};
  const measured=observe();let notifications=0;
  const encoder=await createWebGpuEncoder({...options,gpu:measured.gpu,tuningCache:cacheApi,onUnavailable:()=>{notifications++;throw new Error('Observer exceptions must be contained');}});
  const initial=encoder.diagnostics(),created=measured.state.created;
  assert(!('capture' in encoder),'Diagnostic entry leaked into production API');
  assert(initial.tuning&&!initial.tuning.cacheHit,'Autotuning did not execute');
  const sample=fixtures.fixtures[0];
  const first=encoder.embedDocument(sample.text);
  await rejects(()=>encoder.embedDocument('busy'),['busy']);
  const vector=await first;
  assert(vector.every((value,i)=>Math.abs(value-sample.vector[i])<8e-5),'Production vector mismatch');
  for(let i=0;i<500;i++){
    const output=await encoder.embedDocument(i%2?'Hello world':'Good morning');
    assert(output.length===384&&output.every(Number.isFinite),'Repeated inference failed');
    assert(measured.state.created===created&&measured.state.liveBytes===initial.memory.allocatedBytes,'Steady GPU allocation changed');
  }
  const pending=encoder.embedDocument(Array(510).fill('token').join(' '));
  measured.state.device!.destroy();
  await rejects(()=>pending,['lost','execution']);
  await rejects(()=>encoder.embedDocument('after loss'),['lost','execution']);
  assert(notifications===1,'Loss notification count');assert(measured.state.liveBytes===0,'Loss leaked GPU buffers');
  encoder.dispose();encoder.dispose();
  const cached=await createWebGpuEncoder({...options,tuningCache:cacheApi});
  const cachedDiagnostics=cached.diagnostics();assert(cachedDiagnostics.tuning?.cacheHit,'Persisted tuning record was not reused');
  const disposing=cached.embedDocument('dispose pending');cached.dispose();
  await rejects(()=>disposing,['disposed','execution','lost']);
  const cpu=await createSimdEncoder({model,wasm:simdWasm});
  try{const fallback=cpu.embedDocument(sample.text);assert(fallback.every((value,i)=>Math.abs(value-sample.vector[i])<2e-5),'CPU fallback failed');}finally{cpu.dispose();}
  return{passed:true,scope:'Real GPU buffers and device.destroy loss; bounded allocation failure is injected. Scheduler requeue is separate.',
    initial,cachedTuning:cachedDiagnostics.tuning,completedJobs:500,observed:{created:measured.state.created,destroyed:measured.state.destroyed,peakBytes:measured.state.peakBytes,liveBytes:measured.state.liveBytes},notifications,
    adapterRejectionTyped:true,unapprovedSubgroupsRejected:true,missingHalfFeatureRejected:true,unavailableAndSoftwareRejected:true,allocationFailureCleaned:true,corruptShaderRejected:true,busyRejected:true,pendingLossRejected:true,pendingDisposalRejected:true,simdFallbackVerified:true};
}
self.onmessage=()=>{void main().then(result=>self.postMessage(result),error=>self.postMessage({passed:false,error:String(error),stack:error.stack}));};
