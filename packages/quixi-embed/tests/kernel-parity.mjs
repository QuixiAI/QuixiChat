#!/usr/bin/env node
// Deterministic inputs and comparisons only; production dot arithmetic is in C.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
async function load(route){const {instance}=await WebAssembly.instantiate(fs.readFileSync(new URL(`build/kernels-${route}.wasm`,root)));instance.exports._initialize();return instance.exports;}
const scalar=await load('scalar'),simd=await load('simd');
let seed=137;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
let checks=0;
for(const count of [32,384,1536])for(const offset of [0,1,2,3])for(let trial=0;trial<100;trial++){
 const a=Float32Array.from({length:count+offset},()=>Math.fround((random()-.5)*2**(trial%17-8)));
 const b=Float32Array.from({length:count+offset},()=>Math.fround((random()-.5)*2**(8-trial%17)));
 const results=[],updated=[];
 for(const e of [scalar,simd]){const ap=e.malloc(a.byteLength),bp=e.malloc(b.byteLength);new Float32Array(e.memory.buffer,ap,a.length).set(a);new Float32Array(e.memory.buffer,bp,b.length).set(b);results.push(e.qx_test_dot(ap+offset*4,bp+offset*4,count));e.qx_test_axpy(ap+offset*4,bp+offset*4,Math.fround(.123),count);updated.push(new Uint32Array(e.memory.buffer,ap+offset*4,count).slice());e.free(ap);e.free(bp);}
 assert.equal(results[0],results[1]);assert.deepEqual(updated[0],updated[1]);checks+=2;
}
fs.writeFileSync(new URL('build/kernel-parity.json',root),JSON.stringify({passed:true,checks,kernels:['dot','weighted_value_accumulation'],widths:[32,384,1536],unaligned_float_offsets:[0,1,2,3],comparison:'Exact FP32 result identity'},null,2)+'\n');
console.log(`Passed ${checks} forced scalar/SIMD kernel comparisons`);
