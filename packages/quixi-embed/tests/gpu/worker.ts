import {createWebGpuEncoder} from '../../src/gpu/encoder.ts';
async function main(){
  const bytes=async(path:string)=>new Uint8Array(await(await fetch(path)).arrayBuffer());
  const [model,tokenizer,wasm,shader,fixtures]=await Promise.all([
    bytes('/build/arctic-xs.qxmodel'),bytes('/build/arctic-xs.qxtokenizer'),bytes('/build/quixi-scalar.wasm'),
    fetch('/kernels/webgpu/1.0.0/baseline.wgsl').then(r=>r.text()),fetch('/tests/browser-fixtures.json').then(r=>r.json())]);
  const encoder=await createWebGpuEncoder({model,tokenizer,wasm,shader,maxBatch:8});
  try{
    const results=[];
    for(const test of fixtures.fixtures){
      const vector=test.role==='query'?await encoder.embedQuery(test.text):await encoder.embedDocument(test.text);
      let maxError=0;for(let i=0;i<384;i++)maxError=Math.max(maxError,Math.abs(vector[i]-test.vector[i]));
      if(maxError>8e-5)throw new Error(`Vector ${test.id}: ${maxError}`);
      results.push({name:test.id,maxError,timing:encoder.lastTimings()});
    }
    return{passed:true,diagnostics:encoder.diagnostics(),results};
  }finally{encoder.dispose();}
}
self.onmessage=()=>{void main().then(result=>self.postMessage(result),error=>self.postMessage({passed:false,error:String(error),stack:error.stack}));};
