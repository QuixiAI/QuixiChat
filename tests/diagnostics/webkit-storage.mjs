import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { chromium, webkit } from '@playwright/test';

const root = resolve(import.meta.dirname, '../..');
const port = Number(process.env.QUIXI_DIAGNOSTIC_PORT ?? 4177);
const types = {'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.html':'text/html','.css':'text/css'};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/diagnostic.html') { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><title>Storage diagnostic</title>'); return; }
    const filename = url.pathname.startsWith('/sqlite/')
      ? resolve(root, 'packages/storage/sqlite/dist', url.pathname.slice('/sqlite/'.length))
      : resolve(root, 'apps/web/dist', ['/', '/storage-proof'].includes(url.pathname) ? 'index.html' : url.pathname.slice(1));
    response.setHeader('Content-Type', types[extname(filename)] ?? 'application/octet-stream');
    response.end(await readFile(filename));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

async function workerProbe(base) {
  const results = [];
  let stage = 'initial';
  const record = (label, details) => { stage = label; results.push({stage, details}); };
  try {
    record('environment', {secure:isSecureContext, locks:!!navigator.locks, storage:!!navigator.storage, syncHandle:typeof FileSystemSyncAccessHandle});
    const dir = await navigator.storage.getDirectory();
    record('getDirectory');
    const nested = await dir.getDirectoryHandle('diagnostic', {create:true});
    record('getDirectoryHandle');
    const file = await nested.getFileHandle('smoke', {create:true});
    record('getFileHandle');
    const handle = await file.createSyncAccessHandle();
    record('createSyncAccessHandle');
    handle.write(new Uint8Array([1,2,3]), {at:0}); handle.flush(); handle.close();
    record('write-flush-close');
    await navigator.locks.request('diagnostic-lock', async () => { record('lock-acquired'); });
    record('lock-released');
    globalThis.sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};
    const {default:init}=await import(`${base}/sqlite/sqlite3.mjs`);
    record('module-imported');
    const sqlite=await init({locateFile:()=>`${base}/sqlite/sqlite3.wasm`});
    record('sqlite-initialized');
    const pool=await sqlite.installOpfsSAHPoolVfs({name:'diagnostic-pool',directory:'/diagnostic/pool',initialCapacity:6});
    record('pool-installed');
    const db=new pool.OpfsSAHPoolDb('/smoke.sqlite3');
    record('database-opened');
    db.exec('CREATE TABLE IF NOT EXISTS smoke(id);INSERT INTO smoke VALUES(1)');
    record('database-written', db.selectValue('SELECT count(*) FROM smoke'));
    db.close(); pool.pauseVfs(); record('database-closed');
    return {ok:true, results};
  } catch(error) { return {ok:false, after:stage, error:{name:error.name,message:error.message,stack:error.stack},results}; }
}

try {
  for (const [name, engine, persistent] of [['chromium',chromium,false], ['webkit',webkit,false], ['webkit-persistent',webkit,true]]) {
    const profile=persistent ? await mkdtemp(resolve(tmpdir(),'quixi-webkit-diagnostic-')) : undefined;
    const browser=persistent ? await engine.launchPersistentContext(profile) : await engine.launch();
    try {
      const page=await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/diagnostic.html`);
      const mainOPFS=await page.evaluate(async()=>{try{const root=await navigator.storage.getDirectory();return {ok:true,name:root.name}}catch(e){return {ok:false,name:e.name,message:e.message}}});
      const result=await page.evaluate(async ({source,base}) => {
        const worker=new Worker(URL.createObjectURL(new Blob([`(${source})(${JSON.stringify(base)}).then(result=>postMessage(result))`], {type:'text/javascript'})),{type:'module'});
        return await new Promise(resolve => {worker.onmessage=({data})=>{resolve(data);worker.terminate()};worker.onerror=e=>resolve({error:e.message})});
      }, {source:workerProbe.toString(),base:`http://127.0.0.1:${port}`});
      console.log(JSON.stringify({engine:name,version:persistent ? browser.browser().version() : browser.version(),mainOPFS,result},null,2));
      await page.goto(`http://127.0.0.1:${port}/storage-proof?namespace=diagnostic-${name}`);
      await page.waitForTimeout(3000);
      console.log(JSON.stringify({engine:name,pageText:await page.locator('body').innerText()},null,2));
    } finally {await browser.close();if(profile) await rm(profile,{recursive:true,force:true})}
  }
} finally {await new Promise(resolve=>server.close(resolve))}
