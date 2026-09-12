import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const names=process.argv.slice(2);
if(!names.length || names.some(name=>!/^dense-[a-z0-9-]+$/.test(name))) throw new Error('Pass dense-* report basenames');
const report={analysisToolSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),method:'Single captures; sampled isolate highs are separate, unsynchronized, may contain unreachable objects awaiting GC, and are not peak/live/hard bounds. No summing per-isolate peaks. Source-size and output-size both vary. CDP observer overhead is included.', reports:[], cases:[]};
for(const name of names) {
 const raw=await readFile(resolve(import.meta.dirname,'results',name+'.json'));
 const source=JSON.parse(raw);
 report.reports.push({name,status:source.status,sha256:createHash('sha256').update(raw).digest('hex'),sourceStable:source.sourceStable??null});
 for(const host of source.hosts) for(const c of host.cases) {
  const e=c.extraction;
  report.cases.push({report:name,engine:host.name,fixture:c.fixture,status:c.status,sourceBytes:c.source?.sourceBytes??null,outputUTF16:e?.totalTextUTF16??null,maxPageUTF16:e?.maxPageUTF16??null,storedPages:e?.storedPages??null,totalMs:e?.totalExtractionMs??null,firstIndexedPageMs:e?.firstIndexedPageMs??null,stageMs:e?.requestTimings?.stagePageText??null,finalizeMs:e?.requestTimings?.publishExtractionPage??null,creditMs:e?.requestTimings?.advanceExtractionPageIndex??null,foreground:e?.foregroundAroundPublication??null,postExtraction:e?.postExtractionObservation??null,cancelDrainMs:e?.cancellationDrainMs??null,rssBaselineKiB:c.memory?.baselineRssKiB??null,rssSampledHighKiB:c.memory?.peakRssKiB??null,heapAvailable:c.heap?.available??false,isolates:(c.heap?.targets??[]).map(t=>({role:t.role,isolateId:t.isolateId,url:t.url,name:t.workerName,sampleCount:t.samples.length,usedSampledHighBytes:t.peakUsedSize,backingSampledHighBytes:t.peakBackingStorageSize,first:t.samples[0]??null,last:t.samples.at(-1)??null,errors:t.errors})),error:c.error??e?.failure??null});
 }
}
await writeFile(resolve(import.meta.dirname,'results/dense-summary.json'),JSON.stringify(report,null,2)+'\n');
for(const c of report.cases) console.log(JSON.stringify({engine:c.engine,fixture:c.fixture,status:c.status,outputUTF16:c.outputUTF16,totalMs:c.totalMs,foregroundP95:c.foreground?.p95Ms,isolates:c.isolates.map(t=>({role:t.role,usedHigh:t.usedSampledHighBytes,backingHigh:t.backingSampledHighBytes,samples:t.sampleCount}))}));
