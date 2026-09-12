#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {chromium,firefox,webkit} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const requested=process.argv[2]??'chromium';
if(!['chromium','firefox','webkit','all'].includes(requested))throw Error('Expected chromium, firefox, webkit or all');
const engines=requested==='all'?{chromium,firefox,webkit}:{[requested]:{chromium,firefox,webkit}[requested]};
const short=process.argv.includes('--short');
const outputOption=process.argv.indexOf('--output-dir');
if(outputOption>=0&&(!process.argv[outputOption+1]||process.argv[outputOption+1].startsWith('--')))throw Error('Expected --output-dir path');
const outputDirectory=outputOption>=0?path.resolve(process.argv[outputOption+1]):path.join(root,'build');
fs.mkdirSync(outputDirectory,{recursive:true});
const states={},versions={},startedAt=new Date().toISOString();let assets={},server;
function save(name,value){
 states[name]=value;
 const metadata={version:1,started_at:startedAt,host:{os:os.platform(),release:os.release(),architecture:os.arch(),cpu:os.cpus()[0].model,browser:name,browser_version:versions[name]??null},assets,
  conditions:'Dedicated worker; WebGPU API disabled; local host with uncontrolled ambient load; alternating paired routes'};
 const output=path.join(outputDirectory,`simd-performance-${name}${short?'-short':''}.json`);
 const temporary=output+'.tmp';fs.writeFileSync(temporary,JSON.stringify({...metadata,...value},null,2)+'\n');fs.renameSync(temporary,output);
}
// Invalidate prior successes before asset reads, server startup or browser launch.
for(const name of Object.keys(engines))save(name,{status:'running',measurements:[]});
try {
 const hash=file=>createHash('sha256').update(fs.readFileSync(path.join(root,'build',file))).digest('hex');
 assets={scalar_sha256:hash('quixi-scalar.wasm'),simd_sha256:hash('quixi-simd.wasm'),model_sha256:hash('arctic-xs.qxmodel')};
 server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
 for(const [name,type] of Object.entries(engines)){
  let browser;
  try {
   browser=await type.launch();versions[name]=browser.version();save(name,states[name]);
   const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/perf/browser.html${short?'?short':''}`);
   let completed=false,count=0;const deadline=Date.now()+4*60*60*1000;
   while(!completed){
    if(Date.now()>deadline)throw Error('Four-hour benchmark deadline');
    await page.waitForTimeout(2000);
    const state=await page.evaluate(()=>({value:window.quixiBenchmark,completed:window.quixiComplete}));completed=state.completed;save(name,state.value);
    if((state.value.measurements?.length??0)>count){count=state.value.measurements.length;const last=state.value.measurements.at(-1);console.log(JSON.stringify({engine:name,batch:last.batch,tokens:last.tokens,speedup:last.speedup}));}
   }
   if(states[name].status!=='passed')throw Error(states[name].error??'Benchmark did not pass');
  }catch(error){save(name,{...states[name],status:'failed',error:String(error)});throw error;}finally{await browser?.close();}
 }
}catch(error){
 for(const name of Object.keys(engines))if(states[name].status==='running')save(name,{...states[name],status:'failed',error:String(error)});
 throw error;
}finally{await server?.close();}
