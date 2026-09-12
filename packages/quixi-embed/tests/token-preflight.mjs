import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createArcticTokenizer} from '../src/tokenizer.ts';
import {createScalarEncoder} from '../src/scalar.ts';
import {createSimdEncoder} from '../src/simd.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtures=JSON.parse(fs.readFileSync(path.join(root,'tests/token-preflight-fixtures.json')));
const tokenizer=fs.readFileSync(path.join(root,'build/arctic-xs.qxtokenizer')),model=fs.readFileSync(path.join(root,'build/arctic-xs.qxmodel'));
const routes=[];
for(const route of ['scalar','simd']){
  const wasm=fs.readFileSync(path.join(root,`build/quixi-${route}.wasm`));
  const standalone=await createArcticTokenizer({wasm,tokenizer});
  const encoder=await(route==='simd'?createSimdEncoder:createScalarEncoder)({wasm,model});
  try{
    for(const fixture of fixtures.cases){
      const expected={tokenCount:fixture.tokenCount,overflow:fixture.overflow,inputSha256:fixture.inputSha256};
      assert.deepEqual(standalone.inspect(fixture.text,fixture.role),expected);
      assert.deepEqual(encoder.inspect(fixture.text,fixture.role),expected);
      assert.deepEqual([...standalone.tokenize(fixture.text,fixture.role)],fixture.ids);
      assert.deepEqual([...encoder.tokenize(fixture.text,fixture.role)],fixture.ids);
    }
    assert.deepEqual(standalone.inspect('\ud800'),standalone.inspect('\ufffd'));
    assert.throws(()=>standalone.inspect('hello','invalid'),/role/);
    assert.throws(()=>encoder.inspect('😀'.repeat(300000),'document'),/1 MiB/);
    routes.push({route,cases:fixtures.cases.length,standalone_and_model:true,legacy_truncated_ids_preserved:true});
  }finally{standalone.dispose();encoder.dispose();}
}
const legacy=await createArcticTokenizer({wasm:fs.readFileSync(path.join(root,'artifacts/1.0.0/quixi-scalar.wasm')),tokenizer});
try{assert.throws(()=>legacy.inspect('hello'),/1.0.1/);assert.deepEqual([...legacy.tokenize('')],[101,102]);}finally{legacy.dispose();}
const artifactVersion=JSON.parse(fs.readFileSync(path.join(root,'build/quixi-scalar.wasm.json'))).artifact_version;
const report={passed:true,artifactVersion,routes,untruncated_reference:true,legacy_inspection_rejected:true};
fs.writeFileSync(path.join(root,'build/token-preflight-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
