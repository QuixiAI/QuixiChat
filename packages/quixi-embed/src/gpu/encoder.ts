import { createArcticTokenizer, type ArcticTokenizer } from '../tokenizer.ts';
import type { EmbeddingRole } from '../scalar.ts';
import { verifyGpuModel, MODEL_SHA256, sha256 } from './model.ts';
import {KERNEL_HASHES,RUNTIME_SOURCE_SHA256} from './identity.ts';
import {tuneProjections,tuningKey,tuningBucket,type TuningCache,type TuningRecord,type ProjectionVariant} from './tuning.ts';

export type GpuFailureCode='unavailable'|'limits'|'initialization'|'lost'|'execution'|'busy'|'disposed';
export class GpuBackendError extends Error {
  readonly fallback='wasm-simd-fp32';
  readonly code:GpuFailureCode;
  constructor(code:GpuFailureCode,message:string){super(message);this.code=code;this.name='GpuBackendError';}
}
export interface GpuDiagnostics {
  backend:'webgpu-fp32'|'webgpu-fp16';projection:'baseline'|'tiled'|'half'|'auto';tuning:{record:TuningRecord;cacheHit:boolean}|null;subgroups:boolean;attention:'baseline'|'fused';modelSha256:string;kernelVersion:string;
  adapter:{vendor:string;architecture:string;device:string;description:string;isFallbackAdapter:boolean};
  features:string[];enabledFeatures:string[];limits:Record<string,number>;
  capacity:{batch:number;tokens:number};
  memory:{weightsBytes:number;scratchBytes:number;allocatedBytes:number;bufferCount:number};
  state:'ready'|'busy'|'lost'|'failed'|'disposed';
}
export interface GpuTimings { tokenizationMs:number;inputUploadMs:number;dispatchMs:number;completionReadbackMs:number;totalMs:number;gpuKernelMs:Record<string,number>|null }
export interface WebGpuEncoder {
  readonly backend:'webgpu-fp32'|'webgpu-fp16';
  tokenize(text:string,role?:EmbeddingRole):Uint32Array;
  embedQuery(text:string):Promise<Float32Array>;
  embedDocument(text:string):Promise<Float32Array>;
  embedDocuments(texts:readonly string[]):Promise<Float32Array[]>;
  diagnostics():GpuDiagnostics;
  lastTimings():GpuTimings|null;
  /** Diagnostics: destroy the owned device so the real device-loss path runs (the next dispatch fails as lost). */
  loseDevice():void;
  dispose():void;
}
export interface GpuOptions {
  model:Uint8Array;tokenizer:Uint8Array;wasm:BufferSource|WebAssembly.Module;
  /** Bundled versioned WGSL source, supplied separately from verified model bytes. */
  shader:string;
  projection?:'baseline'|'tiled'|'half'|'auto';tuningCache?:TuningCache;
  tiledShader?:string;halfShader?:string;attentionShader?:string;attention?:'baseline'|'fused';
  /** Observation mode uses timestamp-query and separate passes; omit for production timing. */
  profile?:boolean;
  gpu?:GPU;
  maxBatch?:number;maxTokens?:number;memoryBudgetBytes?:number;
  onUnavailable?:(error:GpuBackendError)=>void;
}
type Kernel='attention_fused'|'norm_subgroup'|'gather'|'linear_half'|'linear_tiled'|'linear'|'add'|'norm'|'scores'|'softmax'|'context'|'gelu'|'pool';
type Operation={kernel:Kernel;pipeline:GPUComputePipeline;group:GPUBindGroup;params:Uint32Array;index:number;alternate?:{kernel:Kernel;pipeline:GPUComputePipeline;group:GPUBindGroup}};
// Standard WebGPU flag values, kept local so importing a CPU-only bundle needs no GPU globals.
const GPUBufferUsage={MAP_READ:1,COPY_SRC:4,COPY_DST:8,UNIFORM:64,STORAGE:128} as const;
const GPUMapMode={READ:1} as const;
const STORAGE=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;
const LIMIT_NAMES=['maxBufferSize','maxStorageBufferBindingSize','maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupStorageSize','maxComputeWorkgroupsPerDimension','maxStorageBuffersPerShaderStage'] as const;

