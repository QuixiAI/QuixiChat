import type {EmbeddingRole} from '../scalar.ts';
import type {CachedEmbedding,EmbeddingIdentity,EmbeddingPriority,EmbeddingRequest,EmbeddingResult,EmbeddingScheduler,EmbeddingTicket,SchedulerExecutor,SchedulerFailureCode,SchedulerLimits,SchedulerOptions,SchedulerStatistics} from './types.ts';

export class SchedulerError extends Error {
  readonly code:SchedulerFailureCode;
  constructor(code:SchedulerFailureCode,message:string){super(message);this.name='SchedulerError';this.code=code;}
}
const DEFAULTS:SchedulerLimits={maxJobs:256,maxConsumers:1024,maxConsumersPerJob:64,maxInputBytes:64*1024,maxAdmittedBytes:8*1024*1024,
  maxCacheEntries:2048,maxCacheBytes:16*1024*1024,maxStoreOperations:8,maxStoreBytes:1024*1024,storeTimeoutMs:50,
  backgroundBatch:4,maxPaddedTokens:2048,backgroundAgingDispatches:8};
const macrotask=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const IDENTITY_FIELDS=['modelHash','artifactHash','tokenizerVersion','preprocessingVersion','chunkingVersion','queryPrefix'] as const;
export function embeddingIdentityKey(identity:EmbeddingIdentity):string{
  if(!identity||IDENTITY_FIELDS.some(key=>typeof identity[key]!=='string'||identity[key].length>1024||key!=='queryPrefix'&&!identity[key].length))
    throw new SchedulerError('invalid','Invalid semantic identity');
  return JSON.stringify(IDENTITY_FIELDS.map(key=>identity[key]));
}
function validExecutor(executor:SchedulerExecutor):void{
  if(!executor||!['cpu','gpu'].includes(executor.kind)||typeof executor.route!=='string'||!executor.route.length||executor.route.length>128||
    !Number.isInteger(executor.maxBatch)||executor.maxBatch<1||executor.maxBatch>32||!Number.isInteger(executor.maxTokens)||executor.maxTokens<2||executor.maxTokens>512||
    !Number.isInteger(executor.maxPaddedTokens)||executor.maxPaddedTokens<executor.maxTokens||
    typeof executor.inspect!=='function'||typeof executor.execute!=='function'||typeof executor.dispose!=='function')throw new SchedulerError('invalid','Invalid executor contract');
}
/** Validation only: vectors are generated/normalized exclusively by C or WGSL. */
function copyVector(value:unknown):Float32Array|null{
  if(!(value instanceof Float32Array)||value.length!==384)return null;
  const vector=value.slice();let squared=0;
  for(const number of vector){if(!Number.isFinite(number))return null;squared+=number*number;}
  return Math.abs(squared-1)<=0.002?vector:null;
}
interface Consumer {id:number;priority:EmbeddingPriority;resolve:(value:EmbeddingResult)=>void;reject:(error:SchedulerError)=>void;detach:()=>void}
interface Job {key:string;text:string;role:EmbeddingRole;tokens:number;bytes:number;order:number;bornDispatch:number;
  state:'queued'|'checking'|'active';cacheChecked:boolean;shared:boolean;consumers:Map<number,Consumer>}
interface CacheEntry {value:CachedEmbedding;bytes:number}

