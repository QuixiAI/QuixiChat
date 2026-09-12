import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScalarEncoder } from '../src/scalar.ts';
import { createSimdEncoder, supportsWasmSimd } from '../src/simd.ts';
import { createArcticTokenizer } from '../src/tokenizer.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const route=process.argv[2]??'scalar';
assert(['scalar','simd'].includes(route));
const createEncoder=route==='simd'?createSimdEncoder:createScalarEncoder;
if(route==='simd')assert(supportsWasmSimd());
const wasm=fs.readFileSync(path.join(root,`build/quixi-${route}.wasm`));
const model=fs.readFileSync(path.join(root,'build/arctic-xs.qxmodel'));
const tokenBytes=fs.readFileSync(path.join(root,'build/arctic-xs.qxtokenizer'));
const module=new WebAssembly.Module(wasm);
assert.equal(WebAssembly.Module.exports(module).some(x=>x.name.startsWith('qx_diagnostic')||x.name.startsWith('qx_profile')),false);
assert.deepEqual(WebAssembly.Module.imports(module),[{module:'env',name:'emscripten_notify_memory_growth',kind:'function'}]);
const tokenizer=await createArcticTokenizer({wasm:module,tokenizer:tokenBytes});
assert.deepEqual([...tokenizer.tokenize('')],[101,102]);
assert.deepEqual([...tokenizer.tokenize('','query')],[101,5050,2023,6251,2005,6575,7882,13768,1024,102]);
const tokenizerMemory=tokenizer.memory();
assert(tokenizerMemory.tokenizerBytes<2*1024*1024);
const encoder=await createEncoder({wasm:module,model});
const tokens=encoder.tokenize('CAFÉ 中文 [MASK]','document');
assert.deepEqual(tokens,tokenizer.tokenize('CAFÉ 中文 [MASK]'));
const reference=encoder.embedDocument('Hello');
const initial=encoder.memory();
for(let i=0;i<20;i++) {
  assert.deepEqual(encoder.embedDocument('Hello'),reference);
  assert.deepEqual(encoder.memory(),initial);
}
const query=encoder.embedQuery('Hello');
assert.notDeepEqual(query,reference);
assert.throws(()=>encoder.embedDocuments(new Array(33).fill('x')),/at most 32/);
assert.throws(()=>encoder.embedDocument('x'.repeat(1024*1024+1)),/1 MiB/);
assert.throws(()=>tokenizer.tokenize('hello','wrong'),/role/);
let norm=0;for(const x of reference)norm+=x*x;
assert(Math.abs(Math.sqrt(norm)-1)<1e-5);
encoder.dispose();encoder.dispose();tokenizer.dispose();tokenizer.dispose();
assert.throws(()=>encoder.embedDocument('Hello'),/disposed/);
assert.throws(()=>tokenizer.tokenize('Hello'),/disposed/);
const bad=tokenBytes.slice();bad[8]=2;
await assert.rejects(createArcticTokenizer({wasm:module,tokenizer:bad}),/status 4/);
const corrupted=model.slice();corrupted[corrupted.length-1]^=1;
await assert.rejects(createEncoder({wasm:module,model:corrupted}),/integrity/);
await assert.rejects((route==='simd'?createScalarEncoder:createSimdEncoder)({wasm:module,model}),/requested backend/);
const validate=WebAssembly.validate;
try {
  WebAssembly.validate=()=>false;
  assert.equal(supportsWasmSimd(),false);
  await assert.rejects(createSimdEncoder({wasm:module,model}),/unsupported/);
} finally {WebAssembly.validate=validate;}
const result={route,passed:true,engine:'Node WebAssembly',repeated_inferences:20,model_bytes:initial.modelBytes,
  workspace_bytes:initial.workspaceBytes,linear_memory_bytes:initial.linearMemoryBytes,tokenizer_bytes:tokenizerMemory.tokenizerBytes,
  stage_hooks_in_production:false,browser_verified:false};
fs.writeFileSync(path.join(root,`build/${route}-api-report.json`),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
