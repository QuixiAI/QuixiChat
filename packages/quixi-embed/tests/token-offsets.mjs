import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createArcticTokenizer,TokenOffsetCapacityError} from '../src/tokenizer.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixturePath=process.argv[2]??path.join(root,'tests/token-offset-fixtures.jsonl');
const exhaustive=fixturePath.includes('exhaustive');
const reportPath=path.join(root,`build/token-offset-wasm${exhaustive?'-exhaustive':''}.json`);
const report={passed:false,status:'running',fixtureSha256:createHash('sha256').update(fs.readFileSync(fixturePath)).digest('hex'),routes:[]};
const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');save();
try{
  const artifact=fs.readFileSync(path.join(root,'build/arctic-xs.qxtokenizer'));
  for(const route of ['scalar','simd']){
    const wasm=fs.readFileSync(path.join(root,`build/quixi-${route}.wasm`));
    const tokenizer=await createArcticTokenizer({wasm,tokenizer:artifact});
    let cases=0,expectedCases=0,manualContributorCases=0,upstreamOffsetDivergences=0;
    try{
      const lines=readline.createInterface({input:fs.createReadStream(fixturePath),crlfDelay:Infinity});
      for await(const line of lines){
        const fixture=JSON.parse(line);if(fixture.header){expectedCases=fixture.header.cases;report.coverage=fixture.header.coverage;continue;}
        manualContributorCases+=fixture.offsetAuthority==='manual-contributors'?1:0;upstreamOffsetDivergences+=fixture.upstreamRecords?1:0;
        const result=tokenizer.tokenizeWithOffsets(fixture.text,{role:fixture.role,maxTokens:fixture.tokenCount});
        assert.equal(result.tokenCount,fixture.tokenCount);assert.equal(result.inputBytes,fixture.inputBytes);assert.equal(result.inputUtf16Units,fixture.inputUtf16Units);
        for(let i=0;i<result.tokenCount;i++)assert.deepEqual([result.ids[i],result.byteOffsets[i*2],result.byteOffsets[i*2+1],result.utf16Offsets[i*2],result.utf16Offsets[i*2+1],result.origins[i]],fixture.records.slice(i*6,i*6+6),`${route} case${cases} token${i}`);
        const inspection=tokenizer.inspect(fixture.text,fixture.role);
        assert.equal(inspection.tokenCount,Math.min(513,fixture.tokenCount));assert.equal(inspection.overflow,fixture.tokenCount>512);
        const legacy=fixture.records.filter((_,i)=>i%6===0);assert.deepEqual([...tokenizer.tokenize(fixture.text,fixture.role)],legacy.length>512?[...legacy.slice(0,511),102]:legacy);
        if(fixture.tokenCount>2)assert.throws(()=>tokenizer.tokenizeWithOffsets(fixture.text,{role:fixture.role,maxTokens:2}),error=>error instanceof TokenOffsetCapacityError&&error.capacity===2&&error.requiredTokens===fixture.tokenCount);
        assert.equal(tokenizer.memory().offsetScratchBytes,0);cases++;
      }
      assert.equal(cases,expectedCases);
      if(!exhaustive){
        for(const maxTokens of [0,1,65537,2**32,NaN,2.5])assert.throws(()=>tokenizer.tokenizeWithOffsets('',{maxTokens}),/capacity/);
        assert.throws(()=>tokenizer.tokenizeWithOffsets('a',{role:'invalid'}),/role/);
        assert.throws(()=>tokenizer.tokenizeWithOffsets('x'.repeat(1024*1024+1)),/1 MiB/);
        assert.throws(()=>tokenizer.tokenizeWithOffsets('😀'.repeat(262145)),/1 MiB/);
        assert.throws(()=>tokenizer.tokenizeWithOffsets('token '.repeat(8192)),error=>error.capacity===8192&&error.requiredTokens===8194);
        const memoryBefore=tokenizer.memory();
        let outputBytes=0;
        for(let i=0;i<128;i++){
          const result=tokenizer.tokenizeWithOffsets('.'.repeat(65534),{maxTokens:65536});
          assert.equal(result.tokenCount,65536);assert.equal(result.ids[0],101);assert.equal(result.ids[65535],102);
          outputBytes=result.ids.byteLength+result.byteOffsets.byteLength+result.utf16Offsets.byteLength+result.origins.byteLength;
          result.ids[0]=999;assert.equal(tokenizer.memory().offsetScratchBytes,0);
        }
        assert.throws(()=>tokenizer.tokenizeWithOffsets('.'.repeat(1024*1024),{maxTokens:65536}),error=>error.capacity===65536&&error.requiredTokens===1048578);
        assert.throws(()=>tokenizer.tokenizeWithOffsets('.'.repeat(1024*1024),{role:'query',maxTokens:65536}),error=>error.requiredTokens===1048586);
        for(const [text,units] of [['a'.repeat(1048576),1048576],['😀'.repeat(262144),524288]]){
          const result=tokenizer.tokenizeWithOffsets(text,{maxTokens:3});
          assert.deepEqual([...result.ids],[101,100,102]);assert.deepEqual([...result.byteOffsets],[0,0,0,1048576,0,0]);
          assert.deepEqual([...result.utf16Offsets],[0,0,0,units,0,0]);assert.equal(result.inputBytes,1048576);
        }
        assert.equal(tokenizer.memory().offsetScratchBytes,0);assert.equal(tokenizer.memory().peakOffsetScratchBytes,65536*24);
        assert.equal(tokenizer.memory().linearMemoryBytes,memoryBefore.linearMemoryBytes);
        report.resources={maxInputBytes:1048576,maxRecords:65536,nativeRecordScratchBytes:65536*24,copiedResultBytes:outputBytes,
          provenanceStackBytes:400*16,maxCapacityRepeats:128,exactMillionTokenRejectionCounts:[1048578,1048586],largeSourceOffsets:[1048576,524288]};
      }
      report.routes.push({route,cases,manualContributorCases,upstreamOffsetDivergences,wasmSha256:createHash('sha256').update(wasm).digest('hex'),memory:tokenizer.memory()});
    }finally{tokenizer.dispose();}
    assert.throws(()=>tokenizer.tokenizeWithOffsets('disposed'),/disposed/);
  }
  if(!exhaustive){
    const legacy=await createArcticTokenizer({wasm:fs.readFileSync(path.join(root,'artifacts/1.0.1/quixi-scalar.wasm')),tokenizer:artifact});
    try{assert.throws(()=>legacy.tokenizeWithOffsets('hello'),/1.0.2/);assert.equal(legacy.inspect('hello').tokenCount,3);}finally{legacy.dispose();}
  }
  report.status='passed';report.passed=true;console.log(JSON.stringify(report,null,2));
}catch(error){report.status='failed';report.error=String(error);throw error;}finally{save();}
