import {benchmark} from './benchmark.ts';
self.onmessage = async ({data}) => {
  try {
    Object.defineProperty(navigator,'gpu',{value:undefined,configurable:true});
    const start=performance.now();
    const load=async (name:string)=>new Uint8Array(await (await fetch(`/build/${name}`)).arrayBuffer());
    const scalar=await load('quixi-scalar.wasm'),simd=await load('quixi-simd.wasm'),model=await load('arctic-xs.qxmodel');
    const assets={asset_fetch_ms:performance.now()-start};
    const result=await benchmark({scalar,simd,model,lengths:data.short?[32]:undefined,
      progress:value=>self.postMessage({kind:'progress',value:{...value as object,...assets}})});
    self.postMessage({kind:'complete',value:{...result,...assets,webgpu_disabled:true}});
  } catch(error) {self.postMessage({kind:'complete',value:{status:'failed',error:String(error)}});}
};
