import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(root,process.argv.includes('--transfers')?'build/gpu-baseline-transfer-profile.json':'build/gpu-baseline-profile.json');
const transfers=process.argv.includes('--transfers');
const report={distribution:JSON.parse(fs.readFileSync(path.join(root,'kernels/webgpu/1.0.0/manifest.json'))),separateReadbackObservation:transfers,status:'running',passed:false,conditions:'Development host; timestamp instrumented separate passes, not production dispatch latency',shapes:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');save();
let server,browser;
try{
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  browser=await chromium.launch({args:['--enable-gpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/full.html`);
  await page.waitForFunction(()=>window.gpuRequest);
  report.environment={engine:'chromium',version:browser.version(),...await page.evaluate(observeTransfers=>window.gpuRequest({method:'initialize',diagnostic:false,profile:true,maxBatch:1,observeTransfers}),transfers)};save();
  for(const tokens of [32,128,512]){
    const data={method:'embed',role:'document',texts:[Array(tokens-2).fill('token').join(' ')]};
    for(let i=0;i<5;i++)await page.evaluate(data=>window.gpuRequest(data),data);
    const samples=[];
    for(let i=0;i<30;i++){const result=await page.evaluate(data=>window.gpuRequest(data),data);samples.push({...result.timing,...(transfers?{transferObservation:result.transferObservation}:{})});}
    report.shapes.push({batch:1,tokens,warmups:5,samples});save();
  }
  report.status='passed';report.passed=true;save();
  await page.evaluate(()=>window.gpuRequest({method:'dispose'}));console.log(output);
}catch(error){report.status='failed';report.error=String(error);save();throw error;}
finally{await browser?.close();await server?.close();}
