#!/usr/bin/env node
// GC is a test-only observation aid; production workers never request it.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createSimdEncoder } from '../src/simd.ts';
if(typeof globalThis.gc!=='function')throw Error('Run this observation with --expose-gc');
const root=new URL('../',import.meta.url);
let encoder=await createSimdEncoder({wasm:fs.readFileSync(new URL('build/quixi-simd.wasm',root)),model:fs.readFileSync(new URL('build/arctic-xs.qxmodel',root))});
const texts=['Hello','World'],references=texts.map(text=>encoder.embedDocument(text));
for(let i=0;i<100;i++)encoder.embedDocument(texts[i%2]);
globalThis.gc();
const initial=encoder.memory(),initialHeap=process.memoryUsage().heapUsed,samples=[];
for(let group=0;group<8;group++){
 for(let i=0;i<250;i++)assert.deepEqual(encoder.embedDocument(texts[i%2]),references[i%2]);
 globalThis.gc();assert.deepEqual(encoder.memory(),initial);
 const heap=process.memoryUsage().heapUsed;
 assert(heap<=initialHeap+2*1024*1024,'Retained JS heap grew across completed jobs');
 samples.push({completed_jobs:(group+1)*250,heap_used_bytes:heap,linear_memory_bytes:encoder.memory().linearMemoryBytes});
}
encoder.dispose();encoder=null;globalThis.gc();
const report={passed:true,backend:'wasm-simd-fp32',node:process.version,completed_jobs:2000,warmup_jobs:100,
  initial_memory:initial,initial_heap_used_bytes:initialHeap,retained_heap_tolerance_bytes:2*1024*1024,samples,
  scope:'WASM ownership remains exactly fixed; test-only forced GC bounds retained JS heap. Caller-retained outputs and OS RSS are outside this ownership check.'};
fs.writeFileSync(new URL('build/simd-memory-report.json',root),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
