// Hardware availability is a measured prerequisite, never a skipped green test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,webkit,firefox} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const engine=process.argv[2]??'chromium';
const output=path.resolve(process.argv[3]??path.join(root,`build/gpu-${engine}-adapter.json`));
let report={status:'running',passed:false,engine},server,browser;
const save=()=>{fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output+'.tmp',JSON.stringify(report,null,2)+'\n');fs.renameSync(output+'.tmp',output);};save();
try{
  if(!['chromium','webkit','firefox'].includes(engine))throw Error('Unknown engine');
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  const args=engine==='chromium'?['--enable-gpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]:[];
  browser=await({chromium,webkit,firefox}[engine]).launch({args});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
  const measured=await page.evaluate(async()=>{
    const adapter=await navigator.gpu?.requestAdapter({powerPreference:'high-performance'});
    if(!adapter)return{available:false,reason:'No WebGPU adapter'};
    const info=adapter.info,limits={};for(const name of ['maxBufferSize','maxStorageBufferBindingSize','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupStorageSize','maxComputeWorkgroupsPerDimension','maxStorageBuffersPerShaderStage'])limits[name]=adapter.limits[name];
    return{available:info.isFallbackAdapter===false,adapter:{vendor:info.vendor,architecture:info.architecture,device:info.device,description:info.description,isFallbackAdapter:info.isFallbackAdapter},features:[...adapter.features].sort(),limits};
  });
  report={...report,...measured,status:measured.available?'passed':'unavailable',passed:measured.available,version:browser.version(),launchArgs:args,host:{platform:os.platform(),release:os.release(),arch:os.arch(),cpu:os.cpus()[0]?.model}};save();
  if(!report.passed)process.exitCode=1;
}catch(error){report={...report,status:'failed',passed:false,error:String(error)};save();process.exitCode=1;}
finally{await browser?.close();await server?.close();}
console.log(JSON.stringify(report,null,2));
