import {createScalarEncoder,createSimdEncoder,createArcticTokenizer,createWebGpuEncoder,GpuBackendError,
  createSchedulerWithFallback,cpuSchedulerExecutor,gpuSchedulerExecutor,type EmbeddingScheduler,
  type SchedulerExecutor,type EmbeddingRole} from '../../src/index.ts';
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const delay=()=>new Promise(resolve=>setTimeout(resolve,0));
let scheduler:EmbeddingScheduler|undefined,sequence=0,queryAccepted=0,scenario=false,requestedQuery=false;
let resolveQuery:(()=>void)|undefined,rejectQuery:((error:unknown)=>void)|undefined;
let queryFixture:{text:string;vector:number[]};
const executions:{sequence:number;route:string;role:EmbeddingRole;batch:number;tokens:number[];durationMs?:number}[]=[];
async function main(data:{route:'scalar'|'simd'|'gpu'|'half';loss?:boolean}){
  const bytes=async(path:string)=>new Uint8Array(await(await fetch(path)).arrayBuffer());
  const [model,tokenizerBytes,scalarWasm,simdWasm,fixtures,preflightFixtures]=await Promise.all([
    bytes('/build/arctic-xs.qxmodel'),bytes('/build/arctic-xs.qxtokenizer'),bytes('/build/quixi-scalar.wasm'),bytes('/build/quixi-simd.wasm'),
    fetch('/tests/browser-fixtures.json').then(r=>r.json()),fetch('/tests/token-preflight-fixtures.json').then(r=>r.json())]);
  const tokenizer=await createArcticTokenizer({wasm:scalarWasm,tokenizer:tokenizerBytes});
  const preflight=(text:string,role:EmbeddingRole)=>tokenizer.inspect(text,role);
  const identity={modelHash:'ee789e0b1d6ecbbd5ce37b474af556cc1a1319cee4417d9e3b11f82e90300706',
    artifactHash:'e1ef345cd35088b06f70c199f5a4e0311bda5983716ad6a3e7d0a604202efffc',
    tokenizerVersion:'d15cd90acf9df73913b5c7f8af9ddc7c2d8afee8e4777f6f71e6d1bb4875c8db',
    preprocessingVersion:'arctic-query-prefix-v1',chunkingVersion:'scheduler-fixtures-v1',queryPrefix:preflightFixtures.query_prefix};
  let gpuDevice:GPUDevice|undefined,gpuEncoder:Awaited<ReturnType<typeof createWebGpuEncoder>>|undefined,lossTriggered=false;
  const observedGpu={requestAdapter:async(options?:GPURequestAdapterOptions)=>{
    const adapter=await navigator.gpu?.requestAdapter(options);if(!adapter)return null;
    return new Proxy(adapter,{get(target,key){if(key==='requestDevice')return async(descriptor:GPUDeviceDescriptor)=>{gpuDevice=await target.requestDevice(descriptor);return gpuDevice;};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
  }} as GPU;
  function observe(base:SchedulerExecutor):SchedulerExecutor{
    return{...base,async execute(texts,role){
      const entry={sequence:++sequence,route:base.route,role,batch:texts.length,tokens:texts.map(text=>preflight(text,role).tokenCount),durationMs:0};
      if(scenario){executions.push(entry);if(!requestedQuery){requestedQuery=true;self.postMessage({phase:'first-dispatch'});}}
      if(scenario&&data.loss&&base.kind==='gpu'&&!lossTriggered){
        setTimeout(()=>{assert(gpuEncoder?.diagnostics().state==='busy','Loss test must target active GPU work');lossTriggered=true;gpuDevice!.destroy();},0);
      }
      const start=performance.now();try{return await base.execute(texts,role);}finally{entry.durationMs=performance.now()-start;}
    }};
  }
  const createCpu=async()=>observe(cpuSchedulerExecutor(await(data.route==='scalar'?createScalarEncoder:createSimdEncoder)({model,wasm:data.route==='scalar'?scalarWasm:simdWasm})));
  const createGpu=async()=>{
    const [shader,tiledShader,halfShader,attentionShader]=await Promise.all(['baseline','tiled','half','attention'].map(name=>fetch(`/kernels/webgpu/1.0.0/${name}.wgsl`).then(r=>r.text())));
    gpuEncoder=await createWebGpuEncoder({model,tokenizer:tokenizerBytes,wasm:scalarWasm,shader:shader!,tiledShader:tiledShader!,halfShader:halfShader!,attentionShader:attentionShader!,
      projection:data.route==='half'?'half':'auto',attention:'fused',maxBatch:4,gpu:observedGpu});
    return observe(gpuSchedulerExecutor({encoder:gpuEncoder,preflight}));
  };
  try{
    const started=performance.now();
    const initialized=await createSchedulerWithFallback({identity,preflight,createCpu,
      ...(data.route==='gpu'||data.route==='half'?{createGpu}:{createGpu:async()=>{throw new GpuBackendError('unavailable','Intentional unavailable-adapter initialization check');}})});
    scheduler=initialized.scheduler;
    if(data.route==='gpu'||data.route==='half')assert(!initialized.initialGpuError,'Real GPU adapter required for GPU integration');
    const initializationMs=performance.now()-started,initialBackend=scheduler.statistics().route,gpuDiagnostics=gpuEncoder?.diagnostics();
    if(gpuDiagnostics){
      assert(gpuDiagnostics.adapter.isFallbackAdapter===false,'Hardware scheduler gate rejects fallback adapters');
      assert(!/swiftshader|llvmpipe|software/i.test(JSON.stringify(gpuDiagnostics.adapter)),'Hardware scheduler gate rejects software adapters');
    }
    for(const fixture of preflightFixtures.cases){
      const actual=preflight(fixture.text,fixture.role);
      assert(actual.tokenCount===fixture.tokenCount&&actual.overflow===fixture.overflow&&actual.inputSha256===fixture.inputSha256,'Independent strict preflight mismatch');
    }
    const valid=fixtures.fixtures.filter((f:any)=>f.text.length<128&&!preflight(f.text,f.role).overflow);
    queryFixture=valid.find((f:any)=>f.role==='query');assert(queryFixture,'Missing query golden');
    const limit=data.route==='half'?3e-3:data.route==='gpu'?8e-5:2e-5;
    for(const fixture of valid){
      const result=await scheduler.submit({text:fixture.text,role:fixture.role}).result;
      assert(result.vector.every((value,i)=>Math.abs(value-fixture.vector[i])<=limit),'Scheduled frozen vector mismatch');
    }
    const document=valid.find((f:any)=>f.role==='document');scheduler.clearCache();
    const before=scheduler.statistics(),abort=new AbortController();
    const cancelled=scheduler.submit({text:document.text,role:'document',priority:4,signal:abort.signal});cancelled.result.catch(()=>{});
    const duplicates=Array.from({length:31},()=>scheduler!.submit({text:document.text,role:'document',priority:4}));abort.abort();
    const values=await Promise.all(duplicates.map(ticket=>ticket.result));
    try{await cancelled.result;throw new Error('Cancelled consumer resolved');}catch(error){assert((error as {code?:string}).code==='cancelled','Wrong cancellation outcome');}
    assert(scheduler.statistics().inferred-before.inferred===1,'Duplicates executed more than once');assert(values[0]!.vector!==values[1]!.vector,'Consumer vectors alias');
    const exact=preflight(Array(510).fill('token').join(' '),'document');assert(exact.tokenCount===512&&!exact.overflow,'Exact512 preflight rejected');
    await scheduler.submit({text:Array(511).fill('token').join(' '),role:'document'}).result.then(()=>{throw new Error('Overflow was silently truncated');},error=>assert(error.code==='oversized','Wrong overflow error'));
    scheduler.clearCache();scenario=true;
    const queryDone=new Promise<void>((resolve,reject)=>{resolveQuery=resolve;rejectQuery=reject;});
    const count=data.route==='gpu'||data.route==='half'?8:3;
    const words=['token','hello','world','model','query','document','search','memory'];
    const texts=Array.from({length:count},(_,i)=>[...Array(509).fill('token'),words[i]!].join(' '));
    for(const text of texts)assert(preflight(text,'document').tokenCount===512,'Background token shape');
    const background=texts.map(text=>scheduler!.submit({text,role:'document',priority:4}));
    await Promise.all([...background.map(ticket=>ticket.result),queryDone]);await scheduler.drain();
    const next=executions.find(execution=>execution.sequence>queryAccepted);
    assert(queryAccepted>0&&next?.role==='query'&&next.batch===1,'P0 did not execute at the next eligible boundary');
    assert(executions.every(execution=>execution.batch*(Math.max(...execution.tokens))<=2048),'Padded token budget exceeded');
    if(data.loss){assert(lossTriggered&&scheduler.statistics().fallbacks===1,'Device-loss fallback did not execute');assert(scheduler.statistics().route==='wasm-simd-fp32','Loss did not select SIMD');}
    const final=scheduler.statistics(),memory=gpuEncoder?.diagnostics().memory;await scheduler.shutdown();
    return{passed:true,route:data.route,loss:data.loss===true,initializationMs,initialBackend,initialUnavailableFallback:!!initialized.initialGpuError,
      preflightCases:preflightFixtures.cases.length,frozenCases:valid.length,duplicates:32,oneCancelledJoiner:true,exact512Accepted:true,overflowRejected:true,
      queryAcceptedSequence:queryAccepted,executions,final,gpuDiagnostics,memory,
      conditions:'Shared development host; real worker message arrives during active execution. Sequence assertions use receipt order, not cross-thread clock assumptions.',
      persistence:'Injected cache/checkpoint owner is separate; these counts are inference completions only.'};
  }finally{await scheduler?.shutdown();tokenizer.dispose();}
}
self.onmessage=({data})=>{
  if(data.kind==='interactive'){
    queryAccepted=++sequence;
    void scheduler!.submit({text:queryFixture.text,role:'query',priority:0}).result.then(result=>{
      assert(result.vector.every((value,i)=>Math.abs(value-queryFixture.vector[i]!)<3e-3),'Interactive vector mismatch');resolveQuery?.();
    }).catch(error=>rejectQuery?.(error));return;
  }
  void main(data).then(result=>self.postMessage({result}),error=>self.postMessage({result:{passed:false,error:String(error),stack:error.stack}}));
};
