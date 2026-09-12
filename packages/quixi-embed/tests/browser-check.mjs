import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, firefox, webkit } from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});
await server.listen();
const port=server.httpServer.address().port;
const results=[];
const route=process.argv[2]??'scalar';
if(!['scalar','simd'].includes(route))throw Error('Unknown CPU route');
try {
  for (const [name,type] of Object.entries({chromium,firefox,webkit})) {
    let browser;
    try {
      browser=await type.launch();
      const page=await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/tests/browser.html?route=${route}`);
      await page.waitForFunction(()=>window.quixiResult,undefined,{timeout:180000});
      const result=await page.evaluate(()=>window.quixiResult);
      results.push({engine:name,version:browser.version(),...result});
      console.log(JSON.stringify(results.at(-1)));
    } catch(error) {
      results.push({engine:name,passed:false,error:String(error)});
      console.error(name,String(error));
    } finally {
      await browser?.close();
    }
  }
} finally {
  await server.close();
}
fs.writeFileSync(path.join(root,`build/${route==='scalar'?'browser':'simd-browser'}-report.json`),JSON.stringify({results},null,2)+'\n');
if(results.some(result=>!result.passed))process.exitCode=1;
