/** Real shipped repositories, claim registry and pinned SQLite WASM. No OPFS. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Session } from 'node:inspector';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import initialize from '../../sqlite/dist/sqlite3.mjs';
import { CanonicalRepository } from '../../src/worker/canonical/index.ts';
import type { CanonicalSqlite, SqlValue } from '../../src/worker/canonical/index.ts';
import { ExtractionRepository, extractionTextDigest, extractionMapDigest } from '../../src/worker/extraction/index.ts';
import { OperationClaimRegistry, installArchiveOperationClaimFences } from '../../src/worker/operation-claims.ts';
import { DOCUMENT_EXTRACTION_VERSIONS, assertExtractionArgs, canonicalJson } from '@quixi/core/contracts';
import type { PageSourceSpan, ExtractionOperations, ExtractionIdentity } from '@quixi/core/contracts';
import type { JsonValue } from '@quixi/core/model';
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const root = new URL('../../../../', import.meta.url);
const files = ['packages/storage/src/worker/extraction/index.ts','packages/storage/src/worker/extraction/schema.ts','packages/storage/src/worker/operation-claims.ts','packages/core/src/contracts/extraction.ts','packages/core/src/contracts/storage.ts','packages/core/src/model/validation.ts','packages/core/src/contracts/serialization.ts','node_modules/@noble/hashes/sha2.js','node_modules/@noble/hashes/_md.js','node_modules/@noble/hashes/_u64.js','node_modules/@noble/hashes/utils.js','node_modules/@noble/hashes/package.json','packages/storage/src/worker/canonical/repository.ts','packages/storage/migrations/index.ts','packages/storage/src/worker/archives/index.ts','packages/documents/src/persist.ts','packages/documents/src/persist-mutation.ts','perf/documents/generate_dense_fixtures.py','perf/documents/fixtures/dense-manifest.json','packages/storage/tests/extraction-performance/profile.ts','packages/storage/sqlite/dist/sqlite3.wasm','packages/storage/sqlite/dist/sqlite3.mjs','packages/storage/sqlite/artifacts.json'];
const fingerprints = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(new URL(file, root)))])));
const sourceHashes = await fingerprints();
const capture = process.env.QUIXI_STAGE_PROFILE_CAPTURE ?? 'baseline';
assert.ok(['baseline','optimized'].includes(capture));
const cpuArtifact = `${capture}.cpuprofile.gz`;
const pages = Number(process.env.QUIXI_STAGE_PROFILE_PAGES ?? 100);
assert.ok([1,10,100].includes(pages));
const wasm = await readFile(new URL('../../sqlite/dist/sqlite3.wasm', import.meta.url));
const artifacts = JSON.parse(await readFile(new URL('../../sqlite/artifacts.json', import.meta.url), 'utf8'));
assert.equal(hash(wasm), artifacts.artifacts['sqlite3.wasm'].sha256);
(globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }).sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
type Db = CanonicalSqlite & { pointer: number; close(): void };
const initOptions = { instantiateWasm: async (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => { const result = await WebAssembly.instantiate(wasm, imports); success(result.instance, result.module); }, print() {}, printErr() {} };
const sqlite = await initialize(initOptions) as { oo1: { DB: new(name: string, mode: string) => Db }; capi: object };
const raw = new sqlite.oo1.DB('/dense-stage-profile.db', 'c');
let measured = false, phase = 'extraction';
type Metric = { calls: number; ms: number; sql: string };
const sql = new Map<string, Metric>(), phases = new Map<string, { calls: number; ms: number }>();
let pageSql = new Map<string, Metric>();
const category = (statement: string) => {
  if (/sqlite_schema/.test(statement)) return 'schema_guards';
  if (/quixi_local_operation_claims/.test(statement)) return statement.startsWith('INSERT') ? 'claim_insert' : 'claim_lookup';
  if (statement === 'BEGIN IMMEDIATE' || statement === 'COMMIT') return 'transaction';
  if (/^SELECT \* FROM quixi_extract_runs/.test(statement)) return 'run_read';
  if (/^SELECT used_bytes FROM quixi_extract_meta/.test(statement)) return 'accounting_read';
  if (/^UPDATE quixi_extract_(runs|meta) SET used_bytes/.test(statement)) return 'accounting_write';
  if (/quixi_records/.test(statement)) return 'canonical_identity';
  if (/quixi_extract_operations/.test(statement)) return statement.startsWith('INSERT') ? 'receipt_insert' : 'receipt_lookup';
  if (/quixi_extract_text_batches/.test(statement)) return 'text_stage';
  if (/quixi_extract_map_batches/.test(statement)) return 'maps_stage';
  if (/^SELECT \* FROM quixi_extract_documents/.test(statement)) return 'document_current';
  if (/quixi_extract_pages/.test(statement)) return statement.startsWith('UPDATE') ? 'page_checkpoint' : 'page_read';
  return 'other';
};
function timing<T>(statement: string, action: () => T): T {
  if (!measured) return action();
  const started = performance.now();
  try { return action(); } finally {
    const elapsed = performance.now() - started, key = category(statement);
    for (const map of [sql, pageSql]) { const value = map.get(key) ?? { calls: 0, ms: 0, sql: statement }; value.calls++; value.ms += elapsed; map.set(key, value); }
    const value = phases.get(phase) ?? { calls: 0, ms: 0 }; value.calls++; value.ms += elapsed; phases.set(phase, value);
  }
}
const db: Db = {
  get pointer() { return raw.pointer; }, close() { raw.close(); },
  exec(options) { const statement = typeof options === 'string' ? options : options.sql; return timing(statement, () => raw.exec(options)); },
  selectValue(statement, bind) { return timing(statement, () => raw.selectValue(statement, bind)); },
};
const canonical = new CanonicalRepository(db, { assertBlobAvailable(sha, bytes) { assert.equal(sha, originalSha); assert.equal(bytes, original.length); } });
canonical.migrate();
// Install the exact shipped archive receipt table so the production registry
// also executes its optional archive-guard path. No archive byte backend is used.
const archiveSource = await readFile(new URL('packages/storage/src/worker/archives/index.ts', root), 'utf8');
const archiveDDL = archiveSource.match(/CREATE TABLE IF NOT EXISTS quixi_archive_operations[^\n]+;/)?.[0]; assert.ok(archiveDDL);
db.exec(archiveDDL); installArchiveOperationClaimFences(db);
const claims = new OperationClaimRegistry(db, sqlite);
let serial = 1; const id = () => `eeeeeeee-0000-4000-8000-${String(serial++).padStart(12,'0')}`;
const fixtureName = `dense-${pages}.pdf`;
const original = await readFile(new URL(`perf/documents/fixtures/${fixtureName}`, root));
const originalSha = hash(original), dense = JSON.parse(await readFile(new URL('perf/documents/fixtures/dense-manifest.json', root), 'utf8'))[fixtureName];
assert.equal(originalSha, dense.sha256); assert.equal(original.length, dense.bytes);
const identity: ExtractionIdentity = { documentId: id(), attachmentId: id(), attachmentSha256: originalSha, attachmentByteLength: original.length, ...DOCUMENT_EXTRACTION_VERSIONS };
canonical.commit({ transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: [
  { version: 1, operationId: id(), kind: 'RegisterAttachment', recordedAt: 1, payload: { attachment: { id: identity.attachmentId, availability: 'available', filename: fixtureName, mimeType: 'application/pdf', sizeBytes: original.length, blobSha256: originalSha, rawObjectId: null } } },
  { version: 1, operationId: id(), kind: 'RegisterDocument', recordedAt: 1, payload: { document: { id: identity.documentId, workspaceId: id(), attachmentId: identity.attachmentId, title: 'Dense staging diagnostic', createdAt: 1, recordedAt: 1, importSourceId: null } } },
] });
const repository = new ExtractionRepository(db, {
  lookupIdentity(documentId) {
    const before = phase; phase = 'canonical_identity';
    try {
      const doc = canonical.get('documents', documentId), attachment = doc ? canonical.get('attachments', doc.attachmentId) : null;
      return doc && attachment ? { documentId, attachmentId: attachment.id, attachmentSha256: attachment.blobSha256, attachmentByteLength: attachment.sizeBytes, available: attachment.availability === 'available', mediaType: attachment.mimeType ?? '' } : null;
    } finally { phase = before; }
  },
  operations: { claim(value) { const before = phase; phase = 'claim_registry'; try { claims.claim(value); } finally { phase = before; } } },
  supportedVersions: [DOCUMENT_EXTRACTION_VERSIONS],
});
repository.initialize();
const run = repository.execute('beginDocumentExtraction', { operationId: id(), identity });
const inspector = new Session(); inspector.connect();
const post = (method: string, params: object = {}) => new Promise<any>((resolve, reject) => inspector.post(method as any, params, (error, value) => error ? reject(error) : resolve(value)));
await post('Profiler.enable'); await post('Profiler.setSamplingInterval', { interval: 100 }); await post('Profiler.start');
const stages: number[] = [], summaries: unknown[] = [];
let stageTotalMs = 0, publishTotalMs = 0;
function denseBatches(pageNumber: number, pageAttemptId: string): ExtractionOperations['stagePageText']['args'][] {
  const result: ExtractionOperations['stagePageText']['args'][] = [];
  let text = '', spans: PageSourceSpan[] = [], offset = 0;
  const flush = () => { if (!text) return; result.push({ operationId: id(), runId: run.runId, writerEpoch: run.writerEpoch, pageAttemptId, sequence: result.length, expectedUTF16Offset: offset, text, spans }); offset += text.length; text = ''; spans = []; };
  for (let line = 0; line < 1000; line++) {
    const prefix = `Quixi document fixture page ${String(pageNumber).padStart(3,'0')} line ${String(line).padStart(4,'0')} `;
    const content = (prefix + 'amber birch cedar delta elm fern grove harbor iris juniper kelp larch maple north oak pine quartz river spruce timber '.repeat(2)).slice(0,150);
    if (text.length + content.length + 1 > 4096) flush();
    const start = offset + text.length;
    spans.push({ start, end: start + 150, source: { itemIndex: line, itemStart: 0, itemEnd: 150, transform: [8,0,0,8,20,9960-line*9], width: 600, height: 8, direction: 'ltr' } }, { start: start+150, end: start+151, source: null });
    text += content + '\n';
  }
  flush(); assert.equal(result.length,38); assert.equal(offset,151000); assert.equal(result.reduce((sum,batch)=>sum+batch.spans.length,0),2000);
  for(const batch of result) assertExtractionArgs('stagePageText', batch);
  return result;
}
function stageMeasuredBatches(batches: ExtractionOperations['stagePageText']['args'][]) {
  for (const batch of batches) {
    measured = true; const started = performance.now();
    try {
      const result = repository.execute('stagePageText', batch);
      assert.equal(result.committedUTF16Offset, batch.expectedUTF16Offset + batch.text.length);
    } finally { const elapsed = performance.now() - started; measured = false; stages.push(elapsed); stageTotalMs += elapsed; }
  }
}
try {
  for(let pageNumber=1;pageNumber<=pages;pageNumber++) {
    const page = repository.execute('beginExtractionPage', { operationId: id(), runId: run.runId, writerEpoch: run.writerEpoch, page: pageNumber, documentPageCount: pages });
    const batches = denseBatches(pageNumber,page.pageAttemptId); pageSql = new Map(); const before = stageTotalMs;
    stageMeasuredBatches(batches);
    const text = batches.map(batch=>batch.text).join(''), maps = batches.flatMap(batch=>batch.spans), started = performance.now();
    repository.execute('publishExtractionPage', { operationId:id(),runId:run.runId,writerEpoch:run.writerEpoch,pageAttemptId:page.pageAttemptId,lastSequence:37,expectedUTF16Length:151000,expectedTextSha256:extractionTextDigest(text),expectedMapSha256:extractionMapDigest(maps),itemCount:1000,classification:'text',layout:{mode:'geometric',reasons:[],columns:1} });
    publishTotalMs += performance.now()-started;
    if([1,10,100,pages].includes(pageNumber)) summaries.push({page:pageNumber,stageMs:stageTotalMs-before,sql:Object.fromEntries(pageSql)});
    // Same production repository cleanup, outside the measured stage lane.
    for(let slice=0;slice<50;slice++) if(!repository.cleanup({maxRows:32}).rows) break;
  }
  const { profile } = await post('Profiler.stop');
  const cpuJson = JSON.stringify(profile), cpuGzip = gzipSync(cpuJson);
  await writeFile(new URL(`./results/${cpuArtifact}`,import.meta.url),cpuGzip);
  const nodes = new Map<number,any>(profile.nodes.map((node:any)=>[node.id,node])), parents = new Map<number,number>();
  for(const node of profile.nodes) for(const child of node.children??[]) parents.set(child,node.id);
  const cpu = new Map<string,{samples:number;microseconds:number;functionName:string;url:string;line:number}>(); let stageSamples=0, stageSampleUs=0;
  for(let i=0;i<(profile.samples?.length??0);i++) {
    const sample = profile.samples[i], path=[]; let current: number|undefined=sample;
    while(current!==undefined){const node=nodes.get(current);if(!node)break;path.push(node);current=parents.get(current);}
    if(!path.some(node=>node.callFrame.functionName==='stageMeasuredBatches')) continue;
    stageSamples++; stageSampleUs+=profile.timeDeltas[i]??0;
    const node=nodes.get(sample)!, frame=node.callFrame, key=`${frame.url}:${frame.lineNumber}:${frame.functionName}`;
    const value=cpu.get(key)??{samples:0,microseconds:0,functionName:frame.functionName,url:frame.url,line:frame.lineNumber+1}; value.samples++;value.microseconds+=profile.timeDeltas[i]??0;cpu.set(key,value);
  }
  const final = repository.execute('getDocumentExtraction',{documentId:identity.documentId}); assert.equal(final?.completedPage,pages);
  const count = Number(db.selectValue("SELECT count(*) FROM quixi_extract_operations WHERE kind='stagePageText'")); assert.equal(count,pages*38);
  assert.equal(db.selectValue("SELECT count(*) FROM quixi_local_operation_claims WHERE domain='extraction'"), db.selectValue('SELECT count(*) FROM quixi_extract_operations'));
  const sorted = [...stages].sort((a,b)=>a-b), afterHashes = await fingerprints();
  const report={completedAt:new Date().toISOString(),backend:'pinned SQLite WASM Node memory VFS; no PDF.js, worker messaging, OPFS or browser timing claim',node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,loadAverage:os.loadavg(),pages,source:{fixtureName,byteLength:original.length,sha256:originalSha},stages:stages.length,perPage:{utf16:151000,spans:2000,batches:38},stageTotalMs,publishTotalMs,stageP50Ms:sorted[Math.floor(sorted.length*.5)],stageP95Ms:sorted[Math.floor(sorted.length*.95)],sql:Object.fromEntries(sql),sqlByPhase:Object.fromEntries(phases),pageSamples:summaries,cpuSampling:{artifact:cpuArtifact,uncompressedSha256:hash(cpuJson),compressedSha256:hash(cpuGzip),compressedBytes:cpuGzip.length,intervalMicroseconds:100,stageSamples,stageSampleUs,topSelf:[...cpu.values()].sort((a,b)=>b.microseconds-a.microseconds).slice(0,30)},sourceHashes,sourceStable:JSON.stringify(sourceHashes)===JSON.stringify(afterHashes)};
  assert.equal(report.sourceStable,true,'Runtime changed during profiling');
  await writeFile(new URL(`./results/${capture}.json`,import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({pages,stages:report.stages,stageTotalMs,publishTotalMs,p50:report.stageP50Ms,p95:report.stageP95Ms,sql:report.sql,phases:report.sqlByPhase,cpuTop:report.cpuSampling.topSelf.slice(0,12)},null,2));
} finally { inspector.disconnect(); repository.close(); db.close(); }
