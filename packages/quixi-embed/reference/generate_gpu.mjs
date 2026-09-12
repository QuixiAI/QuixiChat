// Actual dedicated-worker GPU execution; only transfer/serialization happens in JS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
import {chromium,webkit} from '@playwright/test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const engine=process.argv[2]??'chromium';
const subgroups=process.argv.includes('--subgroups');
const attention=process.argv.includes('--fused')?'fused':'baseline';
const projection=process.argv.includes('--half')?'half':process.argv.includes('--tiled')?'tiled':process.argv.includes('--auto')?'auto':'baseline';
if(!['chromium','webkit'].includes(engine))throw Error('Unknown GPU engine');
const output=path.resolve(process.argv[3]??path.join(root,`build/gpu-${engine}-raw`));
const golden=JSON.parse(fs.readFileSync(path.join(root,process.argv.includes('--boundaries')?'tests/gpu/goldens/manifest.json':'tests/goldens/manifest.json')));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(output,{recursive:true});
const distribution=JSON.parse(fs.readFileSync(path.join(root,'kernels/webgpu/1.0.0/manifest.json')));
const manifest={distribution,host:{platform:os.platform(),arch:os.arch(),release:os.release(),cpu:os.cpus()[0]?.model},version:1,status:'running',source:golden.source,backend:{route:projection==='half'?'webgpu-fp16':'webgpu-fp32',engine,
  shader_sha256:hash(fs.readFileSync(path.join(root,'kernels/webgpu/1.0.0/baseline.wgsl'))),
  additional_shader_sha256:projection==='baseline'?null:hash(fs.readFileSync(path.join(root,`kernels/webgpu/1.0.0/${projection==='auto'?'tiled':projection}.wgsl`))),
  runtime_sha256:hash(fs.readFileSync(path.join(root,'src/gpu/encoder.ts')))},cases:[]};
const save=()=>fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');save();
let server,browser;const start=performance.now();
try{
  server=await createServer({root,configFile:false,server:{host:'127.0.0.1',port:0}});await server.listen();
  browser=await({chromium,webkit}[engine]).launch(engine==='chromium'?{args:['--enable-gpu',...(process.platform==='darwin'?['--use-angle=metal']:[])]}:{});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/gpu/full.html`);
  await page.waitForFunction(()=>window.gpuRequest);
  const initialized=await page.evaluate(options=>window.gpuRequest({method:'initialize',...options}),{projection,subgroups,attention});
  manifest.backend={...manifest.backend,browser_version:browser.version(),...initialized.diagnostics};save();
  for(let i=0;i<golden.cases.length;i++){
    const test=golden.cases[i];
    const result=await page.evaluate(test=>window.gpuRequest({method:'case',test}),test);
    const bytes=Buffer.from(result.base64,'base64'),file=test.id+'.bin';fs.writeFileSync(path.join(output,file),bytes);
    manifest.cases.push({...test,file,sha256:hash(bytes),raw_arrays:result.metadata,timing:result.timing});save();
    if(i%5===0||i===golden.cases.length-1)console.log(`${i+1}/${golden.cases.length} ${test.id} ${((performance.now()-start)/1000).toFixed(1)}s`);
  }
  await page.evaluate(()=>window.gpuRequest({method:'dispose'}));manifest.status='passed';manifest.elapsed_seconds=(performance.now()-start)/1000;save();
}catch(error){manifest.status='failed';manifest.error=String(error);save();throw error;}
finally{await browser?.close();await server?.close();}
