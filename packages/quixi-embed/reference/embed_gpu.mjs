import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,webkit} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [engine,input,output,projection='baseline',attention='baseline']=process.argv.slice(2);
if(!['chromium','webkit'].includes(engine)||!input||!output)throw Error('Usage: embed_gpu.mjs chromium|webkit input.json output.bin');
const jobs=JSON.parse(fs.readFileSync(input));let server,browser;const pieces=[],measurements=[];
try{
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  browser=await({chromium,webkit}[engine]).launch(engine==='chromium'?{args:['--enable-gpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]}:{});
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/full.html`);
  await page.waitForFunction(()=>window.gpuRequest);
  const start=performance.now();
  const initialized=await page.evaluate(options=>window.gpuRequest({method:'initialize',diagnostic:false,...options}),{projection,attention});
  const initializationMs=performance.now()-start;
  for(let i=0;i<jobs.length;){
    const selected=[jobs[i]];if(jobs[i].role==='document')while(selected.length<32&&jobs[i+selected.length]?.role==='document')selected.push(jobs[i+selected.length]);
    const result=await page.evaluate(data=>window.gpuRequest(data),{method:'embed',role:selected[0].role,texts:selected.map(x=>x.text)});
    pieces.push(Buffer.from(result.base64,'base64'));measurements.push({role:selected[0].role,batch:selected.length,...result.timing});i+=selected.length;
  }
  await page.evaluate(()=>window.gpuRequest({method:'dispose'}));
  fs.writeFileSync(output,Buffer.concat(pieces));
  fs.writeFileSync(output+'.json',JSON.stringify({engine,version:browser.version(),jobs:jobs.length,initializationMs,measurements,distribution:JSON.parse(fs.readFileSync(path.join(root,'kernels/webgpu/1.0.0/manifest.json'))),diagnostics:initialized.diagnostics},null,2)+'\n');
}finally{await browser?.close();await server?.close();}