/** One owned device and fixed workspace; callers schedule retries/fallback explicitly. */
export async function createWebGpuEncoder(options:GpuOptions):Promise<WebGpuEncoder>{
  try{
    if((options as {subgroups?:boolean}).subgroups)throw new GpuBackendError('unavailable','Subgroup normalization is an unapproved experiment');
    return await createGpuEncoderInternal({...options,diagnostic:false,subgroups:false});
  }catch(error){throw error instanceof GpuBackendError?error:new GpuBackendError('initialization',String(error));}
}
export interface GpuCapture {vectors:Float32Array;pooled:Float32Array;stages:Float32Array[]}
export interface GpuDiagnosticEncoder extends WebGpuEncoder {
  capture(texts:readonly string[],role:EmbeddingRole,stages:boolean):Promise<{ids:Uint32Array;mask:Uint32Array;tokens:number;capture:GpuCapture}>;
}
/** Internal test constructor. Diagnostic transfers are absent from the public production object. */
export async function createGpuEncoderInternal(options:GpuOptions & {diagnostic?:boolean;subgroups?:boolean;subgroupShader?:string}):Promise<GpuDiagnosticEncoder>{
  const diagnostic=options.diagnostic===true,profile=options.profile===true;
  const projection=options.projection??'baseline';const subgroups=options.subgroups===true;
  const fusedAttention=options.attention==='fused';
  if(fusedAttention&&!options.attentionShader)throw new GpuBackendError('initialization','Missing fused attention shader');
  if(subgroups&&!options.subgroupShader)throw new GpuBackendError('initialization','Missing subgroup shader');
  const auto=projection==='auto';const half=projection==='half';const backend=half?'webgpu-fp16':'webgpu-fp32';
  if(!['baseline','tiled','half','auto'].includes(projection)||(projection==='tiled'||auto)&&!options.tiledShader||half&&!options.halfShader)throw new GpuBackendError('initialization','Invalid projection route or missing tiled shader');
  if(diagnostic&&profile)throw new GpuBackendError('limits','Stage capture and timestamp profiling are separate observation modes');
  const shaderSources:Record<string,string|undefined>={baseline:options.shader,...(projection==='tiled'||auto?{tiled:options.tiledShader}:{}),...(half?{half:options.halfShader}:{}),...(subgroups?{subgroups:options.subgroupShader}:{}),...(fusedAttention?{attention:options.attentionShader}:{})};
  for(const [name,source] of Object.entries(shaderSources)){
    if(typeof source!=='string'||await sha256(new TextEncoder().encode(source))!==KERNEL_HASHES[name as keyof typeof KERNEL_HASHES])
      throw new GpuBackendError('initialization',`WGSL artifact identity mismatch: ${name}`);
  }
  const maxBatch=options.maxBatch??1,maxTokens=options.maxTokens??512;
  const budget=options.memoryBudgetBytes??512*1024*1024;
  if(!Number.isInteger(maxBatch)||maxBatch<1||maxBatch>32||!Number.isInteger(maxTokens)||maxTokens<2||maxTokens>512)
    throw new GpuBackendError('limits','Capacity must be batch 1–32 and tokens 2–512');
  if(!Number.isSafeInteger(budget)||budget<1)throw new GpuBackendError('limits','Invalid memory budget');
  const gpu=options.gpu??globalThis.navigator?.gpu;
  if(!gpu)throw new GpuBackendError('unavailable','WebGPU API is unavailable');
  const adapter=await gpu.requestAdapter({powerPreference:'high-performance'});
  if(!adapter)throw new GpuBackendError('unavailable','No WebGPU adapter');
  if(subgroups&&!adapter.features.has('subgroups'))throw new GpuBackendError('unavailable','Subgroup feature unavailable');
  if(half&&!adapter.features.has('shader-f16'))throw new GpuBackendError('unavailable','FP16 projection feature unavailable');
  if(profile&&!adapter.features.has('timestamp-query'))throw new GpuBackendError('unavailable','Timestamp profiling feature unavailable');
  if(adapter.info.isFallbackAdapter!==false)throw new GpuBackendError('unavailable','Software fallback adapter is not an accelerated route');
  const weightsBytes=90_261_504,rows=maxBatch*maxTokens;
  const sizes={hidden:rows*384*4,temporary:rows*384*4,query:rows*384*4,key:rows*384*4,
    value:rows*384*4,context:rows*384*4,ffn:rows*1536*4,scores:fusedAttention?4:maxBatch*12*maxTokens*maxTokens*4,
    ids:rows*4,mask:rows*4,output:maxBatch*384*4,readback:maxBatch*384*4*(diagnostic?2+7*maxTokens:1),params:128*256,
    stages:diagnostic?rows*384*4*7:4,queryResolve:profile?2048:4,queryReadback:profile?2048:4};
  const scratchBytes=Object.values(sizes).reduce((a,b)=>a+b,0),allocatedBytes=weightsBytes+(half?weightsBytes/2:0)+scratchBytes;
  if(allocatedBytes>budget)throw new GpuBackendError('limits',`GPU buffers require ${allocatedBytes} bytes, exceeding budget ${budget}`);
  const largest=Math.max(weightsBytes,...Object.values(sizes));
  if(largest>adapter.limits.maxStorageBufferBindingSize||largest>adapter.limits.maxBufferSize||
    adapter.limits.maxComputeInvocationsPerWorkgroup<128||adapter.limits.maxStorageBuffersPerShaderStage<5)
    throw new GpuBackendError('limits','Adapter cannot reserve the requested fixed graph');
  let device:GPUDevice;
  try{device=await adapter.requestDevice({requiredFeatures:[...(profile?['timestamp-query']:[]),...(half?['shader-f16']:[]),...(subgroups?['subgroups']:[])] as GPUFeatureName[],requiredLimits:{maxBufferSize:Math.max(268435456,largest),
    maxStorageBufferBindingSize:Math.max(134217728,largest)}});}
  catch(error){throw new GpuBackendError('initialization',String(error));}
  let state:GpuDiagnostics['state']='ready',failure:GpuBackendError|null=null,tokenizer:ArcticTokenizer|null=null;
  const onUnavailable=options.onUnavailable;
  let tuning:{record:TuningRecord;cacheHit:boolean}|null=null,tuningOverride:ProjectionVariant|null=null;
  let timing:GpuTimings|null=null;let querySet:GPUQuerySet|null=null;
  const owned:GPUBuffer[]=[];
  function unavailable(error:GpuBackendError):void{
    if(state==='disposed'||failure)return;
    failure=error;state=error.code==='lost'?'lost':'failed';
    for(const buffer of owned)buffer.destroy();owned.length=0;tokenizer?.dispose();tokenizer=null;
    querySet?.destroy();device.destroy();
    try{onUnavailable?.(error);}catch{/* Observer failure cannot revive a lost backend or publish incomplete vectors. */}
  }
  void device.lost.then(info=>unavailable(new GpuBackendError('lost',`Device lost (${info.reason}): ${info.message}`)));
  device.addEventListener('uncapturederror',event=>unavailable(new GpuBackendError('execution',event.error.message)));
  function isDisposed():boolean{return state==='disposed';}
  function loseDevice():void{if(state==='disposed'||failure)return;device.destroy();}
  function assertLive():void{
    if(failure)throw failure;
    if(state==='disposed')throw new GpuBackendError('disposed','GPU encoder has been disposed');
  }
  function allocate(label:string,size:number,usage:number):GPUBuffer{
    const buffer=device.createBuffer({label:`Quixi ${label}`,size,usage});owned.push(buffer);return buffer;
  }
  function dispose():void{
    if(state==='disposed')return;state='disposed';
    for(const buffer of owned)buffer.destroy();owned.length=0;
    tokenizer?.dispose();tokenizer=null;querySet?.destroy();device.destroy();
  }
  device.pushErrorScope('out-of-memory');device.pushErrorScope('validation');
  try{
    const model=await verifyGpuModel(options.model);assertLive();
    tokenizer=await createArcticTokenizer({wasm:options.wasm,tokenizer:options.tokenizer});assertLive();
    const weights=allocate('weights',weightsBytes,STORAGE);
    const halfWeights=half?allocate('half weights',weightsBytes/2,STORAGE):null;
    device.queue.writeBuffer(weights,0,model.weights as Uint8Array<ArrayBuffer>);
    const buffers={} as Record<keyof typeof sizes,GPUBuffer>;
    for(const [name,size] of Object.entries(sizes))buffers[name as keyof typeof sizes]=allocate(name,size,
      name==='readback'||name==='queryReadback'?GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST:
      name==='params'?GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST:name==='queryResolve'?512|4:STORAGE);
    if(profile)querySet=device.createQuerySet({type:'timestamp',count:256});
    const shader=device.createShaderModule({label:'Arctic XS FP32 baseline v1.0.0',code:(half?'enable f16;\n':'')+(subgroups?'enable subgroups;\n':'')+options.shader+((projection==='tiled'||auto)?'\n'+options.tiledShader:half?'\n'+options.halfShader:'')+(subgroups?'\n'+options.subgroupShader:'')+(fusedAttention?'\n'+options.attentionShader:'')});
    const compilation=await shader.getCompilationInfo();
    const errors=compilation.messages.filter(m=>m.type==='error');
    if(errors.length)throw new Error(errors.map(e=>`${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
    const pipelines={} as Record<Kernel,GPUComputePipeline>;
    for(const name of [...['gather','linear','add','norm','scores','softmax','context','gelu','pool'],...((projection==='tiled'||auto)?['linear_tiled']:half?['linear_half']:[]),...(subgroups?['norm_subgroup']:[]),...(fusedAttention?['attention_fused']:[])] as Kernel[])
      pipelines[name]=await device.createComputePipelineAsync({label:name,layout:'auto',compute:{module:shader,entryPoint:name}});
    if(half){
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:shader,entryPoint:'pack_weights'}});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:weights}},{binding:8,resource:{buffer:halfWeights!}}]});
      const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);
      const count=Math.ceil(weightsBytes/4/64);pass.dispatchWorkgroups(Math.min(count,65535),Math.ceil(count/65535));pass.end();device.queue.submit([encoder.finish()]);
    }
    const operations:Operation[]=[];
    const paramData=new Uint32Array(sizes.params/4);
    function tensor(name:string):number{
      const found=model.tensors.get(name);if(!found)throw new Error(`Missing tensor ${name}`);return found.offset;
    }
    function op(kernel:Kernel,bindings:Record<number,GPUBuffer>,values:number[]=[]):void{
      const index=operations.length,pipeline=pipelines[kernel];
      const params=paramData.subarray(index*64,index*64+8);params.set([0,0,...values]);
      const entries:GPUBindGroupEntry[]=Object.entries(bindings).map(([binding,buffer])=>({binding:Number(binding),resource:{buffer}}));
      entries.push({binding:7,resource:{buffer:buffers.params,offset:index*256,size:32}});
      const operation:Operation={kernel,pipeline,group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries}),params,index};
      if(auto&&kernel==='linear'){const alternate=pipelines.linear_tiled;operation.alternate={kernel:'linear_tiled',pipeline:alternate,group:device.createBindGroup({layout:alternate.getBindGroupLayout(0),entries})};}
      operations.push(operation);
    }
    function linear(input:GPUBuffer,output:GPUBuffer,name:string,inputWidth:number,outputWidth:number):void{
      const bindings:Record<number,GPUBuffer>={0:weights,1:input,4:output};if(half)bindings[8]=halfWeights!;
      op(projection==='tiled'?'linear_tiled':half?'linear_half':'linear',bindings,[inputWidth,outputWidth,tensor(name+'.weight'),tensor(name+'.bias')]);
    }
    function norm(input:GPUBuffer,output:GPUBuffer,name:string):void{
      op(subgroups?'norm_subgroup':'norm',{0:weights,1:input,4:output},[0,0,tensor(name+'.weight'),tensor(name+'.bias')]);
    }
    op('gather',{0:weights,4:buffers.temporary,5:buffers.ids},[0,0,tensor('embeddings.word_embeddings.weight'),0,
      tensor('embeddings.position_embeddings.weight'),tensor('embeddings.token_type_embeddings.weight')]);
    norm(buffers.temporary,buffers.hidden,'embeddings.LayerNorm');
    for(let layer=0;layer<6;layer++){
      const l=`encoder.layer.${layer}`;
      for(const [name,target] of [['query',buffers.query],['key',buffers.key],['value',buffers.value]] as const)
        linear(buffers.hidden,target,l+'.attention.self.'+name,384,384);
      if(fusedAttention)op('attention_fused',{1:buffers.query,2:buffers.key,3:buffers.value,4:buffers.context,6:buffers.mask});
      else{
        op('scores',{1:buffers.query,2:buffers.key,4:buffers.scores,6:buffers.mask});
        op('softmax',{4:buffers.scores});
        op('context',{1:buffers.scores,2:buffers.value,4:buffers.context});
      }
      linear(buffers.context,buffers.temporary,l+'.attention.output.dense',384,384);
      op('add',{1:buffers.temporary,2:buffers.hidden,4:buffers.context});
      norm(buffers.context,buffers.hidden,l+'.attention.output.LayerNorm');
      linear(buffers.hidden,buffers.ffn,l+'.intermediate.dense',384,1536);
      op('gelu',{4:buffers.ffn});
      linear(buffers.ffn,buffers.temporary,l+'.output.dense',1536,384);
      op('add',{1:buffers.temporary,2:buffers.hidden,4:buffers.context});
      norm(buffers.context,buffers.hidden,l+'.output.LayerNorm');
    }
    op('pool',{1:buffers.hidden,4:buffers.output});
    await device.queue.onSubmittedWorkDone();
    model.weights=new Uint8Array(); // Release the verified temporary package after the GPU upload completes.
    const validation=await device.popErrorScope(),memory=await device.popErrorScope();
    if(validation||memory)throw new Error((validation??memory)!.message);assertLive();
    async function execute(texts:readonly string[],role:EmbeddingRole,captureStages=false):Promise<{ids:Uint32Array;mask:Uint32Array;tokens:number;capture:GpuCapture}>{
      assertLive();if(state==='busy')throw new GpuBackendError('busy','One active GPU batch is allowed per workspace');
      if(texts.length<1||texts.length>maxBatch)throw new RangeError(`GPU batch must contain 1–${maxBatch} texts`);
      const start=performance.now();
      const tokenRows=texts.map(text=>tokenizer!.tokenize(text,role));
      const tokenized=performance.now();
      const tokens=Math.max(...tokenRows.map(ids=>ids.length)),batch=texts.length;
      if(tokens>maxTokens)throw new RangeError(`Input exceeds configured ${maxTokens}-token capacity`);
      const selectedProjection=tuningOverride??(auto?(tuning?.record.selections[tuningBucket(batch*tokens)]??'baseline'):projection);
      state='busy';device.pushErrorScope('out-of-memory');device.pushErrorScope('validation');
      try{
        const ids=new Uint32Array(batch*tokens),mask=new Uint32Array(batch*tokens);
        tokenRows.forEach((row,i)=>{ids.set(row,i*tokens);mask.fill(1,i*tokens,i*tokens+row.length);});
        for(const operation of operations){operation.params[0]=tokens;operation.params[1]=batch;}
        device.queue.writeBuffer(buffers.ids,0,ids);device.queue.writeBuffer(buffers.mask,0,mask);
        device.queue.writeBuffer(buffers.params,0,paramData);
        const uploaded=performance.now();
        const encoder=device.createCommandEncoder({label:'Quixi complete FP32 graph'});
        let pass=profile?null:encoder.beginComputePass();let stageIndex=0,normOrdinal=0;
        for(const operation of operations){
          const {kernel,pipeline,group}=selectedProjection==='tiled'&&operation.alternate?operation.alternate:operation;
          if(profile)pass=encoder.beginComputePass({timestampWrites:{querySet:querySet!,beginningOfPassWriteIndex:operation.index*2,endOfPassWriteIndex:operation.index*2+1}});
          if(!pass)throw new Error('Missing compute pass');
          pass.setPipeline(pipeline);pass.setBindGroup(0,group);
          if(kernel==='attention_fused')pass.dispatchWorkgroups(tokens,batch*12);
          else if(kernel==='linear_tiled'||kernel==='linear_half')pass.dispatchWorkgroups(Math.ceil(operation.params[3]!/16),Math.ceil(batch*tokens/16));
          else if(kernel==='norm'||kernel==='norm_subgroup')pass.dispatchWorkgroups(batch*tokens);
          else if(kernel==='pool')pass.dispatchWorkgroups(batch);
          else if(kernel==='scores')pass.dispatchWorkgroups(Math.ceil(tokens/64),tokens,batch*12);
          else if(kernel==='softmax')pass.dispatchWorkgroups(batch*tokens,12);
          else{
            const width=kernel==='gelu'?1536:kernel==='linear'?operation.params[3]!:384;
            const groups=Math.ceil(batch*tokens*width/64);
            pass.dispatchWorkgroups(Math.min(groups,65535),Math.ceil(groups/65535));
          }
          if(profile)pass.end();
          if((kernel==='norm'||kernel==='norm_subgroup')&&normOrdinal++%2===0&&diagnostic&&captureStages){
            if(!profile)pass!.end();
        if(profile){encoder.resolveQuerySet(querySet!,0,operations.length*2,buffers.queryResolve,0);
          encoder.copyBufferToBuffer(buffers.queryResolve,0,buffers.queryReadback,0,operations.length*16);}
        encoder.copyBufferToBuffer(buffers.hidden,0,buffers.stages,stageIndex*rows*384*4,batch*tokens*384*4);
            stageIndex++;pass=encoder.beginComputePass();
          }
        }
        if(!profile)pass!.end();
        if(profile){encoder.resolveQuerySet(querySet!,0,operations.length*2,buffers.queryResolve,0);
          encoder.copyBufferToBuffer(buffers.queryResolve,0,buffers.queryReadback,0,operations.length*16);}
        encoder.copyBufferToBuffer(buffers.output,0,buffers.readback,0,batch*384*4);
        const vectorBytes=batch*384*4;
        if(diagnostic){
          for(let row=0;row<batch;row++)encoder.copyBufferToBuffer(buffers.hidden,row*tokens*384*4,buffers.readback,vectorBytes+row*384*4,384*4);
          if(captureStages){if(stageIndex!==7)throw new Error('Incomplete diagnostic stages');
            for(let stage=0;stage<7;stage++)encoder.copyBufferToBuffer(buffers.stages,stage*rows*384*4,buffers.readback,vectorBytes*2+stage*batch*tokens*384*4,batch*tokens*384*4);}
        }
        const readBytes=vectorBytes*(diagnostic?2+(captureStages?7*tokens:0):1);
        device.queue.submit([encoder.finish()]);const submitted=performance.now();
        await buffers.readback.mapAsync(GPUMapMode.READ,0,readBytes);assertLive();
        const captured=new Float32Array(buffers.readback.getMappedRange(0,readBytes)).slice();buffers.readback.unmap();
        const output=captured.slice(0,batch*384);
        let gpuKernelMs:Record<string,number>|null=null;
        if(profile){
          await buffers.queryReadback.mapAsync(GPUMapMode.READ,0,operations.length*16);assertLive();
          const timestamps=new BigUint64Array(buffers.queryReadback.getMappedRange(0,operations.length*16));gpuKernelMs={};
          for(const operation of operations){const ns=timestamps[operation.index*2+1]!-timestamps[operation.index*2]!;
            if(ns<0n)throw new Error('Invalid GPU timestamps');gpuKernelMs[operation.kernel]=(gpuKernelMs[operation.kernel]??0)+Number(ns)/1e6;}
          buffers.queryReadback.unmap();
        }
        const validation=await device.popErrorScope(),memory=await device.popErrorScope();
        if(validation||memory)throw new Error((validation??memory)!.message);assertLive();
        if(!output.every(Number.isFinite))throw new Error('GPU produced a nonfinite vector');
        timing={tokenizationMs:tokenized-start,inputUploadMs:uploaded-tokenized,dispatchMs:submitted-uploaded,completionReadbackMs:performance.now()-submitted,totalMs:performance.now()-start,gpuKernelMs};
        state='ready';return{ids,mask,tokens,capture:{vectors:output,pooled:diagnostic?captured.slice(batch*384,batch*384*2):new Float32Array(),
          stages:captureStages?Array.from({length:7},(_,i)=>captured.slice(batch*384*2+i*batch*tokens*384,batch*384*2+(i+1)*batch*tokens*384)):[]}};
      }catch(error){
        const reported=error instanceof GpuBackendError?error:new GpuBackendError(isDisposed()?'disposed':'execution',String(error));
        unavailable(reported);
        throw failure??reported;
      }
    }
    async function embed(texts:readonly string[],role:EmbeddingRole):Promise<Float32Array[]>{
      const {capture}=await execute(texts,role);return Array.from({length:texts.length},(_,i)=>capture.vectors.slice(i*384,(i+1)*384));
    }
    if(auto){
      const info=adapter.info;
      const key=await tuningKey({schema:1,model:MODEL_SHA256,runtime:RUNTIME_SOURCE_SHA256,
        shaders:{baseline:options.shader,tiled:options.tiledShader,attention:options.attentionShader,subgroups:options.subgroupShader},
        adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description},
        limits:Object.fromEntries(LIMIT_NAMES.map(name=>[name,device.limits[name]])),features:[...device.features].sort(),
        userAgent:globalThis.navigator?.userAgent??'unknown',capacity:{maxBatch,maxTokens},fusedAttention,subgroups});
      tuning=await tuneProjections({key,...(options.tuningCache?{cache:options.tuningCache}:{}),measure:async(variant,tokens)=>{
        tuningOverride=variant;try{const started=performance.now();await embed([Array(Math.min(tokens,maxTokens)-2).fill('token').join(' ')],'document');return Math.max(0.001,performance.now()-started);}
        finally{tuningOverride=null;}
      }});
    }
    const info=adapter.info;
    return{
      backend,
      ...(diagnostic?{capture:execute}:{}),
      tokenize(text,role='document'){assertLive();return tokenizer!.tokenize(text,role);},
      async embedQuery(text){return(await embed([text],'query'))[0];},
      async embedDocument(text){return(await embed([text],'document'))[0];},
      embedDocuments(texts){return embed(texts,'document');},
      diagnostics(){return{backend,projection,tuning:tuning?structuredClone(tuning):null,subgroups,attention:fusedAttention?'fused':'baseline',modelSha256:MODEL_SHA256,kernelVersion:'1.0.0',
        adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter},
        features:[...adapter.features].sort(),enabledFeatures:[...device.features].sort(),
        limits:Object.fromEntries(LIMIT_NAMES.map(name=>[name,device.limits[name]])),capacity:{batch:maxBatch,tokens:maxTokens},
        memory:{weightsBytes:weightsBytes+(half?weightsBytes/2:0),scratchBytes,allocatedBytes,bufferCount:owned.length},state};},
      lastTimings(){return timing?{...timing}:null;},loseDevice,dispose,
    } as GpuDiagnosticEncoder;
  }catch(error){dispose();throw error instanceof GpuBackendError?error:new GpuBackendError('initialization',String(error));}
}
