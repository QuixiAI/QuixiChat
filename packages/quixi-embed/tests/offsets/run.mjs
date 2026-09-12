import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {chromium,firefox,webkit} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const engine=process.argv[2]??'chromium',route=process.argv[3]??'scalar';
if(!['chromium','firefox','webkit'].includes(engine)||!['scalar','simd'].includes(route))throw Error('Invalid browser/route');
const output=path.join(root,`build/token-offset-${engine}-${route}.json`);
let report={passed:false,status:'running'},server,browser;
const save=()=>{fs.writeFileSync(output+'.tmp',JSON.stringify(report,null,2)+'\n');fs.renameSync(output+'.tmp',output);};save();
try{
  const build=JSON.parse(fs.readFileSync(path.join(root,`build/quixi-${route}.wasm.json`)));
  if(createHash('sha256').update(fs.readFileSync(path.join(root,`build/quixi-${route}.wasm`))).digest('hex')!==build.sha256)throw Error('WASM build identity mismatch');
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  browser=await({chromium,firefox,webkit}[engine]).launch();const page=await browser.newPage();const requests=[];
  page.on('request',request=>requests.push(new URL(request.url()).pathname));
  await page.route('**/*.qxmodel',request=>request.abort());
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/offsets/browser.html?route=${route}`);
  await page.waitForFunction(()=>window.quixiResult,undefined,{timeout:120000});
  report={...await page.evaluate(()=>window.quixiResult),engine,version:browser.version(),host:{platform:os.platform(),release:os.release(),cpu:os.cpus()[0]?.model},
    build,assetRequests:requests.filter(value=>/\.(wasm|qxtokenizer|qxmodel|jsonl)$/.test(value)),
    fixtureSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'tests/token-offset-fixtures.jsonl'))).digest('hex')};
  if(requests.some(value=>value.endsWith('.qxmodel')))throw Error('Standalone tokenizer requested model weights');
  if(!report.passed)throw Error(report.error??'Offset browser gate failed');
  report.status='passed';save();console.log(JSON.stringify(report,null,2));
}catch(error){report={...report,passed:false,status:'failed',error:String(error)};save();throw error;}
finally{await browser?.close();await server?.close();}
