#!/usr/bin/env node
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url),wasm=fs.readFileSync(new URL('build/quixi-simd-memory.wasm',root));
const {instance}=await WebAssembly.instantiate(wasm,{env:{emscripten_notify_memory_growth(){}}});
const e=instance.exports;e._initialize();assert.equal(e.qx_backend(),1);
const samples=[];
function observe(phase){const value={phase,allocator_live_bytes:e.qx_heap_usage(),linear_memory_bytes:e.memory.buffer.byteLength};samples.push(value);return value;}
const bootstrap=e.malloc(16);assert(bootstrap);e.free(bootstrap);
const initial=observe('allocator_initialized'),status=e.malloc(4);
const modelBytes=fs.readFileSync(new URL('build/arctic-xs.qxmodel',root)),inputModel=e.malloc(modelBytes.length);
new Uint8Array(e.memory.buffer,inputModel,modelBytes.length).set(modelBytes);observe('model_input');
const model=e.qx_model_load(inputModel,modelBytes.length,status);assert(model);assert.equal(new DataView(e.memory.buffer).getUint32(status,true),0);
const loaded=observe('model_validated_and_copied');assert(loaded.allocator_live_bytes>=2*modelBytes.length);e.free(inputModel);observe('model_input_released');
const workspace=e.qx_workspace_create(512);assert(workspace);observe('workspace_reserved');
const input=e.malloc(1024*1024),ids=e.malloc(512*4),output=e.malloc(384*4);observe('all_binding_scratch_reserved');
const text=new TextEncoder().encode('Hello');new Uint8Array(e.memory.buffer,input,text.length).set(text);
const steady=observe('before_inference');
assert(steady.allocator_live_bytes>=e.qx_model_bytes(model)+e.qx_workspace_bytes(workspace)+1024*1024);
for(let i=0;i<20;i++){assert.equal(e.qx_embed_document(model,workspace,input,text.length,output),0);assert.equal(e.qx_heap_usage(),steady.allocator_live_bytes);assert.equal(e.memory.buffer.byteLength,steady.linear_memory_bytes);}
observe('after_20_inferences');
e.qx_workspace_free(workspace);e.qx_model_free(model);for(const pointer of [input,ids,output,status])e.free(pointer);
const final=observe('disposed');assert.equal(final.allocator_live_bytes,initial.allocator_live_bytes);
const report={passed:true,backend:'wasm-simd-fp32',node:process.version,wasm_sha256:createHash('sha256').update(wasm).digest('hex'),
  allocator_peak_bytes:Math.max(...samples.map(value=>value.allocator_live_bytes)),linear_memory_peak_bytes:Math.max(...samples.map(value=>value.linear_memory_bytes)),
  steady_allocator_bytes:steady.allocator_live_bytes,samples,
  scope:'C allocator live/peak bytes and retained WASM pages, observed at monotonic initialization phases. Source inspection establishes no transient forward allocations. The production-source probe has one additional observation export; it is not a timing artifact.'};
fs.writeFileSync(new URL('build/simd-allocator-report.json',root),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
