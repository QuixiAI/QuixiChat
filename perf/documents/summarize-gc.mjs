import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const names=process.argv.slice(2);
if(!names.length || names.length>4 || names.some(name=>!/^(dense-)?gc-[a-z0-9-]+$/.test(name))) throw new Error('Pass one to four gc-* or dense-gc-* report basenames');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const result={analysisToolSha256:digest(await readFile(new URL(import.meta.url))),method:'Awaited indexed-page producer pauses and forced GC. Isolate-wide before/after measurements; no peak/hard-bound/exact-retainer claim. Diagnostic timing is not production throughput.',reports:[]};
for(const name of names){
 const bytes=await readFile(resolve(import.meta.dirname,'results',name+'.json'));const report=JSON.parse(bytes);
 if(!report.method.gcDiagnostic) throw new Error('Input is not a forced-GC diagnostic');
 const item={name,sha256:digest(bytes),status:report.status,sourceStable:report.sourceStable??null,runtimeSha256:report.sourceSha256['packages/documents/src/worker/index.ts'],parserDistributionSha256:report.sourceSha256['node_modules/pdfjs-dist/build/pdf.worker.mjs'],checkpoints:[]};
 for(const host of report.hosts) for(const c of host.cases) for(const gc of c.heap?.gcMeasurements??[]) item.checkpoints.push({engine:host.name,page:gc.checkpoint.page,outputUTF16:gc.checkpoint.totalTextUTF16,status:gc.status,isolateId:gc.isolateId,beforeUsedBytes:gc.before?.usedSize??null,afterUsedBytes:gc.after?.usedSize??null,afterBackingBytes:gc.after?.backingStorageSize??null,collectGarbageMs:gc.collectGarbageMs??null,pauseMs:gc.durationMs,error:gc.error??null,isolates:(gc.isolates??[]).map(row=>({role:row.role,isolateId:row.isolateId,beforeUsedBytes:row.before?.usedSize??null,afterUsedBytes:row.after?.usedSize??null,afterBackingBytes:row.after?.backingStorageSize??null,collectGarbageMs:row.collectGarbageMs??null,error:row.error??null}))});
 result.reports.push(item);
}
const summaryName=process.env.QUIXI_GC_SUMMARY??'dense-gc-summary';
if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(summaryName)) throw new Error('Invalid QUIXI_GC_SUMMARY name');
await writeFile(resolve(import.meta.dirname,`results/${summaryName}.json`),JSON.stringify(result,null,2)+'\n');
for(const row of result.reports) console.log(JSON.stringify(row));
