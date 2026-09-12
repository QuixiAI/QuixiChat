import {createArcticTokenizer,TokenOffsetCapacityError} from '../../src/tokenizer.ts';
interface Fixture {text:string;role:'document'|'query';tokenCount:number;inputBytes:number;inputUtf16Units:number;records:number[]}
const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
self.onmessage=({data})=>void main(data.route).then(result=>self.postMessage({result}),error=>self.postMessage({result:{passed:false,error:String(error),stack:error.stack}}));
async function main(route:'scalar'|'simd'){
  const [wasm,artifact,fixtures]=await Promise.all([
    fetch(`/build/quixi-${route}.wasm`).then(r=>r.arrayBuffer()),
    fetch('/build/arctic-xs.qxtokenizer').then(r=>r.arrayBuffer()),
    fetch('/tests/token-offset-fixtures.jsonl').then(r=>r.text())]);
  const tokenizer=await createArcticTokenizer({wasm,tokenizer:new Uint8Array(artifact)});
  const before=tokenizer.memory();let cases=0,expectedCases=0,manualContributorCases=0,upstreamOffsetDivergences=0;
  try{
    for(const line of fixtures.trimEnd().split('\n')){
      const value=JSON.parse(line);if(value.header){expectedCases=value.header.cases;continue;}
      manualContributorCases+=value.offsetAuthority==='manual-contributors'?1:0;upstreamOffsetDivergences+=value.upstreamRecords?1:0;
      const fixture=value as Fixture,result=tokenizer.tokenizeWithOffsets(fixture.text,{role:fixture.role,maxTokens:fixture.tokenCount});
      assert(result.tokenCount===fixture.tokenCount&&result.inputBytes===fixture.inputBytes&&result.inputUtf16Units===fixture.inputUtf16Units,'Count/source-unit mismatch');
      for(let i=0;i<result.tokenCount;i++){
        const row=[result.ids[i],result.byteOffsets[i*2],result.byteOffsets[i*2+1],result.utf16Offsets[i*2],result.utf16Offsets[i*2+1],result.origins[i]];
        assert(row.every((value,column)=>value===fixture.records[i*6+column]),`Offset mismatch case ${cases} token ${i}`);
      }
      if(fixture.tokenCount>2){
        try{tokenizer.tokenizeWithOffsets(fixture.text,{role:fixture.role,maxTokens:2});throw Error('Capacity silently truncated');}
        catch(error){assert(error instanceof TokenOffsetCapacityError&&error.capacity===2&&error.requiredTokens===fixture.tokenCount,'Incorrect exact rejection count');}
      }
      assert(tokenizer.memory().offsetScratchBytes===0,'Scratch allocation survived completion');cases++;
    }
    assert(cases===expectedCases,'Incomplete fixture set');let resultBytes=0;
    for(let repeat=0;repeat<32;repeat++){
      const result=tokenizer.tokenizeWithOffsets('.'.repeat(65534),{maxTokens:65536});
      assert(result.tokenCount===65536&&result.ids[0]===101&&result.ids[65535]===102,'Maximum record result mismatch');
      resultBytes=result.ids.byteLength+result.byteOffsets.byteLength+result.utf16Offsets.byteLength+result.origins.byteLength;result.ids[0]=999;
    }
    assert(tokenizer.tokenizeWithOffsets('').ids[0]===101,'Returned array aliases native output');
    for(const role of ['document','query'] as const){
      try{tokenizer.tokenizeWithOffsets('.'.repeat(1048576),{role,maxTokens:65536});throw Error('Million-token overflow accepted');}
      catch(error){assert(error instanceof TokenOffsetCapacityError&&error.capacity===65536&&error.requiredTokens===(role==='query'?1048586:1048578),'Wrong full required count');}
    }
    for(const [text,units] of [['a'.repeat(1048576),1048576],['😀'.repeat(262144),524288]] as const){
      const result=tokenizer.tokenizeWithOffsets(text,{maxTokens:3});
      assert(result.tokenCount===3&&result.ids[1]===100&&result.byteOffsets[2]===0&&result.byteOffsets[3]===1048576&&result.utf16Offsets[2]===0&&result.utf16Offsets[3]===units,'Large source offset overflow');
    }
    const after=tokenizer.memory();assert(after.offsetScratchBytes===0&&after.peakOffsetScratchBytes===1572864,'Scratch bound');
    assert(before.linearMemoryBytes===after.linearMemoryBytes&&after.linearMemoryBytes===16777216,'Standalone WASM grew');
    tokenizer.dispose();let disposedRejected=false;
    try{tokenizer.tokenizeWithOffsets('closed');}catch{disposedRejected=true;}assert(disposedRejected,'Disposed tokenizer accepted input');
    return{passed:true,route,cases,manualContributorCases,upstreamOffsetDivergences,maxCapacityRepeats:32,resultBytes,before,after,exactMillionTokenRejection:true,
      originalUtf8AndUtf16Parity:true,overlappingSpansIncluded:true,modelWeightsRequired:false};
  }finally{tokenizer.dispose();}
}
