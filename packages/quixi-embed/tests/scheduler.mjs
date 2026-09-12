import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {test} from 'node:test';
import {createEmbeddingScheduler,SchedulerError,embeddingIdentityKey} from '../src/scheduler/scheduler.ts';
const identity={modelHash:'model',artifactHash:'artifact',tokenizerVersion:'tokenizer',preprocessingVersion:'prefix-v1',chunkingVersion:'chunks-v1',queryPrefix:'query: '};
const vector=role=>{const value=new Float32Array(384);value[role==='query'?1:0]=1;return value;};
const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
async function until(condition){for(let i=0;i<200;i++){if(condition())return;await turn();}throw Error('Scheduler made no bounded progress');}
function controlled(kind='gpu'){
  const calls=[];let disposed=0;
  return{calls,get disposed(){return disposed;},route:kind==='gpu'?'webgpu-fp32':'wasm-simd-fp32',kind,maxBatch:4,maxTokens:512,maxPaddedTokens:2048,
    inspect(text,role){return{tokenCount:text.startsWith('n:')?Number(text.slice(2)):2+text.length+(role==='query'?8:0),overflow:text==='n:513',inputSha256:createHash('sha256').update(text).digest('hex')};},
    execute(texts,role){return new Promise((resolve,reject)=>calls.push({texts:[...texts],role,resolve:()=>resolve(texts.map(()=>vector(role))),reject}));},
    recoverable:error=>error?.code==='lost',dispose(){disposed++;}};
}
function submit(s,text,extra={}){const ticket=s.submit({text,role:'document',priority:4,...extra});ticket.result.catch(()=>{});return ticket;}
function setup(t,options={}){const executor=options.executor??controlled();const scheduler=createEmbeddingScheduler({identity,executor,...options});t.after(()=>scheduler.shutdown());return{executor,scheduler};}

test('P0 promotion, independent joiner cancellation and one active batch',async t=>{
  const {executor:e,scheduler:s}=setup(t,{limits:{backgroundBatch:1}});
  const first=submit(s,'first');await until(()=>e.calls.length===1);
  const ordinary=submit(s,'ordinary'),low=submit(s,'promoted'),high=submit(s,'promoted',{priority:0});
  low.cancel();await assert.rejects(low.result,error=>error.code==='cancelled');
  assert.equal(e.calls.length,1);e.calls[0].resolve();await first.result;
  await until(()=>e.calls.length===2);assert.deepEqual(e.calls[1].texts,['promoted']);e.calls[1].resolve();
  const value=await high.result;assert.equal(value.shared,true);
  await until(()=>e.calls.length===3);assert.deepEqual(e.calls[2].texts,['ordinary']);e.calls[2].resolve();await ordinary.result;
  assert.equal(s.statistics().singleflightJoins,1);
});

test('padded token budget controls dynamic batches',async t=>{
  const {executor:e,scheduler:s}=setup(t,{limits:{maxPaddedTokens:512}});
  const tickets=[100,120,200,300].map(n=>submit(s,'n:'+n));
  await until(()=>e.calls.length===1);assert.deepEqual(e.calls[0].texts,['n:100','n:120']);e.calls[0].resolve();
  await until(()=>e.calls.length===2);assert.deepEqual(e.calls[1].texts,['n:200']);e.calls[1].resolve();
  await until(()=>e.calls.length===3);assert.deepEqual(e.calls[2].texts,['n:300']);e.calls[2].resolve();await Promise.all(tickets.map(x=>x.result));
});

test('CPU dispatch yields a task before selecting the next background item',async t=>{
  const e=controlled('cpu'),order=[];e.execute=(texts,role)=>{order.push(texts[0]);if(order.length===1)setTimeout(()=>submit(s,'interactive',{priority:0}),0);return texts.map(()=>vector(role));};
  const {scheduler:s}=setup(t,{executor:e});const a=submit(s,'a'),b=submit(s,'b');await Promise.all([a.result,b.result]);
  assert.deepEqual(order,['a','interactive','b']);assert.equal(s.statistics().activeRequests,0);
});

test('pause, background drain and interactive admission',async t=>{
  const {executor:e,scheduler:s}=setup(t);s.pauseBackground();const bg=submit(s,'background');await turn();assert.equal(e.calls.length,0);
  const q=submit(s,'q',{priority:0,role:'query'});await until(()=>e.calls.length===1);assert.equal(e.calls[0].role,'query');e.calls[0].resolve();await q.result;
  const drain=s.drainBackground();const rejected=submit(s,'late');await assert.rejects(rejected.result,error=>error.code==='background-draining');
  await until(()=>e.calls.length===2);const later=submit(s,'next query',{priority:0,role:'query'});e.calls[1].resolve();await bg.result;await drain;
  assert.equal(s.statistics().background,'paused');await until(()=>e.calls.length===3);e.calls[2].resolve();await later.result;
});

