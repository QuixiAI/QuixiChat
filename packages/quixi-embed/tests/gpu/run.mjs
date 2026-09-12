import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium,webkit,firefox} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const name=process.argv[2]??'chromium';
if(!['chromium','webkit','firefox'].includes(name))throw Error('Unknown engine');
const output=path.join(root,`build/gpu-${name}-${process.argv.includes('--lifecycle')?'lifecycle':process.argv.includes('--kernels')?'kernels':'smoke'}${['tiled','half','subgroups'].filter(flag=>process.argv.includes('--'+flag)).map(flag=>'-'+flag).join('')}.json`);
fs.writeFileSync(output,JSON.stringify({status:'running',passed:false})+'\n');
let server,browser;
try{
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  browser=await({chromium,webkit,firefox}[name]).launch(name==='chromium'?{args:['--enable-gpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]}:{});
  const page=await browser.newPage();page.on('console',msg=>console.log(msg.type(),msg.text()));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/browser.html?${['kernels','lifecycle','tiled','half','subgroups'].filter(flag=>process.argv.includes('--'+flag)).map(flag=>flag+'=1').join('&')}`);
  await page.waitForFunction(()=>window.quixiResult,undefined,{timeout:300000});
  const result={engine:name,version:browser.version(),...await page.evaluate(()=>window.quixiResult)};
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  if(!result.passed)process.exitCode=1;
}catch(error){fs.writeFileSync(output,JSON.stringify({passed:false,status:'failed',error:String(error)})+'\n');throw error;}
finally{await browser?.close();await server?.close();}
