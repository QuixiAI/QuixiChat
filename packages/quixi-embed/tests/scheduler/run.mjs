import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,webkit,firefox} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const engine=process.argv[2]??'chromium',route=process.argv[3]??'simd',loss=process.argv.includes('--loss');
if(!['chromium','webkit','firefox'].includes(engine)||!['scalar','simd','gpu','half'].includes(route))throw Error('Unknown scheduler route');
const output=path.join(root,`build/scheduler-${engine}-${route}${loss?'-loss':''}.json`);
let server,browser,report={status:'running',passed:false};
const save=()=>{fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output+'.tmp',JSON.stringify(report,null,2)+'\n');fs.renameSync(output+'.tmp',output);};save();
try{
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  const args=engine==='chromium'&&['gpu','half'].includes(route)?['--enable-gpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]:[];
  browser=await({chromium,webkit,firefox}[engine]).launch({args});const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/scheduler/browser.html?route=${route}${loss?'&loss=1':''}`);
  await page.waitForFunction(()=>window.quixiResult,undefined,{timeout:120000});
  report={...await page.evaluate(()=>window.quixiResult),engine,version:browser.version(),launchArgs:args,
    host:{platform:os.platform(),release:os.release(),cpu:os.cpus()[0]?.model},
    cpuDistribution:JSON.parse(fs.readFileSync(path.join(root,`artifacts/${JSON.parse(fs.readFileSync(path.join(root,'build/quixi-scalar.wasm.json'))).artifact_version}/manifest.json`))),
    gpuDistribution:JSON.parse(fs.readFileSync(path.join(root,'kernels/webgpu/1.0.0/manifest.json')))};
  if(report.passed&&report.rendererHeartbeat.samples<5)throw Error('Renderer heartbeat did not remain active');
  report.status=report.passed?'passed':'failed';save();console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}catch(error){report={...report,status:'failed',passed:false,error:String(error)};save();throw error;}
finally{await browser?.close();await server?.close();}