test('job, consumer, joiner, input, admitted byte and token bounds',async t=>{
  const {scheduler:s}=setup(t,{limits:{maxJobs:2,maxConsumers:3,maxConsumersPerJob:2,maxInputBytes:32,maxAdmittedBytes:7000}});s.pauseBackground();
  const a=submit(s,'a'),join=submit(s,'a');await assert.rejects(submit(s,'a').result,e=>e.code==='saturated');
  const b=submit(s,'b');await assert.rejects(submit(s,'c').result,e=>e.code==='saturated');assert.equal(s.statistics().consumers,3);
  a.cancel();join.cancel();b.cancel();assert.equal(s.statistics().admittedBytes,0);
  await assert.rejects(submit(s,'x'.repeat(33)).result,e=>e.code==='oversized');
  await assert.rejects(submit(s,'😀'.repeat(9)).result,e=>e.code==='oversized');
  await assert.rejects(submit(s,'n:513').result,e=>e.code==='oversized');
  const valid=submit(s,'n:512');assert.equal(s.statistics().jobs,1);valid.cancel();
  const tiny=createEmbeddingScheduler({identity,executor:controlled(),limits:{maxAdmittedBytes:1}});t.after(()=>tiny.shutdown());await assert.rejects(submit(tiny,'a').result,e=>e.code==='saturated');
});

test('bounded copied cache, exact UTF8 identity and role/identity separation',async t=>{
  const e=controlled('cpu');let inferences=0;e.execute=(texts,role)=>{inferences+=texts.length;return texts.map(()=>vector(role));};
  const {scheduler:s}=setup(t,{executor:e,limits:{maxCacheEntries:2,maxCacheBytes:8000}});
  const first=await submit(s,'hello').result;first.vector[0]=0;
  const again=await submit(s,'hello').result;assert(again.cacheHit);assert.equal(again.vector[0],1);assert.equal(inferences,1);
  const query=await submit(s,'hello',{role:'query',priority:0}).result;assert.equal(query.vector[1],1);assert.equal(inferences,2);
  for(let i=0;i<30;i++)await submit(s,'text'+i).result;
  assert(s.statistics().cacheEntries<=2);assert(s.statistics().cacheBytes<=8000);
  const a=submit(s,'\ud800'),b=submit(s,'\ufffd');await Promise.all([a.result,b.result]);assert.equal((await b.result).shared,true);
  await assert.rejects(submit(s,'hello',{identity:{...identity,modelHash:'another'}}).result,e=>e.code==='invalid');
  s.clearCache();assert.equal(s.statistics().cacheBytes,0);
});

test('background aging preserves FIFO fairness below P0',async t=>{
  const {executor:e,scheduler:s}=setup(t,{limits:{backgroundBatch:1,backgroundAgingDispatches:1}});
  const old=submit(s,'old archive');const rest=['a','b','c','d'].map(text=>submit(s,text,{priority:1}));
  for(let i=0;i<5;i++){await until(()=>e.calls.length===i+1);if(i===3)assert.deepEqual(e.calls[i].texts,['old archive']);e.calls[i].resolve();}
  await Promise.all([old,...rest].map(x=>x.result));
});

test('GPU loss requeues on CPU; new P0 outranks the failed background batch',async t=>{
  const gpu=controlled(),cpu=controlled('cpu');let finishFallback;const fallback=new Promise(resolve=>{finishFallback=resolve;});
  const {scheduler:s}=setup(t,{executor:gpu,preflight:gpu.inspect,fallback:()=>fallback,limits:{backgroundBatch:1}});
  const bg=submit(s,'background');await until(()=>gpu.calls.length===1);gpu.calls[0].reject({code:'lost'});await until(()=>s.statistics().state==='switching');
  const q=submit(s,'query',{priority:0,role:'query'});finishFallback(cpu);
  await until(()=>cpu.calls.length===1);assert.equal(cpu.calls[0].role,'query');cpu.calls[0].resolve();await q.result;
  await until(()=>cpu.calls.length===2);cpu.calls[1].resolve();assert.equal((await bg.result).route,'wasm-simd-fp32');assert.equal(gpu.disposed,1);assert.equal(s.statistics().fallbacks,1);
});

test('cancelled active output cannot be cached or published; shutdown is idempotent',async t=>{
  const {executor:e,scheduler:s}=setup(t);const ticket=submit(s,'abandoned');await until(()=>e.calls.length===1);
  ticket.cancel();await assert.rejects(ticket.result,e=>e.code==='cancelled');e.calls[0].resolve();await until(()=>s.statistics().jobs===0);
  assert.equal(s.statistics().cacheEntries,0);const active=submit(s,'shutdown');await until(()=>e.calls.length===2);
  await s.shutdown();await assert.rejects(active.result,e=>e.code==='cancelled');e.calls[1].resolve();await turn();await s.shutdown();assert.equal(e.disposed,1);
  assert.equal(s.statistics().jobs,0);await assert.rejects(submit(s,'closed').result,e=>e.code==='closed');
});

