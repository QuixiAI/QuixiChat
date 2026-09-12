import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const names=process.argv.slice(2);
if(names.length!==2 || names.some(name=>!/^dense-[a-z0-9-]+$/.test(name))) throw new Error('Pass cleanup baseline and combined-storage dense-* report basenames');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inputs=await Promise.all(names.map(async name=>{const bytes=await readFile(resolve(import.meta.dirname,'results',name+'.json'));return {name,sha256:hash(bytes),report:JSON.parse(bytes)};}));
const [before,after]=inputs.map(row=>row.report);
if(inputs.some(row=>row.report.status!=='passed' || !row.report.sourceStable || row.report.method.gcDiagnostic)) throw new Error('Comparison requires completed stable no-GC captures');
const keys=[...new Set([...Object.keys(before.sourceSha256),...Object.keys(after.sourceSha256)])].sort();
const differences=keys.filter(key=>before.sourceSha256[key]!==after.sourceSha256[key]);
if(JSON.stringify(differences)!=='["packages/storage/src/worker/extraction/index.ts","packages/storage/src/worker/search/index.ts"]') throw new Error('Unexpected source difference: '+JSON.stringify(differences));
const result={analysisToolSha256:hash(await readFile(new URL(import.meta.url))),reports:inputs.map(({name,sha256,report})=>({name,sha256,startLoadAverage:report.environment.startLoadAverage,endLoadAverage:report.endLoadAverage})),sourceDifferencePaths:differences,harnessHashesEqual:true,method:'Same captured harness and original fixture bytes. Numeric output/provenance bounds equivalence only, not a full text/map hash proof. One capture per case; timings and no-GC sampled highs are not statistical effect estimates or hard/peak memory bounds. GC diagnostic is excluded.',cases:[]};
for(const host of before.hosts) for(const old of host.cases){
 const next=after.hosts.find(row=>row.name===host.name)?.cases.find(row=>row.fixture===old.fixture);
 if(!next || old.status!=='passed' || next.status!=='passed') throw new Error('Missing passing case');
 const fields=['totalTextUTF16','maxPageUTF16','storedPages','pageCount','stageBatches','maxStageUTF16','maxStageSpans','totalStagedSpans','maxPageSpans','highestReferencedItemIndex','indexedThroughPage','activePdfWorkers','canonicalRecords','syncOperations'];
 const equality=Object.fromEntries(fields.map(key=>[key,old.extraction[key]===next.extraction[key]]));
 if(Object.values(equality).some(value=>!value) || old.source.sourceSha256!==next.source.sourceSha256 || old.source.sourceBytes!==next.source.sourceBytes || JSON.stringify(old.extraction.pageFinalizations.map(p=>[p.page,p.textUTF16]))!==JSON.stringify(next.extraction.pageFinalizations.map(p=>[p.page,p.textUTF16]))) throw new Error('Output/source numeric equivalence mismatch');
 const metric=c=>({foregroundBaseline:c.extraction.foregroundBaseline,caseStartLoadAverage:c.loadAverage,totalMs:c.extraction.totalExtractionMs,firstIndexedPageMs:c.extraction.firstIndexedPageMs,foregroundP95Ms:c.extraction.foregroundAroundPublication.p95Ms,stageTotalMs:c.extraction.requestTimings.stagePageText.totalMs,creditTotalMs:c.extraction.requestTimings.advanceExtractionPageIndex.totalMs,publicationTotalMs:c.extraction.requestTimings.publishExtractionPage.totalMs,publicationP95Ms:c.extraction.requestTimings.publishExtractionPage.p95Ms,cancelDrainMs:c.extraction.cancellationDrainMs,rssSampledHighKiB:c.memory.peakRssKiB,heap:(c.heap?.targets??[]).map(t=>({role:t.role,usedSampledHighBytes:t.peakUsedSize,backingSampledHighBytes:t.peakBackingStorageSize,samples:t.samples.length}))});
 const a=metric(old),b=metric(next);
 result.cases.push({engine:host.name,fixture:old.fixture,numericOutputEquivalent:true,outputUTF16:next.extraction.totalTextUTF16,totalSpans:next.extraction.totalStagedSpans,sourceSha256:next.source.sourceSha256,before:a,after:b,totalTimeChangePercent:(b.totalMs/a.totalMs-1)*100});
}
await writeFile(resolve(import.meta.dirname,'results/dense-storage-comparison.json'),JSON.stringify(result,null,2)+'\n');
for(const c of result.cases)console.log(JSON.stringify(c));
