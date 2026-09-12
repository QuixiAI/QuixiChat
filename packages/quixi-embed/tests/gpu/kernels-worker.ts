import {sha256} from '../../src/gpu/model.ts';
async function main(data:{tiled?:boolean;half?:boolean;subgroups?:boolean}){
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter||adapter.info.isFallbackAdapter)throw new Error('Real hardware adapter required');
  const device=await adapter.requestDevice({requiredFeatures:[...(data.half?['shader-f16']:[]),...(data.subgroups?['subgroups']:[])] as GPUFeatureName[]});
  let source=await(await fetch('/kernels/webgpu/1.0.0/baseline.wgsl')).text();
  source+='\n'+await(await fetch('/kernels/webgpu/1.0.0/attention.wgsl')).text();
  if(data.tiled)source+='\n'+await(await fetch('/kernels/webgpu/1.0.0/tiled.wgsl')).text();
  if(data.half)source='enable f16;\n'+source+'\n'+await(await fetch('/kernels/webgpu/1.0.0/half.wgsl')).text();
  if(data.subgroups)source='enable subgroups;\n'+source+'\n'+await(await fetch('/kernels/webgpu/1.0.0/subgroups.wgsl')).text();
  const manifest=await(await fetch('/build/gpu-kernel-fixtures/manifest.json')).json();
  const module=device.createShaderModule({code:source});
  const pipelines=new Map<string,GPUComputePipeline>(),results=[];
  try{for(const test of manifest.cases){
    const raw=new Uint8Array(await(await fetch('/build/gpu-kernel-fixtures/'+test.file)).arrayBuffer());
    if(await sha256(raw)!==test.sha256)throw new Error('Fixture integrity failure');
    const kernel=test.kernel==='linear'?(data.half?'linear_half':data.tiled?'linear_tiled':'linear'):test.kernel==='norm'&&data.subgroups?'norm_subgroup':test.kernel;
    let pipeline=pipelines.get(kernel);
    if(!pipeline){pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:kernel}});pipelines.set(kernel,pipeline);}
    const buffers:GPUBuffer[]=[];
    device.pushErrorScope('validation');
    try{
      const allocate=(size:number,usage:number)=>{const b=device.createBuffer({size,usage});buffers.push(b);return b;};
      const entries:GPUBindGroupEntry[]=[];
      for(const [slot,layout] of Object.entries(test.layout) as [string,any][]){
        if(slot==='expected')continue;
        const b=allocate(layout.bytes,128|8|4);device.queue.writeBuffer(b,0,raw.subarray(layout.offset,layout.offset+layout.bytes));
        entries.push({binding:Number(slot),resource:{buffer:b}});
      }
      const expectedLayout=test.layout.expected;
      const expected=new Float32Array(raw.buffer,expectedLayout.offset,expectedLayout.bytes/4);
      let output=entries.find(e=>e.binding===4)?.resource as GPUBufferBinding|undefined;
      if(!output){output={buffer:allocate(expected.byteLength,128|8|4)};entries.push({binding:4,resource:output});}
      const params=allocate(32,64|8);device.queue.writeBuffer(params,0,new Uint32Array(test.params));entries.push({binding:7,resource:{buffer:params}});
      const readback=allocate(expected.byteLength,1|8);
      if(kernel==='linear_half'){
        const weights=(entries.find(entry=>entry.binding===0)!.resource as GPUBufferBinding).buffer;
        const half=allocate(weights.size/2,128|8|4);entries.push({binding:8,resource:{buffer:half}});
        const packing=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'pack_weights'}});
        const group=device.createBindGroup({layout:packing.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:weights}},{binding:8,resource:{buffer:half}}]});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(packing);pass.setBindGroup(0,group);
        pass.dispatchWorkgroups(Math.ceil(weights.size/4/64));pass.end();device.queue.submit([encoder.finish()]);
      }
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries});
      const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);if(kernel==='linear_tiled'||kernel==='linear_half')pass.dispatchWorkgroups(Math.ceil(test.params[3]/16),Math.ceil(test.params[0]*test.params[1]/16));
      else pass.dispatchWorkgroups(...test.dispatch as [number,number?,number?]);pass.end();
      encoder.copyBufferToBuffer(output.buffer,0,readback,0,expected.byteLength);device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);const actual=new Float32Array(readback.getMappedRange());
      const error=await device.popErrorScope();if(error)throw new Error(error.message);
      let maxError=0;
      for(let i=0;i<expected.length;i++){
        const delta=Math.abs(expected[i]-actual[i]);maxError=Math.max(maxError,delta);
        if(!Number.isFinite(expected[i])||!Number.isFinite(actual[i])||delta>(kernel==='linear_half'?0.03+0.02*Math.abs(expected[i]):3e-4+3e-4*Math.abs(expected[i])))throw new Error(`${test.name}[${i}]: ${actual[i]} != ${expected[i]}`);
      }
      results.push({name:test.name,kernel,elements:expected.length,maxError});readback.unmap();
    }finally{for(const b of buffers)b.destroy();}
  }}finally{device.destroy();}
  return{passed:true,variants:data,fixtureManifestSha256:await sha256(new TextEncoder().encode(JSON.stringify(manifest))),shaderSha256:await sha256(new TextEncoder().encode(source)),adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,isFallbackAdapter:adapter.info.isFallbackAdapter},results};
}
self.onmessage=({data})=>{void main(data).then(result=>self.postMessage(result),error=>self.postMessage({passed:false,error:String(error),stack:error.stack}));};
