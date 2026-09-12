#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {benchmark} from './benchmark.ts';
const root=new URL('../',import.meta.url),args=process.argv.slice(2);
if(args.some(value=>value.startsWith('--')&&value!=='--short'))throw Error('Unknown benchmark option');
const output=args.find(value=>!value.startsWith('--'))??new URL('build/simd-performance-node.json',root);
const lengths=args.includes('--short')?[32]:undefined;
const host={os:os.platform(),release:os.release(),architecture:os.arch(),cpu:os.cpus()[0].model,node:process.version,logical_cpus:os.cpus().length};
const startedAt=new Date().toISOString();let assets={},last={status:'running',measurements:[]};
const report=value=>{last=value;fs.writeFileSync(output,JSON.stringify({version:1,started_at:startedAt,host,assets,conditions:'Local host, uncontrolled ambient load; paired alternating routes in one process',...value},null,2)+'\n');};
report(last);
try {
 const begin=performance.now(),load=name=>new Uint8Array(fs.readFileSync(new URL('build/'+name,root)));
 const scalar=load('quixi-scalar.wasm'),simd=load('quixi-simd.wasm'),model=load('arctic-xs.qxmodel');
 assets={scalar_sha256:createHash('sha256').update(scalar).digest('hex'),simd_sha256:createHash('sha256').update(simd).digest('hex'),model_sha256:createHash('sha256').update(model).digest('hex'),asset_read_ms:performance.now()-begin};
 const result=await benchmark({scalar,simd,model,lengths,progress(value){report(value);const row=value.measurements.at(-1);if(row)console.log(JSON.stringify({batch:row.batch,tokens:row.tokens,speedup:row.speedup,scalar_ms:row.scalar.median_ms,simd_ms:row.simd.median_ms}));}});report(result);
}catch(error){report({...last,status:'failed',error:String(error)});throw error;}