test('hanging private storage retains bounded actual permits and never blocks inference',async t=>{
  const e=controlled('cpu');e.execute=(texts,role)=>texts.map(()=>vector(role));const pending=[];
  const store={get:key=>new Promise(resolve=>pending.push(resolve)),put:async()=>{throw Error('should be capacity-limited');}};
  const {scheduler:s}=setup(t,{executor:e,cacheStore:store,limits:{maxStoreOperations:2,maxStoreBytes:8192,storeTimeoutMs:5}});
  await Promise.all(Array.from({length:20},(_,i)=>submit(s,'request'+i).result));
  assert.equal(pending.length,2);assert.equal(s.statistics().storeOperations,2);assert(s.statistics().storeBytes<=8192);
  pending.forEach(resolve=>resolve(null));await until(()=>s.statistics().storeOperations===0);assert.equal(s.statistics().jobs,0);
});

test('stored cache is copied and corrupt records/errors are misses',async t=>{
  const e=controlled('cpu');let executed=0;e.execute=(texts,role)=>{executed+=texts.length;return texts.map(()=>vector(role));};
  let stored={identityKey:embeddingIdentityKey(identity),role:'document',route:'wasm-simd-fp32',vector:vector('document')};
  const {scheduler:s}=setup(t,{executor:e,cacheStore:{get:async()=>stored,put:async()=>{}},onEvent(){throw Error('observer');}});
  const hit=await submit(s,'cached').result;assert(hit.cacheHit);stored.vector[0]=0;assert.equal(hit.vector[0],1);assert.equal(executed,0);
  await submit(s,'corrupt').result;assert.equal(executed,1);
  stored=new Proxy({},{get(){throw Error('corrupt getter');}});await submit(s,'throws').result;assert.equal(executed,2);
});

test('snapshot drain does not wait for later submissions; execution failure disables backend',async t=>{
  const {executor:e,scheduler:s}=setup(t,{limits:{backgroundBatch:1}});const first=submit(s,'first');const drain=s.drain();
  await until(()=>e.calls.length===1);const second=submit(s,'second');e.calls[0].resolve();await first.result;await drain;
  await until(()=>e.calls.length===2);e.calls[1].reject(Error('backend failed'));await assert.rejects(second.result,error=>error instanceof SchedulerError&&error.code==='backend');
  assert.equal(s.statistics().state,'unavailable');await assert.rejects(submit(s,'future').result,e=>e.code==='backend');
});

test('document throughput includes task yields and owner ETA is explicitly scoped',async t=>{
  let time=0;const e=controlled('cpu');e.execute=(texts,role)=>{time+=10;return texts.map(()=>vector(role));};
  const {scheduler:s}=setup(t,{executor:e,now:()=>time,yieldTask:()=>{time+=5;return turn();}});
  await Promise.all([submit(s,'a').result,submit(s,'b').result]);
  assert(Math.abs(s.statistics().recentChunksPerSecond-2000/30)<1e-9);
  assert.equal(s.statistics().etaScope,'admitted-documents');
  assert.equal(s.statistics(100).etaScope,'owner-document-estimate');assert.equal(s.statistics(100).estimatedRemainingSeconds,1.5);
  s.pauseBackground();assert.equal(s.statistics(100).estimatedRemainingSeconds,null);
  assert.throws(()=>s.statistics(-1),error=>error.code==='invalid');
});

test('nonfinite/nonunit model output is never published or cached',async t=>{
  const e=controlled('cpu');e.execute=()=>[new Float32Array(384)];const {scheduler:s}=setup(t,{executor:e});
  await assert.rejects(submit(s,'bad output').result,error=>error.code==='backend');
  assert.equal(s.statistics().completed,0);assert.equal(s.statistics().cacheEntries,0);assert.equal(s.statistics().state,'unavailable');
});

test('cancellation during asynchronous fallback disposes the late CPU instance',async t=>{
  const gpu=controlled(),cpu=controlled('cpu');let resolve;const pending=new Promise(done=>{resolve=done;});
  const {scheduler:s}=setup(t,{executor:gpu,preflight:gpu.inspect,fallback:()=>pending});const ticket=submit(s,'pending');
  await until(()=>gpu.calls.length===1);gpu.calls[0].reject({code:'lost'});await until(()=>s.statistics().state==='switching');
  await s.shutdown();await assert.rejects(ticket.result,error=>error.code==='cancelled');resolve(cpu);await until(()=>cpu.disposed===1);
  assert.equal(cpu.calls.length,0);assert.equal(s.statistics().state,'closed');assert.equal(s.statistics().completed,0);
});

