#!/usr/bin/env node
// Offline measurement adapter: tokenization/embedding use the production C/WASM API.
import fs from 'node:fs';
import {createScalarEncoder} from '../src/scalar.ts';
import {createSimdEncoder} from '../src/simd.ts';
const [route,input,output]=process.argv.slice(2);
if(!['scalar','simd'].includes(route))throw Error('Unknown CPU route');
const root=new URL('../',import.meta.url),texts=JSON.parse(fs.readFileSync(input,'utf8'));
const encoder=await (route==='simd'?createSimdEncoder:createScalarEncoder)({wasm:fs.readFileSync(new URL(`build/quixi-${route}.wasm`,root)),model:fs.readFileSync(new URL('build/arctic-xs.qxmodel',root))});
const vectors=[];
try {
 const initial=encoder.memory();
 for(const [index,text] of texts.entries()) {
  const vector=text.role==='query'?encoder.embedQuery(text.text):encoder.embedDocument(text.text);
  vectors.push(Buffer.from(vector.buffer,vector.byteOffset,vector.byteLength));
  if(JSON.stringify(initial)!==JSON.stringify(encoder.memory()))throw Error('Inference memory grew');
  if(index%100===0)console.log(`${route} corpus ${index}/${texts.length}`);
 }
 fs.writeFileSync(output,Buffer.concat(vectors));
} finally {encoder.dispose();}
