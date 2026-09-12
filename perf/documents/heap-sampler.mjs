import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Test-only local CDP connection. Uses documented flattened target sessions, never
// pauses targets. Forced GC is a separate explicitly invoked diagnostic method.
// A sample is not a peak or a hard live-heap bound.
export async function startHeapSampler(profile, origin, options = {}) {
  const gcPages = options.gcPages ?? [1, 10, 50, 100];
  if (!Array.isArray(gcPages) || gcPages.length < 1 || gcPages.length > 4 || gcPages.some(page => !Number.isInteger(page) || page < 1)) throw new Error('Forced-GC checkpoints must be one to four page numbers');
  const [port, path] = (await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
  if (!/^\d+$/.test(port) || !path.startsWith('/devtools/browser/')) throw new Error('Invalid local CDP endpoint');
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', reject, {once:true}); });
  let sequence = 0, stopped = false, busy = false, collecting = false, tickTask = Promise.resolve();
  const pending = new Map(), targets = new Map(), attachTasks = new Set();
  const started = performance.now();
  const data = {available:true, intervalMs:500, forcedGC:false, gcPages:[...gcPages], gcMeasurements:[], startedAt:new Date().toISOString(), protocol:null, targets:[], errors:[], skippedTicks:0};
  const error = value => { if (data.errors.length < 32) data.errors.push(String(value)); };
  function send(method, params = {}, sessionId, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}: CDP ${timeoutMs}ms deadline`)); }, timeoutMs);
      pending.set(id, {resolve, reject, timer});
      socket.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    });
  }
  async function attach(info) {
    if (stopped || targets.has(info.targetId) || targets.size >= 16 || !['page','worker','shared_worker'].includes(info.type) || !info.url.startsWith(origin + '/')) return;
    const row = {targetId:info.targetId, type:info.type, url:info.url, title:info.title, workerName:null, isolateId:null, role:'unidentified', samples:[], droppedSamples:0, peakUsedSize:null, peakBackingStorageSize:null, detachedAtMs:null, errors:[]};
    const entry = {row, sessionId:null, live:true}; targets.set(info.targetId, entry); data.targets.push(row);
    try {
      entry.sessionId = (await send('Target.attachToTarget', {targetId:info.targetId, flatten:true})).sessionId;
      // Worker target titles carry the WorkerOptions name. Do not evaluate JS
      // during module-worker startup: the retained initial observer crash shows
      // that startup inspection is not transparent on the tested Chromium build.
      row.workerName = info.type === 'worker' && ['quixi-pdf-parser','quixi-document-extractor'].includes(info.title) ? info.title : null;
      row.role = info.type === 'page' ? 'page' : info.title === 'quixi-pdf-parser' ? 'pdfjs-parser' : info.title === 'quixi-document-extractor' ? 'document-extractor' : /\/archive-[^/]+\.js$/.test(info.url) ? 'archive-storage-worker' : 'other-worker';
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!entry.live) return;
      row.isolateId = (await send('Runtime.getIsolateId', {}, entry.sessionId)).id;
      await sample(entry);
    } catch (e) { row.errors.push(String(e)); }
  }
  async function sample(entry) {
    if (!entry.sessionId || !entry.live) return;
    const at = performance.now();
    try {
      const usage = await send('Runtime.getHeapUsage', {}, entry.sessionId);
      if (!Number.isFinite(usage.usedSize) || !Number.isFinite(usage.totalSize)) throw new Error('Invalid CDP heap usage');
      const row = entry.row;
      row.peakUsedSize = Math.max(row.peakUsedSize ?? 0, usage.usedSize);
      if (Number.isFinite(usage.backingStorageSize)) row.peakBackingStorageSize = Math.max(row.peakBackingStorageSize ?? 0, usage.backingStorageSize);
      let progress = null;
      if (row.role === 'page') {
        const result = await send('Runtime.evaluate', {expression:'globalThis.documentPerf?.progress?.()??null',returnByValue:true}, entry.sessionId);
        progress = result.result.value ?? null;
      }
      if (row.samples.length < 2400) row.samples.push({elapsedMs:at-started, replyLatencyMs:performance.now()-at, ...usage, ...(progress ? {progress} : {})}); else row.droppedSamples++;
    } catch (e) { if (entry.live && entry.row.errors.length < 8) entry.row.errors.push(String(e)); }
  }
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
    } else if (message.method === 'Target.targetCreated' || message.method === 'Target.targetInfoChanged') {
      const task = attach(message.params.targetInfo).catch(error); attachTasks.add(task); task.finally(()=>attachTasks.delete(task));
    } else if (message.method === 'Target.targetDestroyed') {
      const entry = targets.get(message.params.targetId);
      if (entry) { entry.live=false; entry.row.detachedAtMs=performance.now()-started; }
    }
  });
  data.protocol = await send('Browser.getVersion');
  await send('Target.setDiscoverTargets', {discover:true});
  for (const info of (await send('Target.getTargets')).targetInfos) await attach(info);
  const timer = setInterval(() => {
    if (busy || collecting) { data.skippedTicks++; return; }
    busy=true;
    tickTask=Promise.all([...targets.values()].map(sample)).catch(error).finally(()=>{busy=false;});
  }, 500);
  return { async sqlSnapshot(reset=false) {
    if(stopped || collecting)throw new Error('SQL snapshot requires a running observer outside GC');
    await Promise.all([...attachTasks]);
    const candidates=[...targets.values()].filter(entry=>entry.live && entry.sessionId && entry.row.role==='archive-storage-worker');
    if(candidates.length!==1)throw new Error('Cannot uniquely identify initialized archive worker');
    const entry=candidates[0];
    const result=await send('Runtime.evaluate',{expression:`JSON.stringify(globalThis.__quixiSqlDiagnostic?.snapshot(${reset?'true':'false'})??null)`,returnByValue:true},entry.sessionId);
    if(result.exceptionDetails || typeof result.result?.value!=='string' || result.result.value.length>524288)throw new Error('SQL snapshot unavailable or exceeds bounded metadata size');
    const snapshot=JSON.parse(result.result.value);
    if(!snapshot || snapshot.version!==1 || snapshot.rows.length>513 || snapshot.operations.length>32)throw new Error('Invalid SQL diagnostic snapshot');
    return {targetId:entry.row.targetId,isolateId:entry.row.isolateId,url:entry.row.url,...snapshot};
  }, async collectParser(checkpoint) {
    if (stopped || collecting || data.gcMeasurements.length >= gcPages.length || !gcPages.includes(checkpoint.page) || checkpoint.page !== checkpoint.indexedThroughPage || data.gcMeasurements.some(row=>row.checkpoint.page===checkpoint.page)) throw new Error('Invalid or duplicate forced-GC checkpoint');
    for (const key of ['page','totalTextUTF16','currentPageUTF16','indexedThroughPage','elapsedMs']) if (!Number.isFinite(checkpoint[key]) || checkpoint[key] < 0) throw new Error('Invalid GC checkpoint metadata');
    collecting=true; data.forcedGC=true;
    const record={checkpoint:{page:checkpoint.page,totalTextUTF16:checkpoint.totalTextUTF16,currentPageUTF16:checkpoint.currentPageUTF16,indexedThroughPage:checkpoint.indexedThroughPage,elapsedMs:checkpoint.elapsedMs},startedMs:performance.now()-started,status:'running'};
    data.gcMeasurements.push(record);
    try {
      await tickTask; await Promise.all([...attachTasks]);
      const parser=[...targets.values()].filter(entry=>entry.live && entry.sessionId && entry.row.role==='pdfjs-parser' && entry.row.isolateId);
      if(parser.length!==1) throw new Error('Cannot uniquely identify active PDF.js parser isolate');
      const entry=parser[0]; record.targetId=entry.row.targetId; record.isolateId=entry.row.isolateId; record.url=entry.row.url;
      // The parser fields above stay the primary measurement; every other
      // identified live isolate (extractor, storage worker, page) is collected
      // the same way so working-set growth can be attributed per isolate.
      const collect=async target=>{
        await send('HeapProfiler.enable',{},target.sessionId);
        try {
          const before=await send('Runtime.getHeapUsage',{},target.sessionId);
          const gcStart=performance.now();
          await send('HeapProfiler.collectGarbage',{},target.sessionId,10000);
          const collectGarbageMs=performance.now()-gcStart;
          const after=await send('Runtime.getHeapUsage',{},target.sessionId);
          if((await send('Runtime.getIsolateId',{},target.sessionId)).id!==target.row.isolateId) throw new Error('Isolate changed during GC checkpoint');
          return {before,after,collectGarbageMs};
        } finally { await send('HeapProfiler.disable',{},target.sessionId); }
      };
      const parserResult=await collect(entry);
      record.before=parserResult.before; record.collectGarbageMs=parserResult.collectGarbageMs; record.after=parserResult.after;
      record.isolates=[{role:'pdfjs-parser',targetId:entry.row.targetId,isolateId:entry.row.isolateId,url:entry.row.url,...parserResult}];
      const others=[...targets.values()].filter(other=>other!==entry && other.live && other.sessionId && other.row.isolateId && ['document-extractor','archive-storage-worker','page'].includes(other.row.role));
      for(const other of others){
        try { record.isolates.push({role:other.row.role,targetId:other.row.targetId,isolateId:other.row.isolateId,url:other.row.url,...await collect(other)}); }
        catch(failure){ record.isolates.push({role:other.row.role,targetId:other.row.targetId,isolateId:other.row.isolateId,url:other.row.url,error:String(failure)}); }
      }
      record.status='passed';
      return {page:checkpoint.page,status:'passed'};
    } catch(error) {record.status='failed';record.error=String(error);throw error;}
    finally {record.durationMs=performance.now()-started-record.startedMs;collecting=false;}
  }, async stop() {
    stopped=true; clearInterval(timer); await tickTask; await Promise.all([...attachTasks]);
    await Promise.all([...targets.values()].map(sample));
    for (const entry of targets.values()) if (entry.live && entry.sessionId) await send('Target.detachFromTarget', {sessionId:entry.sessionId}).catch(error);
    socket.close(); data.finishedAt=new Date().toISOString(); return data;
  }};
}