/** Run this service in a dedicated worker. One batch owns the executor at a time. */
export function createEmbeddingScheduler(options:SchedulerOptions):EmbeddingScheduler{
  const identityKey=embeddingIdentityKey(options.identity),identity=Object.freeze(Object.fromEntries(IDENTITY_FIELDS.map(key=>[key,options.identity[key]])) as unknown as EmbeddingIdentity);
  let executor=options.executor;validExecutor(executor);
  const preflight=options.preflight??executor.inspect.bind(executor),cacheStore=options.cacheStore,fallback=options.fallback,onEvent=options.onEvent;
  const limits={...DEFAULTS,...options.limits};
  for(const [key,value] of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1)throw new SchedulerError('invalid',`Invalid scheduler limit ${key}`);
  if(limits.maxInputBytes>1024*1024||limits.backgroundBatch>32||limits.storeTimeoutMs>1000)throw new SchedulerError('invalid','Scheduler limits exceed fixed runtime bounds');
  const now=options.now??(()=>performance.now()),yieldTask=options.yieldTask??macrotask;
  const jobs=new Map<string,Job>(),consumers=new Map<number,Job>(),cache=new Map<string,CacheEntry>();
  const drains=new Set<{ids:Set<number>;resolve:()=>void}>();
  const rates:{count:number;ms:number}[]=[];
  let throughputAnchor:number|null=null;
  let admittedBytes=0,cacheBytes=0,storeOperations=0,storeBytes=0,nextId=1,nextOrder=1;
  let state:SchedulerStatistics['state']='ready',background:SchedulerStatistics['background']='running';
  let accepting=true,scheduled=false,pumping=false,fallbackUsed=false,active:Job[]=[];
  let backgroundDrain:Promise<void>|null=null,resolveBackgroundDrain:(()=>void)|null=null;
  let closePromise:Promise<void>|null=null,resolveClose:(()=>void)|null=null,closing:'cancel'|'drain'|null=null;
  const totals={submitted:0,completed:0,cancelled:0,failed:0,cacheHits:0,singleflightJoins:0,dispatches:0,inferred:0,fallbacks:0};
  function stats(remainingDocuments?:number):SchedulerStatistics{
    if(remainingDocuments!==undefined&&(!Number.isSafeInteger(remainingDocuments)||remainingDocuments<0))throw new SchedulerError('invalid','Invalid remaining document estimate');
    const count=rates.reduce((sum,r)=>sum+r.count,0),ms=rates.reduce((sum,r)=>sum+r.ms,0);
    const speed=ms>0?count*1000/ms:null;
    return{state,route:executor.route,kind:executor.kind,background,jobs:jobs.size,consumers:consumers.size,admittedBytes,activeRequests:active.length,
      cacheEntries:cache.size,cacheBytes,storeOperations,storeBytes,...totals,recentChunksPerSecond:speed,
      estimatedRemainingSeconds:speed&&background!=='paused'&&state!=='unavailable'&&state!=='closed'?(remainingDocuments??[...jobs.values()].filter(job=>job.role==='document'&&job.consumers.size).length)/speed:null,etaScope:remainingDocuments===undefined?'admitted-documents':'owner-document-estimate',inferenceCompletionsAreDurable:false};
  }
  function emit(type:Parameters<NonNullable<SchedulerOptions['onEvent']>>[0]['type']):void{
    try{onEvent?.({type,statistics:stats()});}catch{/* Observers cannot change scheduling or result validity. */}
  }
  function priority(job:Job):number{return Math.min(...[...job.consumers.values()].map(c=>c.priority),4);}
  function effective(job:Job):number{
    const value=priority(job);return value===0?0:Math.max(1,value-Math.floor((totals.dispatches-job.bornDispatch)/limits.backgroundAgingDispatches));
  }
  function drop(job:Job):void{if(jobs.get(job.key)===job){jobs.delete(job.key);admittedBytes-=job.bytes;if(jobs.size===0)throughputAnchor=null;}}
  function checkDrains():void{
    for(const waiter of drains){if([...waiter.ids].every(id=>!consumers.has(id))){drains.delete(waiter);waiter.resolve();}}
    if(resolveBackgroundDrain&&![...jobs.values()].some(job=>[...job.consumers.values()].some(c=>c.priority>0))){
      background='paused';const resolve=resolveBackgroundDrain;resolveBackgroundDrain=null;backgroundDrain=null;resolve();
    }
    if(closing==='drain'&&jobs.size===0&&active.length===0&&state!=='switching')finishClose();
  }
  function finishClose():void{
    if(state==='closed')return;
    state='closed';try{executor.dispose();}catch{/* Closing still rejects admission. */}
    cache.clear();cacheBytes=0;resolveClose?.();resolveClose=null;emit('closed');
  }
  function settle(job:Job,value:CachedEmbedding|null,error?:SchedulerError,cacheHit=false):void{
    drop(job);const waiting=[...job.consumers.values()];job.consumers.clear();
    for(const consumer of waiting){consumers.delete(consumer.id);consumer.detach();
      if(error){totals.failed++;consumer.reject(error);}
      else{totals.completed++;if(cacheHit)totals.cacheHits++;consumer.resolve({identity:Object.freeze({...identity}),role:job.role,route:value!.route,vector:value!.vector.slice(),cacheHit,shared:job.shared});}
    }
    checkDrains();
  }
  function cancel(id:number):void{
    const job=consumers.get(id),consumer=job?.consumers.get(id);if(!job||!consumer)return;
    job.consumers.delete(id);consumers.delete(id);consumer.detach();totals.cancelled++;
    consumer.reject(new SchedulerError('cancelled','Embedding consumer cancelled'));
    if(!job.consumers.size&&job.state==='queued')drop(job);
    checkDrains();emit('cancelled');kick();
  }
  function putHot(key:string,value:CachedEmbedding):void{
    const vector=copyVector(value.vector);if(!vector)return;
    const bytes=key.length*2+identityKey.length*2+1536+256;
    if(bytes>limits.maxCacheBytes)return;
    const previous=cache.get(key);if(previous){cacheBytes-=previous.bytes;cache.delete(key);}
    while(cache.size>=limits.maxCacheEntries||cacheBytes+bytes>limits.maxCacheBytes){
      const oldest=cache.keys().next().value as string|undefined;if(oldest===undefined)break;
      cacheBytes-=cache.get(oldest)!.bytes;cache.delete(oldest);
    }
    cache.set(key,{value:{...value,vector},bytes});cacheBytes+=bytes;
  }
  function readHot(key:string):CachedEmbedding|null{
    const found=cache.get(key);if(!found)return null;cache.delete(key);cache.set(key,found);return found.value;
  }
  /** Timed-out underlying calls retain their permits until they actually settle. */
  async function storeCall<T>(operation:()=>Promise<T>,bytes:number):Promise<T|null>{
    if(storeOperations>=limits.maxStoreOperations||storeBytes+bytes>limits.maxStoreBytes)return null;
    storeOperations++;storeBytes+=bytes;let timer:ReturnType<typeof setTimeout>|undefined;
    const actual=Promise.resolve().then(operation).catch(()=>null).finally(()=>{storeOperations--;storeBytes-=bytes;});
    try{return await Promise.race([actual,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),limits.storeTimeoutMs);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }
  function prepareCache(job:Job):void{
    job.state='checking';const key=job.key,store=cacheStore!;
    void storeCall(()=>store.get(key),key.length*2+1536).then(result=>{
      if(jobs.get(key)!==job||job.state!=='checking')return;
      if(!job.consumers.size){drop(job);checkDrains();kick();return;}
      let value:CachedEmbedding|null=null;
      try{const vector=result&&result.identityKey===identityKey&&result.role===job.role&&typeof result.route==='string'&&result.route.length>0&&result.route.length<=128?copyVector(result.vector):null;
        if(vector)value={identityKey,role:job.role,route:result!.route,vector};}catch{/* Corrupt storage is a cache miss. */}
      if(value){putHot(key,value);settle(job,value,undefined,true);emit('completed');}
      else{job.cacheChecked=true;job.state='queued';}
      kick();
    }).catch(error=>{failBackend(error);});
  }
  function persist(key:string,value:CachedEmbedding):void{
    const store=cacheStore;if(!store)return;
    const copy={...value,vector:value.vector.slice()};
    void storeCall(()=>store.put(key,copy),key.length*2+1536+identityKey.length*2);
  }
  function candidates():Job[]{
    const eligible=[...jobs.values()].filter(job=>job.state==='queued'&&job.consumers.size&&
      (background!=='paused'||priority(job)===0||closing==='drain'));
    const checkingInteractive=[...jobs.values()].some(job=>job.state==='checking'&&priority(job)===0&&job.consumers.size);
    return eligible.filter(job=>!checkingInteractive||priority(job)===0).sort((a,b)=>effective(a)-effective(b)||a.order-b.order);
  }
  function failBackend(error:unknown):void{
    state='unavailable';const failure=error instanceof SchedulerError?error:new SchedulerError('backend',`Embedding backend failed: ${String(error)}`);
    for(const job of [...jobs.values()])settle(job,null,failure);
    try{executor.dispose();}catch{/* Original backend error remains authoritative. */}
    emit('failed');checkDrains();
  }
  function kick():void{
    if(scheduled||pumping||state==='closed'||state==='unavailable'||state==='switching')return;
    scheduled=true;
    void yieldTask().then(()=>{scheduled=false;return pump();}).catch(failBackend);
  }
  function stopped():boolean{return state==='closed'||state==='unavailable';}
  function closed():boolean{return state==='closed';}
  async function pump():Promise<void>{
    if(pumping||state==='closed'||state==='unavailable')return;pumping=true;
    try{
      while(!stopped()){
        const ready=candidates(),first=ready[0];if(!first)break;
        if(!first.cacheChecked&&cacheStore){prepareCache(first);continue;}
        const batch=[first];let maximum=first.tokens;
        const maxBatch=priority(first)===0||first.role==='query'||executor.kind==='cpu'?1:Math.min(limits.backgroundBatch,executor.maxBatch);
        const tokenBudget=Math.min(limits.maxPaddedTokens,executor.maxPaddedTokens);
        for(const job of ready.slice(1)){
          if(batch.length>=maxBatch)break;
          if(job.role!==first.role||effective(job)!==effective(first)||!job.cacheChecked||Math.max(maximum,job.tokens)*(batch.length+1)>tokenBudget)continue;
          batch.push(job);maximum=Math.max(maximum,job.tokens);
        }
        active=batch;for(const job of batch)job.state='active';state='running';totals.dispatches++;emit('dispatch');
        const started=now();
        try{
          const output=await executor.execute(batch.map(job=>job.text),first.role);
          if(closed()){for(const job of batch)drop(job);break;}
          if(!Array.isArray(output)||output.length!==batch.length)throw new SchedulerError('backend','Backend returned an invalid batch');
          const vectors=output.map(copyVector);if(vectors.some(vector=>vector===null))throw new SchedulerError('backend','Backend returned an invalid vector');
          if(first.role==='document'){const completed=now(),elapsed=Math.max(0.001,completed-(throughputAnchor??started));
            rates.push({count:batch.length,ms:elapsed});if(rates.length>16)rates.shift();throughputAnchor=completed;}
          totals.inferred+=batch.length;
          active=[];state='ready';
          for(let i=0;i<batch.length;i++){
            const job=batch[i]!,value={identityKey,role:job.role,route:executor.route,vector:vectors[i]!};
            if(job.consumers.size){putHot(job.key,value);persist(job.key,value);}settle(job,value);
          }
          emit('completed');
        }catch(error){
          active=[];
          if(closed()){for(const job of batch)drop(job);break;}
          if(fallback&&!fallbackUsed&&executor.recoverable?.(error)){
            fallbackUsed=true;state='switching';
            for(const job of batch){if(job.consumers.size)job.state='queued';else drop(job);}
            try{executor.dispose();executor=await fallback();validExecutor(executor);rates.length=0;totals.fallbacks++;
              if(closed()||closing==='cancel'){executor.dispose();break;}state='ready';emit('backend');}
            catch(failure){failBackend(failure);break;}
          }else{failBackend(error);break;}
        }
        // A CPU execute may be synchronous. This must be a task yield, not only a microtask.
        await yieldTask();
      }
    }finally{active=[];pumping=false;checkDrains();}
  }
  function rejected(code:SchedulerFailureCode,message:string):EmbeddingTicket{
    return{id:nextId++,result:Promise.reject(new SchedulerError(code,message)),cancel(){}};
  }
  function drain():Promise<void>{
    if(!consumers.size)return Promise.resolve();
    if(drains.size>=64)return Promise.reject(new SchedulerError('saturated','Too many pending drain observers'));
    return new Promise(resolve=>drains.add({ids:new Set(consumers.keys()),resolve}));
  }
  return{
    identity,
    submit(request:EmbeddingRequest):EmbeddingTicket{
      if(!accepting||state==='closed')return rejected('closed','Embedding scheduler is closed');
      if(state==='unavailable')return rejected('backend','Embedding backend is unavailable');
      if(!request||typeof request.text!=='string'||!['query','document'].includes(request.role))return rejected('invalid','Invalid embedding request');
      const requestedPriority=request.priority??(request.role==='query'?0:2);
      if(!Number.isInteger(requestedPriority)||requestedPriority<0||requestedPriority>4)return rejected('invalid','Invalid embedding priority');
      if(request.signal?.aborted)return rejected('cancelled','Embedding consumer cancelled');
      if(background==='draining'&&requestedPriority>0)return rejected('background-draining','Background admission is draining');
      if(consumers.size>=limits.maxConsumers)return rejected('saturated','Embedding consumer capacity reached');
      try{if(request.identity&&embeddingIdentityKey(request.identity)!==identityKey)return rejected('invalid','Incompatible semantic identity');}
      catch{return rejected('invalid','Invalid semantic identity');}
      if(request.text.length>limits.maxInputBytes)return rejected('oversized','Embedding text byte limit exceeded');
      const admittedAt=now();
      const bytes=new TextEncoder().encode(request.text);if(bytes.byteLength>limits.maxInputBytes)return rejected('oversized','Embedding text byte limit exceeded');
      let inspection;
      try{inspection=preflight(request.text,request.role);}catch{return rejected('backend','Strict token preflight failed');}
      if(!Number.isInteger(inspection.tokenCount)||inspection.tokenCount<2||typeof inspection.overflow!=='boolean'||!(/^[a-f0-9]{64}$/.test(inspection.inputSha256)))return rejected('backend','Invalid token preflight result');
      if(inspection.overflow||inspection.tokenCount>executor.maxTokens||inspection.tokenCount>Math.min(limits.maxPaddedTokens,executor.maxPaddedTokens))return rejected('oversized','Embedding input exceeds the token budget; chunk before submission');
      const key=identityKey+':'+request.role+':'+inspection.inputSha256;
      let job=jobs.get(key);const cached=readHot(key);
      if(!job){
        if(jobs.size>=limits.maxJobs)return rejected('saturated','Embedding job capacity reached');
        const held=request.text.length*2+key.length*2+bytes.byteLength+2048;
        if(admittedBytes+held>limits.maxAdmittedBytes)return rejected('saturated','Embedding admitted byte capacity reached');
        job={key,text:request.text,role:request.role,tokens:inspection.tokenCount,bytes:held,order:nextOrder++,bornDispatch:totals.dispatches,
          state:'queued',cacheChecked:!cacheStore,shared:false,consumers:new Map()};
        jobs.set(key,job);admittedBytes+=held;if(throughputAnchor===null)throughputAnchor=admittedAt;
      }else if(job.consumers.size>=limits.maxConsumersPerJob)return rejected('saturated','Embedding duplicate consumer capacity reached');
      else{job.shared=true;totals.singleflightJoins++;}
      const id=nextId++;let resolve!:(value:EmbeddingResult)=>void,reject!:(error:SchedulerError)=>void;
      const result=new Promise<EmbeddingResult>((yes,no)=>{resolve=yes;reject=no;});
      const signal=request.signal;
      const abort=()=>cancel(id),consumer:Consumer={id,priority:requestedPriority,resolve,reject,detach:()=>signal?.removeEventListener('abort',abort)};
      job.consumers.set(id,consumer);consumers.set(id,job);totals.submitted++;
      signal?.addEventListener('abort',abort,{once:true});
      if(cached&&job.state==='queued'){settle(job,cached,undefined,true);emit('completed');}
      else{emit('queued');kick();}
      return{id,result,cancel:abort};
    },
    pauseBackground(){if(state==='closed')return;background='paused';if(!active.length)throughputAnchor=null;emit('paused');},
    resumeBackground(){if(state==='closed')return;background=resolveBackgroundDrain?'draining':'running';if(jobs.size&&!active.length)throughputAnchor=now();emit('resumed');kick();},
    drainBackground(){
      if(state==='closed')return Promise.resolve();if(backgroundDrain)return backgroundDrain;
      background='draining';if(jobs.size&&!active.length)throughputAnchor=now();backgroundDrain=new Promise(resolve=>{resolveBackgroundDrain=resolve;});const promise=backgroundDrain;checkDrains();kick();return promise;
    },
    drain,statistics:stats,
    clearCache(){cache.clear();cacheBytes=0;},
    shutdown(mode='cancel'){
      if(closePromise)return closePromise;if(state==='closed')return Promise.resolve();
      accepting=false;closing=mode;closePromise=new Promise(resolve=>{resolveClose=resolve;});
      if(mode==='cancel'){
        for(const id of [...consumers.keys()])cancel(id);
        for(const job of [...jobs.values()])if(job.state!=='active')drop(job);
        finishClose();checkDrains();
      }else{background='running';checkDrains();kick();}
      return closePromise;
    },
  };
}
