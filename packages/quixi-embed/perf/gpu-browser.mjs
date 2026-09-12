import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,webkit} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const engine=process.argv[2]??'chromium';if(!['chromium','webkit'].includes(engine))throw Error('Unknown engine');
const output=path.resolve(process.argv[3]??path.join(root,`build/gpu-${engine}-${process.argv.includes('--half')?'half-':''}performance.json`));
const distribution=JSON.parse(fs.readFileSync(path.join(root,'kernels/webgpu/1.0.0/manifest.json')));
let report={status:'running',passed:false},server,browser;
const host={engine,platform:os.platform(),arch:os.arch(),release:os.release(),cpu:os.cpus()[0]?.model,conditions:'Shared development host; not a verified quiescent release benchmark'};
const save=()=>{fs.writeFileSync(output+'.tmp',JSON.stringify({...report,host,distribution},null,2)+'\n');fs.renameSync(output+'.tmp',output);};save();
try{
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  browser=await({chromium,webkit}[engine]).launch(engine==='chromium'?{args:['--enable-gpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]}:{});host.version=browser.version();
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/perf/gpu.html?${['half','subgroups','attention','auto','finalhalf','anchors'].filter(flag=>process.argv.includes('--'+flag)).map(flag=>flag+'=1').join('&')}`);
  let count=0;
  while(true){
    await page.waitForFunction(count=>window.quixiResult||(window.quixiProgress?.shapes.length??0)>count,count,{timeout:300000});
    const update=await page.evaluate(()=>({result:window.quixiResult,progress:window.quixiProgress}));
    report=update.result??update.progress;save();
    if(update.result){if(!report.passed)throw Error(report.error);break;}
    count=report.shapes.length;console.log(`${engine} ${count}/${process.argv.includes('--anchors')?3:15}`,JSON.stringify(report.shapes.at(-1).metrics));
  }
}catch(error){report={...report,status:'failed',passed:false,error:String(error)};save();throw error;}
finally{await browser?.close();await server?.close();}