test('sustained backfill and duplicate flood stay within every admission/cache bound',async t=>{
  const e=controlled('cpu');e.execute=(texts,role)=>texts.map(()=>vector(role));
  const limits={maxJobs:32,maxConsumers:64,maxConsumersPerJob:4,maxAdmittedBytes:128*1024,maxCacheEntries:16,maxCacheBytes:40*1024};
  const peaks={jobs:0,consumers:0,admittedBytes:0,cacheEntries:0,cacheBytes:0};
  const observe=statistics=>{for(const key of Object.keys(peaks))peaks[key]=Math.max(peaks[key],statistics[key]);
    assert(statistics.jobs<=limits.maxJobs);assert(statistics.consumers<=limits.maxConsumers);assert(statistics.admittedBytes<=limits.maxAdmittedBytes);
    assert(statistics.cacheEntries<=limits.maxCacheEntries);assert(statistics.cacheBytes<=limits.maxCacheBytes);};
  // A microtask yield makes this controlled-executor resource test fast; actual task yielding has its own test.
  const {scheduler:s}=setup(t,{executor:e,limits,yieldTask:()=>Promise.resolve()});
  for(let wave=0;wave<160;wave++){
    const tickets=Array.from({length:32},(_,i)=>submit(s,`backfill-${wave}-${i}`));observe(s.statistics());
    await assert.rejects(submit(s,`overflow-${wave}`).result,error=>error.code==='saturated');
    await Promise.all(tickets.map(ticket=>ticket.result));observe(s.statistics());
  }
  s.pauseBackground();const accepted=Array.from({length:4},()=>submit(s,'duplicate-flood'));
  const rejected=Array.from({length:5000},()=>submit(s,'duplicate-flood').result.catch(error=>error.code));
  assert((await Promise.all(rejected)).every(code=>code==='saturated'));observe(s.statistics());
  assert.equal(s.statistics().jobs,1);assert.equal(s.statistics().consumers,4);
  s.resumeBackground();await Promise.all(accepted.map(ticket=>ticket.result));
  assert.equal(s.statistics().inferred,5121);assert.equal(s.statistics().singleflightJoins,3);
  assert.equal(s.statistics().jobs,0);assert.equal(s.statistics().consumers,0);assert.equal(s.statistics().admittedBytes,0);
  assert.equal(peaks.jobs,32);assert.equal(peaks.cacheEntries,16);
  const output=new URL('../build/scheduler-resource-report.json',import.meta.url);
  fs.mkdirSync(new URL('../build/',import.meta.url),{recursive:true});
  fs.writeFileSync(output,JSON.stringify({passed:true,executor:'deterministic CPU substitute; no hardware performance claim',
    uniqueBackfillJobs:5120,duplicateConsumersAdmitted:4,duplicateConsumersRejected:5000,jobCapacityRejections:160,
    actualInferences:s.statistics().inferred,limits,peaks,final:s.statistics()},null,2)+'\n');
});

test('shutdown drain finishes paused work and rejects new admission without losing outputs',async t=>{
  const {executor:e,scheduler:s}=setup(t,{limits:{backgroundBatch:1}});s.pauseBackground();
  const first=submit(s,'first'),second=submit(s,'second'),closed=s.shutdown('drain');
  await assert.rejects(submit(s,'new').result,error=>error.code==='closed');
  for(let i=0;i<2;i++){await until(()=>e.calls.length===i+1);assert.equal(e.disposed,0);e.calls[i].resolve();}
  await Promise.all([first.result,second.result,closed]);assert.equal(s.statistics().completed,2);assert.equal(s.statistics().state,'closed');assert.equal(e.disposed,1);
});

test('cancelled cache lookup cannot publish its late hit and drain observers are bounded',async t=>{
  const e=controlled();let finish;const {scheduler:s}=setup(t,{executor:e,cacheStore:{get:()=>new Promise(resolve=>{finish=resolve;}),put:async()=>{}},limits:{storeTimeoutMs:5}});
  const ticket=submit(s,'lookup');await until(()=>!!finish);
  const observers=Array.from({length:64},()=>s.drain());await assert.rejects(s.drain(),error=>error.code==='saturated');
  ticket.cancel();await Promise.all(observers);await assert.rejects(ticket.result,error=>error.code==='cancelled');
  finish({identityKey:embeddingIdentityKey(identity),role:'document',route:e.route,vector:vector('document')});
  await until(()=>s.statistics().jobs===0);assert.equal(e.calls.length,0);assert.equal(s.statistics().cacheEntries,0);assert.equal(s.statistics().completed,0);
});
