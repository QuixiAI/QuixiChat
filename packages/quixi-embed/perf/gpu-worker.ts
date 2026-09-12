import {createGpuEncoderInternal,createWebGpuEncoder,type WebGpuEncoder} from '../src/gpu/encoder.ts';
const median=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);return(sorted[14]!+sorted[15]!)/2;};
const p95=(values:number[])=>values.slice().sort((a,b)=>a-b)[28]!;
async function main(data:{anchors?:boolean;half?:boolean;subgroups?:boolean;attention?:boolean;auto?:boolean;finalhalf?:boolean}){
  if(data.anchors)return (await import('./gpu-anchors-worker.ts')).runAnchors();
  const variants:{id:string;projection:'baseline'|'tiled'|'half'|'auto';subgroups?:boolean;attention?:'baseline'|'fused'}[]=
    data.auto?[{id:'baseline',projection:'baseline'},{id:'auto-fused',projection:'auto',attention:'fused'}]:
    data.finalhalf?[{id:'auto-fused',projection:'auto',attention:'fused'},{id:'half-fused',projection:'half',attention:'fused'}]:
    data.half?[{id:'tiled',projection:'tiled'},{id:'half',projection:'half'}]:
    data.subgroups?[{id:'tiled',projection:'tiled'},{id:'subgroups',projection:'tiled',subgroups:true}]:
    data.attention?[{id:'tiled',projection:'tiled'},{id:'fused',projection:'tiled',attention:'fused'}]:
    [{id:'baseline',projection:'baseline'},{id:'tiled',projection:'tiled'}];
  const routes=variants.map(variant=>variant.id);
  const referenceRoute=routes[0]!,candidateRoute=routes[1]!;
  const bytes=async(path:string)=>new Uint8Array(await(await fetch(path)).arrayBuffer());
  const [model,tokenizer,wasm,shader,tiledShader,halfShader,subgroupShader,attentionShader]=await Promise.all([bytes('/build/arctic-xs.qxmodel'),
    bytes('/build/arctic-xs.qxtokenizer'),bytes('/build/quixi-scalar.wasm'),fetch('/kernels/webgpu/1.0.0/baseline.wgsl').then(r=>r.text()),
    fetch('/kernels/webgpu/1.0.0/tiled.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/half.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/subgroups.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/attention.wgsl').then(r=>r.text())]);
  const encoders:Record<string,WebGpuEncoder>={},loadMs:Record<string,number>={};
  try{
    for(const variant of variants){const start=performance.now();
      encoders[variant.id]=await(variant.subgroups?createGpuEncoderInternal:createWebGpuEncoder)({model,tokenizer,wasm,shader,tiledShader,halfShader,subgroupShader,attentionShader,...variant,maxBatch:32,memoryBudgetBytes:2*1024*1024*1024});
      loadMs[variant.id]=performance.now()-start;}
    const report={status:'running',passed:false,protocol:{warmups:5,samples:30,alternating:true,interop:'C tokenizer, input transfer, complete GPU graph and final readback; no profiling passes'},
      environment:{userAgent:navigator.userAgent,loadMs,routes,encoders:Object.fromEntries(Object.entries(encoders).map(([route,encoder])=>[route,encoder.diagnostics()]))},shapes:[] as unknown[]};
    for(const tokens of [32,128,512])for(const batch of [1,4,8,16,32]){
      const texts=Array.from({length:batch},(_,i)=>Array(tokens-2).fill(['token','hello','world','model'][i%4]).join(' '));
      if(texts.some(text=>encoders[referenceRoute]!.tokenize(text).length!==tokens))throw new Error('Benchmark token shape');
      const memory=Object.fromEntries(Object.entries(encoders).map(([key,encoder])=>[key,JSON.stringify(encoder.diagnostics().memory)]));
      const reference=await encoders[referenceRoute]!.embedDocuments(texts);let maxError=0;
      const samples:Record<string,number[]>=Object.fromEntries(routes.map(route=>[route,[]])),interop:Record<string,unknown[]>=Object.fromEntries(routes.map(route=>[route,[]]));
      for(let i=-5;i<30;i++)for(const route of i%2===0?routes:routes.slice().reverse()){
        const start=performance.now();const output=await encoders[route]!.embedDocuments(texts);const elapsed=performance.now()-start;
        if(i>=0){samples[route]!.push(elapsed);interop[route]!.push(encoders[route]!.lastTimings());}
        for(let row=0;row<batch;row++)for(let col=0;col<384;col++){
          const error=Math.abs(output[row]![col]!-reference[row]![col]!);maxError=Math.max(maxError,error);
          if(!Number.isFinite(output[row]![col]!)||error>(data.half||data.finalhalf?3e-3:8e-5))throw new Error('Benchmark numerical gate');}
        if(JSON.stringify(encoders[route]!.diagnostics().memory)!==memory[route])throw new Error('GPU allocation grew');
      }
      const metrics=Object.fromEntries(Object.entries(samples).map(([route,values])=>[route,{medianMs:median(values),p95Ms:p95(values),chunksPerSecond:batch*1000/median(values),tokensPerSecond:tokens*batch*1000/median(values)}]));
      report.shapes.push({batch,tokens,maxError,samples,interop,metrics,speedup:metrics[referenceRoute]!.medianMs/metrics[candidateRoute]!.medianMs});
      self.postMessage({progress:report});
    }
    report.status='passed';report.passed=true;return report;
  }finally{Object.values(encoders).forEach(encoder=>encoder.dispose());}
}
self.onmessage=({data})=>{void main(data).then(result=>self.postMessage({result}),error=>self.postMessage({result:{status:'failed',passed:false,error:String(error),stack:error.stack}}));};
