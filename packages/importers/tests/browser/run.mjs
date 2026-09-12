import { browserEngines } from "../../../../tooling/browser-engines.mjs";
const selectedEngines = browserEngines({ chromium, webkit });
import {build,preview} from 'vite';
import {chromium,webkit} from '@playwright/test';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {makeZip} from '../zip-fixture.ts';
const workspace=resolve(import.meta.dirname,'../../../..'),temporary=await mkdtemp(resolve(tmpdir(),'quixi-provider-import-')),output=resolve(workspace,'test-results/provider-import-browser.json');
const report={ selectedEngines: selectedEngines.map(([name]) => name),status:'running',startedAt:new Date().toISOString(),hosts:[]};await mkdir(resolve(workspace,'test-results'),{recursive:true});const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n');await save();let server;
const run=(page,operation,value)=>page.evaluate(({operation,value})=>window.importerTest(operation,value),{operation,value});
const visit=async context=>{const page=await context.newPage();await page.goto('http://127.0.0.1:4193');await page.waitForFunction(()=>typeof window.importerTest==='function');return page;};
try{
 report.sourceSha256={};for(const file of ["tooling/browser-engines.mjs", 'packages/importers/src/bytes.ts','packages/importers/src/capture.ts','packages/importers/src/report.ts','packages/importers/src/types.ts','packages/importers/src/json/tokens.ts','packages/importers/src/json/metadata.ts','packages/importers/tests/browser/index.ts','packages/importers/tests/browser/run.mjs','packages/importers/src/chatgpt.ts','packages/importers/src/normalize.ts','packages/importers/src/upload.ts','packages/importers/src/storage.ts','packages/importers/src/zip/import.ts','packages/importers/src/zip/reader.ts','packages/importers/src/chatgpt-scan.ts','packages/importers/src/claude-scan.ts','packages/storage/src/client/archive.ts','packages/storage/src/worker/archive-database.ts','packages/storage/src/worker/blobs.ts','packages/storage/src/worker/blob-catalog.ts','packages/storage/migrations/index.ts','package-lock.json'])report.sourceSha256[file]=createHash('sha256').update(await readFile(resolve(workspace,file))).digest('hex');
 const buildOptions={outDir:resolve(temporary,'dist'),emptyOutDir:true,rollupOptions:{input:resolve(import.meta.dirname,'index.html')}};
 await build({configFile:false,root:import.meta.dirname,build:buildOptions,logLevel:'warn'});
 await mkdir(resolve(temporary,'dist/fixtures'),{recursive:true});const original=JSON.parse(await readFile(resolve(import.meta.dirname,'../fixtures/chatgpt-observed.synthetic.json'),'utf8'));original[0].mapping.a.message.content.parts=['Synthetic long text 😀 '.repeat(55_000),...Array.from({length:1001},(_,index)=>`bounded part ${index}`)];
 const zip=makeZip([{name:'conversations-000.json',bytes:new TextEncoder().encode(JSON.stringify(original))},{name:'comet-sketch.png',bytes:Uint8Array.of(137,80,78,71,13,10,26,10)}],true);await writeFile(resolve(temporary,'dist/fixtures/export.zip'),zip);
 await writeFile(resolve(temporary,'dist/fixtures/resume.json'),await readFile(resolve(import.meta.dirname,'../fixtures/chatgpt-observed.synthetic.json')));await writeFile(resolve(temporary,'dist/fixtures/claude.json'),await readFile(resolve(import.meta.dirname,'../fixtures/claude-observed.synthetic.json')));
 server=await preview({configFile:false,root:import.meta.dirname,build:buildOptions,preview:{host:'127.0.0.1',port:4193,strictPort:true},logLevel:'warn'});
 for(const [name,engine]of selectedEngines){
  const profile=resolve(temporary,name),archiveId=`test-importer-${randomUUID()}`,host={name,status:'running',checks:[]};report.hosts.push(host);await save();let context=await engine.launchPersistentContext(profile,{headless:true});let zipRun,pausedRun;
  try{const owner=await visit(context),initial=await run(owner,'open',archiveId),follower=await visit(context);assert.equal((await run(follower,'open',archiveId)).ownerId,initial.ownerId);host.userAgent=await follower.evaluate(()=>navigator.userAgent);console.log(`${name}: importing ZIP through follower`);
   host.zip=await run(follower,'zip');zipRun=host.zip.runId;assert.equal(host.zip.verification.threads,1);assert.equal(host.zip.verification.messages,3);assert(host.zip.verification.parts>1000);assert.equal(host.zip.verification.availableAttachments,1);assert(host.zip.verification.textBlobs>=1);host.checks.push('follower imports ZIP64, numbered JSON, 1000+ parts, long UTF8 text and exact-path asset using actual SQLite/OPFS');await save();
   host.claude=await run(follower,'claude');assert.equal(host.claude.verification.threads,2);assert.equal(host.claude.verification.messages,5);host.checks.push('Claude consumer-shaped source retains text, explicit branches, missing attachment and unknown blocks');
   host.paused=await run(follower,'prepare_resume');pausedRun=host.paused.runId;assert.equal(host.paused.visibleThreads,2);await run(owner,'hold_run',pausedRun);host.executorLease=await run(follower,'check_run_busy',pausedRun);assert.equal(host.executorLease.busy,true);assert.equal(host.executorLease.visibleThreads,2);await run(owner,'release_run');host.checks.push('an independent per-run Web Lock rejects competing importer execution before resuming or discarding transfers');await owner.close();
   await follower.waitForFunction(async previous=>{try{return(await window.importerTest('diagnostics')).ownerId!==previous;}catch(error){if(error&&typeof error==='object'&&error.code==='UNKNOWN_OUTCOME')return false;throw error;}},initial.ownerId);
   host.resumed=await run(follower,'resume',pausedRun);assert.equal(host.resumed.threads,3);assert.equal(host.resumed.messages,8);host.checks.push('unpublished import stays hidden; actual owner-tab termination and importer resume use retained OPFS source with stable stage identity');
   host.report=await run(follower,'report',zipRun);assert(host.report.warnings>0);host.checks.push('bounded NDJSON report includes source-scoped warnings');await run(follower,'close');
  }finally{await context.close();}
  context=await engine.launchPersistentContext(profile,{headless:true});try{const page=await visit(context);await run(page,'open',archiveId);host.afterProcessRestart=await run(page,'verify');assert.equal(host.afterProcessRestart.threads,3);assert.equal(host.afterProcessRestart.messages,8);assert.equal(host.afterProcessRestart.diagnostics.integrity,'ok');host.checks.push('actual browser-process restart retains canonical history, original-source SHA256 and complete long-text blobs');await run(page,'resume',pausedRun);assert.equal((await run(page,'verify')).threads,3);await run(page,'close');}finally{await context.close();}
  host.status='passed';await save();console.log(`${name}: provider importer production acceptance passed`);
 }
 report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack??error);process.exitCode=1;console.error(report.error);}
finally{report.finishedAt=new Date().toISOString();await save();if(server)await new Promise(resolve=>server.httpServer.close(resolve));await rm(temporary,{recursive:true,force:true});}
