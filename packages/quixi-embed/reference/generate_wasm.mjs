#!/usr/bin/env node
// Every calculation uses the C scalar WASM module. JS only transfers typed data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2] ?? path.join(root, 'build/wasm-raw');
const route = process.argv[3] ?? 'scalar';
if (!['scalar', 'simd'].includes(route)) throw Error('Expected scalar or simd route');
const wasmPath = path.join(root, `build/quixi-${route}-diagnostic.wasm`);
const modelPath = path.join(root, 'build/arctic-xs.qxmodel');
const golden = JSON.parse(fs.readFileSync(path.join(root, 'tests/goldens/manifest.json'), 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const moduleBytes = fs.readFileSync(wasmPath);
const { instance } = await WebAssembly.instantiate(moduleBytes, {env: {emscripten_notify_memory_growth() {}}});
const e = instance.exports;
e._initialize();
if (typeof e.qx_backend !== 'function' || e.qx_backend() !== (route === 'simd' ? 1 : 0)) throw Error('CPU route identity');
const buffers = [];
function alloc(n) {const p=e.malloc(n);if(!p) throw Error('WASM allocation');buffers.push(p);return p;}
function check(status) {if(status) throw Error(`WASM status ${status}`);}
function copy(array, pointer) {new Uint8Array(e.memory.buffer,pointer,array.byteLength).set(new Uint8Array(array.buffer,array.byteOffset,array.byteLength));}
const status=alloc(4);
const modelBytes=fs.readFileSync(modelPath);
const modelInput=alloc(modelBytes.length);copy(modelBytes,modelInput);
const model=e.qx_model_load(modelInput,modelBytes.length,status);
check(new Uint32Array(e.memory.buffer,status,1)[0]);
e.free(modelInput);buffers.splice(buffers.indexOf(modelInput),1);
const workspace=e.qx_workspace_create(512);if(!workspace) throw Error('workspace allocation');
const input=alloc(1024*1024),idsPointer=alloc(512*4),maskPointer=alloc(512*4),vectorPointer=alloc(384*4);
const encoder=new TextEncoder();
const manifest={version:1,source:golden.source,backend:{route:`wasm-${route}-fp32`,wasm_sha256:hash(moduleBytes),model_sha256:hash(modelBytes)},cases:[]};
fs.mkdirSync(output,{recursive:true});
const begin=performance.now();
try {
  for(let index=0;index<golden.cases.length;index++) {
    const test=golden.cases[index];
    const tokenized=test.texts.map(text=>{
      const bytes=encoder.encode(text);if(bytes.length>1024*1024) throw Error('input limit');
      copy(bytes,input);check(e.qx_tokenize(model,input,bytes.length,test.role==='query'?1:0,idsPointer,status));
      const count=new Uint32Array(e.memory.buffer,status,1)[0];
      return new Uint32Array(e.memory.buffer,idsPointer,count).slice();
    });
    const batch=tokenized.length,tokens=Math.max(...tokenized.map(ids=>ids.length));
    const arrays={input_ids:new Uint32Array(batch*tokens),attention_mask:new Uint32Array(batch*tokens),
      token_type_ids:new Uint32Array(batch*tokens),pooled:new Float32Array(batch*384),vectors:new Float32Array(batch*384)};
    if(test.stages) for(let stage=0;stage<7;stage++) arrays[`stage_${stage}`]=new Float32Array(batch*tokens*384);
    for(let row=0;row<batch;row++) {
      arrays.input_ids.set(tokenized[row],row*tokens);arrays.attention_mask.fill(1,row*tokens,row*tokens+tokenized[row].length);
      copy(arrays.input_ids.subarray(row*tokens,(row+1)*tokens),idsPointer);
      copy(arrays.attention_mask.subarray(row*tokens,(row+1)*tokens),maskPointer);
      check(e.qx_embed_tokens(model,workspace,idsPointer,maskPointer,tokens,vectorPointer));
      arrays.vectors.set(new Float32Array(e.memory.buffer,vectorPointer,384),row*384);
      arrays.pooled.set(new Float32Array(e.memory.buffer,e.qx_diagnostic_pooled(workspace),384),row*384);
      if(test.stages) for(let stage=0;stage<7;stage++)
        arrays[`stage_${stage}`].set(new Float32Array(e.memory.buffer,e.qx_diagnostic_stage(workspace,stage),tokens*384),row*tokens*384);
    }
    const pieces=[],metadata={};let offset=0;
    for(const [name,array] of Object.entries(arrays)) {
      const bytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength);pieces.push(bytes);
      metadata[name]={offset,bytes:bytes.length,dtype:array instanceof Uint32Array?'uint32':'float32',shape:test.arrays[name].shape};offset+=bytes.length;
    }
    const bytes=Buffer.concat(pieces),file=test.id+'.bin';fs.writeFileSync(path.join(output,file),bytes);
    manifest.cases.push({...test,file,sha256:hash(bytes),raw_arrays:metadata});
    fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest));
    if(index%5===0||index+1===golden.cases.length) console.log(`${index+1}/${golden.cases.length} ${test.id} elapsed=${((performance.now()-begin)/1000).toFixed(1)}s`);
  }
  manifest.model_bytes=e.qx_model_bytes(model);manifest.workspace_bytes=e.qx_workspace_bytes(workspace);
  manifest.linear_memory_bytes=e.memory.buffer.byteLength;manifest.elapsed_seconds=(performance.now()-begin)/1000;
  fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest));
} finally {
  e.qx_workspace_free(workspace);e.qx_model_free(model);for(const pointer of buffers)e.free(pointer);
}
