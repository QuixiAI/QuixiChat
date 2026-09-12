/** Test-only synchronization separates readback mapping/copy from pending GPU work.
 * This deliberately changes profiling synchronization, never production execution.
 */
export function observeTransfers(){
  const samples:{buffer:string;completionBeforeMapMs:number;mapAndCopyMs:number}[]=[];
  const gpu={requestAdapter:async(options?:GPURequestAdapterOptions)=>{
    const adapter=await navigator.gpu.requestAdapter(options);if(!adapter)return null;
    return new Proxy(adapter,{get(target,key){
      if(key==='requestDevice')return async(descriptor:GPUDeviceDescriptor)=>{
        const device=await target.requestDevice(descriptor);
        return new Proxy(device,{get(target,key){
          if(key==='createBuffer')return(descriptor:GPUBufferDescriptor)=>{
            const buffer=target.createBuffer(descriptor);
            if(descriptor.label==='Quixi readback'||descriptor.label==='Quixi queryReadback'){
              const map=buffer.mapAsync.bind(buffer),unmap=buffer.unmap.bind(buffer);
              let started=0,completionBeforeMapMs=0;
              Object.defineProperty(buffer,'mapAsync',{value:async(...args:Parameters<GPUBuffer['mapAsync']>)=>{
                const pending=performance.now();await device.queue.onSubmittedWorkDone();
                completionBeforeMapMs=performance.now()-pending;started=performance.now();await map(...args);
              }});
              Object.defineProperty(buffer,'unmap',{value:()=>{
                unmap();samples.push({buffer:descriptor.label!,completionBeforeMapMs,mapAndCopyMs:performance.now()-started});
              }});
            }
            return buffer;
          };
          const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
        }});
      };
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  }} as GPU;
  return{gpu,take(){return samples.splice(0);}};
}
