import { chromium, webkit } from '@playwright/test';
import { build, preview } from 'vite';
import { browserEngines } from '../../tooling/browser-engines.mjs';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, platform, release, arch } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'../..'),output=resolve(import.meta.dirname,'results/report.json');
const engines=browserEngines({chromium,webkit});
const report={status:'running',startedAt:new Date().toISOString(),environment:{platform:platform(),release:release(),arch:arch(),node:process.version},selectedEngines:engines.map(([name])=>name),scope:'Design model and real provider request mappers; no product summary implementation, storage mutations or model inference.',modelRuns:0,sourceSha256:{},builtSha256:{},checks:[],hosts:[]};
const save=async()=>{await mkdir(resolve(import.meta.dirname,'results'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2)+'\n');};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await save();const temporary=await mkdtemp(resolve(tmpdir(),'quixi-summary-design-'));let server;
try{
 const sources=[...(await readdir(import.meta.dirname)).filter(name=>/\.(ts|json|mjs|html)$/.test(name)).map(name=>'research/context-summary/'+name),'tooling/browser-engines.mjs','packages/providers/src/request.ts','packages/providers/src/types.ts','packages/providers/tests/fixtures.ts','packages/core/src/contracts/storage.ts','packages/core/src/model/compaction.ts','packages/core/src/model/types.ts','packages/core/src/model/provenance.ts','research/context-summary/README.md','docs/decisions/0020-reviewed-summary-proposals.md'];
 for(const file of sources)report.sourceSha256[file]=hash(await readFile(resolve(root,file)));
 const typecheck=execFileSync('npm',['exec','--','tsc','--noEmit','-p','research/context-summary/tsconfig.json'],{cwd:root,encoding:'utf8'});
 report.checks.push({command:'npm exec -- tsc --noEmit -p research/context-summary/tsconfig.json',exitCode:0,output:typecheck});
 const tests=execFileSync(process.execPath,['--experimental-transform-types','--test','research/context-summary/node.test.ts'],{cwd:root,encoding:'utf8'});
 report.checks.push({command:'node --experimental-transform-types --test research/context-summary/node.test.ts',exitCode:0,output:tests});
 const outDir=resolve(temporary,'dist');await build({configFile:false,root:import.meta.dirname,logLevel:'warn',build:{outDir,emptyOutDir:true}});
 for(const file of await readdir(outDir,{recursive:true}))if(/\.(js|html)$/.test(file))report.builtSha256[file]=hash(await readFile(resolve(outDir,file)));
 server=await preview({configFile:false,root:import.meta.dirname,logLevel:'warn',build:{outDir},preview:{host:'127.0.0.1',port:0,strictPort:true}});
 report.origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 for(const [name,engine] of engines){
  const browser=await engine.launch({headless:true});
  try{const page=await browser.newPage();await page.goto(report.origin);await page.waitForFunction(()=>window.summaryDesignResult?.status!=='running'&&window.summaryDesignResult,null,{timeout:30000});
   const result=await page.evaluate(()=>window.summaryDesignResult);report.hosts.push({name,userAgent:await page.evaluate(()=>navigator.userAgent),...result});await save();if(result.status!=='passed')throw new Error(`${name}: ${result.error}`);console.log(`${name}: ${result.checks.length} design checks passed; model runs: 0`);
  }finally{await browser.close();}
 }
 report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack??error);process.exitCode=1;}
finally{report.completedAt=new Date().toISOString();await save();if(server)await new Promise(resolve=>server.httpServer.close(resolve));await rm(temporary,{recursive:true,force:true});}
