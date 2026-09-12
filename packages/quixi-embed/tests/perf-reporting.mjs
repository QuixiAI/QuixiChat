import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'quixi-perf-report-'));
try {
 fs.mkdirSync(path.join(directory,'perf'));fs.mkdirSync(path.join(directory,'build'));
 fs.writeFileSync(path.join(directory,'package.json'),'{"type":"module"}');
 fs.symlinkSync(path.resolve(root,'../../node_modules'),path.join(directory,'node_modules'),'dir');
 // The numeric harness is deliberately unreachable when provisioning inputs are absent.
 fs.writeFileSync(path.join(directory,'perf/benchmark.ts'),'export async function benchmark(){throw Error("Unexpected inference");}');
 for(const [runner,report,args] of [
  ['browser.mjs','simd-performance-chromium.json',['chromium']],
  ['run.mjs','simd-performance-node.json',[]],
 ]){
  fs.copyFileSync(path.join(root,'perf',runner),path.join(directory,'perf',runner));
  const output=path.join(directory,'build',report);fs.writeFileSync(output,'{"status":"passed","stale":true}');
  const result=spawnSync(process.execPath,['--experimental-strip-types',path.join(directory,'perf',runner),...args],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  const observed=JSON.parse(fs.readFileSync(output,'utf8'));
  assert.equal(observed.status,'failed');assert.equal(observed.stale,undefined);assert.match(observed.error,/ENOENT/);assert(observed.started_at);
 }
 console.log('Passed 2 performance-report preflight invalidation checks');
} finally {fs.rmSync(directory,{recursive:true,force:true});}
