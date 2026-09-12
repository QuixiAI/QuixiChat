import {createWebGpuEncoder} from '../src/gpu/encoder.ts';
import {createSimdEncoder} from '../src/simd.ts';
/** Paired B1 anchors against actual WASM SIMD, with the same input and worker. */
export async function runAnchors(){
  const bytes=async(path:string)=>new Uint8Array(await(await fetch(path)).arrayBuffer());
  const [model,tokenizer,wasm,simdWasm,shader,tiledShader,attentionShader]=await Promise.all([
    bytes('/build/arctic-xs.qxmodel'),bytes('/build/arctic-xs.qxtokenizer'),bytes('/build/quixi-scalar.wasm'),bytes('/build/quixi-simd.wasm'),
    fetch('/kernels/webgpu/1.0.0/baseline.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/tiled.wgsl').then(r=>r.text()),fetch('/kernels/webgpu/1.0.0/attention.wgsl').then(r=>r.text())]);
  const cpu=await createSimdEncoder({model,wasm:simdWasm});
  let gpu:Awaited<ReturnType<typeof createWebGpuEncoder>>|undefined;
  try{
    gpu=await createWebGpuEncoder({model,tokenizer,wasm,shader,tiledShader,attentionShader,projection:'auto',attention:'fused',maxBatch:1});
    const initialCpu=JSON.stringify(cpu.memory()),initialGpu=JSON.stringify(gpu.diagnostics().memory);
    const routes=['simd','gpu'] as const;
    const report={status:'running',passed:false,protocol:{warmups:5,samples:30,alternating:true,scope:'B1 CPU/GPU anchors; complete public API work, comparisons outside clock'},environment:{userAgent:navigator.userAgent,cpu:cpu.memory(),gpu:gpu.diagnostics()},shapes:[] as unknown[]};
    for(const tokens of [32,128,512]){
      const text=Array(tokens-2).fill('token').join(' ');const expected=cpu.embedDocument(text);let maxError=0;
      const samples:Record<typeof routes[number],number[]>={simd:[],gpu:[]};const interop=[];
      for(let i=-5;i<30;i++)for(const route of i%2===0?routes:[...routes].reverse()){
        const start=performance.now();const vector=route==='simd'?cpu.embedDocument(text):await gpu.embedDocument(text);const elapsed=performance.now()-start;
        if(i>=0){samples[route].push(elapsed);if(route==='gpu')interop.push(gpu.lastTimings());}
        for(let j=0;j<384;j++){const error=Math.abs(expected[j]!-vector[j]!);maxError=Math.max(maxError,error);if(!Number.isFinite(vector[j])||error>8e-5)throw Error('GPU/SIMD anchor parity');}
        if(initialCpu!==JSON.stringify(cpu.memory())||initialGpu!==JSON.stringify(gpu.diagnostics().memory))throw Error('Anchor allocation grew');
      }
      const metrics=Object.fromEntries(Object.entries(samples).map(([route,values])=>{const sorted=values.slice().sort((a,b)=>a-b);return[route,{medianMs:(sorted[14]!+sorted[15]!)/2,p95Ms:sorted[28]!}];}));
      report.shapes.push({batch:1,tokens,maxError,samples,interop,metrics,speedup:metrics.simd!.medianMs/metrics.gpu!.medianMs});self.postMessage({progress:report});
    }
    report.status='passed';report.passed=true;return report;
  }finally{gpu?.dispose();cpu.dispose();}
}
