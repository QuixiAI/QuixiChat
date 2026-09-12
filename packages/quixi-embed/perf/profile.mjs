#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
const root=new URL('../',import.meta.url);
const bytes=fs.readFileSync(new URL('build/quixi-scalar-profile.wasm',root));
let memory;
const {instance}=await WebAssembly.instantiate(bytes,{env:{emscripten_notify_memory_growth(){}},wasi_snapshot_preview1:{clock_time_get(_clock,_precision,pointer){new DataView(memory.buffer).setBigUint64(pointer,process.hrtime.bigint(),true);return 0;}}});
memory=instance.exports.memory;
const e=instance.exports;e._initialize();
const status=e.malloc(4),modelBytes=fs.readFileSync(new URL('build/arctic-xs.qxmodel',root)),source=e.malloc(modelBytes.length);
new Uint8Array(e.memory.buffer,source,modelBytes.length).set(modelBytes);
const model=e.qx_model_load(source,modelBytes.length,status);if(!model)throw Error('model load');e.free(source);
const workspace=e.qx_workspace_create(512),input=e.malloc(8192),output=e.malloc(1536);
const report={version:1,host:{platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0].model,node:process.version},wasm_sha256:createHash('sha256').update(bytes).digest('hex'),warmups:5,samples:30,stages:['embedding_norm','qkv','attention','attention_output_norm','ffn_up','gelu','ffn_down_norm','pool_norm'],measurements:[]};
for(const tokens of [32,128,512]) {
 const text=new TextEncoder().encode('token '.repeat(tokens-2));new Uint8Array(e.memory.buffer,input,text.length).set(text);
 const stageSamples=[],wallSamples=[];
 for(let i=-5;i<30;i++) {const start=performance.now();if(e.qx_embed_document(model,workspace,input,text.length,output))throw Error('embed');const elapsed=performance.now()-start;if(i>=0){wallSamples.push(elapsed);stageSamples.push(report.stages.map((_,n)=>e.qx_profile_time(workspace,n)));}}
 const stageMean=report.stages.map((_,n)=>stageSamples.reduce((sum,row)=>sum+row[n],0)/30);
 report.measurements.push({tokens,wall_ms:wallSamples,stage_mean_ms:stageMean});
 console.log(JSON.stringify({tokens,stage_mean_ms:stageMean}));
 fs.writeFileSync(new URL('perf/scalar-profile.json',root),JSON.stringify(report,null,2)+'\n');
}
e.free(input);e.free(output);e.free(status);e.qx_workspace_free(workspace);e.qx_model_free(model);
