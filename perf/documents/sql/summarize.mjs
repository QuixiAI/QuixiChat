import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const name=process.argv[2];if(process.argv.length!==3 || !/^dense-sql-[a-z0-9-]+$/.test(name??''))throw new Error('Pass one dense-sql-* report basename');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bytes=await readFile(resolve(import.meta.dirname,'../results',name+'.json'));const report=JSON.parse(bytes);
if(report.status!=='passed'||!report.sourceStable||!report.method.sqlDiagnostic)throw new Error('A completed source-stable SQL diagnostic is required');
const result={report:name,reportSha256:hash(bytes),analysisToolSha256:hash(await readFile(new URL(import.meta.url))),method:'Fixed-category synchronous SQLite OO1 adapter time includes wasm/bind/step/IO/result conversion. Fenced scope residual is not isolated CPU/serialization. Client minus scope includes queue/protocol/scheduling. No per-call SQL trace or values.',cases:[]};
for(const host of report.hosts)for(const c of host.cases){
 const s=c.sql; if(!s||s.activeScopes||s.overlapScopes||s.overflowCalls)throw new Error('Ambiguous/overflowed SQL capture');
 const stage=s.operations.find(op=>op.operation==='stagePageText');const rows=s.rows.filter(row=>row.operation==='stagePageText');
 if(!stage||stage.count!==c.extraction.stageBatches||stage.errors||rows.some(row=>row.errors))throw new Error('Staging scope/count/error mismatch');
 const total=predicate=>rows.filter(predicate).reduce((sum,row)=>sum+row.totalMs,0);
 const sqlMs=total(()=>true),clientMs=c.extraction.requestTimings.stagePageText.totalMs;
 const groups=new Map();for(const row of s.rows){const key=`${row.operation==='unattributed'?'unattributed':'scoped'}|${row.database}|${row.category}`;const group=groups.get(key)??{group:key,count:0,totalMs:0};group.count+=row.count;group.totalMs+=row.totalMs;groups.set(key,group);}
 result.cases.push({engine:host.name,fixture:c.fixture,stageCalls:stage.count,sourceSha256:c.source.sourceSha256,outputUTF16:c.extraction.totalTextUTF16,stagedSpans:c.extraction.totalStagedSpans,clientStageMs:clientMs,fencedStageMs:stage.totalMs,sqlStageMs:sqlMs,archiveCommitMs:total(row=>row.database==='archive'&&row.category==='transaction.commit'),claimWriteMs:total(row=>row.category==='claim.write'),selectionSqlMs:total(row=>row.database==='selection'),schemaReadMs:total(row=>row.database==='archive'&&row.category==='schema.read'),scopeResidualMs:stage.totalMs-sqlMs,clientMinusScopeMs:clientMs-stage.totalMs,unattributedSqlMs:s.rows.filter(row=>row.operation==='unattributed').reduce((sum,row)=>sum+row.totalMs,0),stageSqlCalls:rows.reduce((sum,row)=>sum+row.count,0),stageRows:rows.sort((a,b)=>b.totalMs-a.totalMs),allGroups:[...groups.values()].sort((a,b)=>b.totalMs-a.totalMs)});
}
await writeFile(resolve(import.meta.dirname,'../results',name+'-summary.json'),JSON.stringify(result,null,2)+'\n');
for(const c of result.cases)console.log(JSON.stringify({fixture:c.fixture,stageCalls:c.stageCalls,clientMsPerCall:c.clientStageMs/c.stageCalls,scopeMsPerCall:c.fencedStageMs/c.stageCalls,sqlMsPerCall:c.sqlStageMs/c.stageCalls,commitMsPerCall:c.archiveCommitMs/c.stageCalls,selectionSqlMsPerCall:c.selectionSqlMs/c.stageCalls,residualMsPerCall:c.scopeResidualMs/c.stageCalls,unattributedSqlMs:c.unattributedSqlMs}));
