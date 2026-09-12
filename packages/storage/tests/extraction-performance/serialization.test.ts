/** Digest compatibility exercises the production execute path and real SQLite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalJson, assertExtractionArgs } from '@quixi/core/contracts';
import type { ExtractionOperations, PageSourceSpan } from '@quixi/core/contracts';
import type { JsonValue } from '@quixi/core/model';
import { extractionDigest, extractionTextDigest, extractionMapDigest } from '../../src/worker/extraction/index.ts';
import { fixture, begin, page, span, next, rows, identity } from '../extraction-search/fixture.ts';

type Write = Exclude<{ [K in keyof ExtractionOperations]: ExtractionOperations[K]['args'] extends { operationId: string } ? K : never }[keyof ExtractionOperations], 'getExtractionOperation'>;
const oldDigest = <K extends Write>(operation: K, input: ExtractionOperations[K]['args']) => {
  // Frozen pre-change algorithm: canonicalize/clone, then canonicalize envelope.
  const args = JSON.parse(canonicalJson(input as unknown as JsonValue));
  return extractionDigest({ operation, args });
};
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k,reverseKeys(v)])) as T;
  return value;
}
const code = (value: string) => (e: unknown) => (e as { code: string }).code === value;

test('all eight write operations retain prior digests, current receipts and key-order-independent replay', () => {
  const f = fixture(), seen = new Set<Write>();
  const replay: (() => void)[] = [];
  function execute<K extends Write>(operation: K, input: ExtractionOperations[K]['args']): ExtractionOperations[K]['result'] {
    assertExtractionArgs(operation,input);
    const digest = oldDigest(operation,input), result = f.repo.execute(operation, reverseKeys(input));
    const stored = f.repo.execute('getExtractionOperation',{operationId:input.operationId});
    assert.equal(stored.status,'committed');
    if(stored.status === 'committed') { assert.equal(stored.requestDigest,digest,operation); assert.deepEqual(stored.result,result); }
    replay.push(() => assert.deepEqual(f.repo.execute(operation,reverseKeys(input)),result));
    seen.add(operation); return result;
  }
  try {
    const run = execute('beginDocumentExtraction',{operationId:next(),identity});
    let epoch = run.writerEpoch;
    for(let n=1;n<=2;n++) {
      const p = execute('beginExtractionPage',{operationId:next(),runId:run.runId,writerEpoch:epoch,page:n,documentPageCount:2});
      // UTF-16 surrogate pair, NUL, controls, quote, slash, backslash, composed
      // and decomposed Unicode, and a line separator all retain exact bytes.
      const text = '日本語 😀\0\n\r\t"\\/ café e\u0301 \u2028 paragraph';
      const spans: PageSourceSpan[] = [span(0,text)];
      spans[0]!.source!.transform = [1,-0,0,1,-1.25,1e-7];
      const base = {runId:run.runId,writerEpoch:epoch,pageAttemptId:p.pageAttemptId};
      execute('stagePageText',{...base,operationId:next(),sequence:0,expectedUTF16Offset:0,text,spans});
      execute('publishExtractionPage',{...base,operationId:next(),lastSequence:0,expectedUTF16Length:text.length,
        expectedTextSha256:extractionTextDigest(text),expectedMapSha256:extractionMapDigest(spans),itemCount:1,classification:'text',
        ...(n===1 ? {layout:{mode:'source_order' as const,reasons:['rotated_or_skewed' as const,'non_ltr' as const],columns:1 as const}} : {})});
      if(n===1) {
        execute('interruptDocumentExtraction',{operationId:next(),runId:run.runId,writerEpoch:epoch,reason:'user_cancelled'});
        const resumed = execute('resumeDocumentExtraction',{operationId:next(),runId:run.runId,expectedWriterEpoch:epoch}); epoch=resumed.writerEpoch;
      }
    }
    const complete = execute('completeDocumentExtraction',{operationId:next(),runId:run.runId,writerEpoch:epoch});
    execute('clearDocumentExtraction',{operationId:next(),documentId:identity.documentId,expectedRunId:run.runId,expectedDocumentRevision:complete.documentRevision});
    assert.deepEqual([...seen].sort(),['beginDocumentExtraction','resumeDocumentExtraction','beginExtractionPage','stagePageText','publishExtractionPage','completeDocumentExtraction','interruptDocumentExtraction','clearDocumentExtraction'].sort());
    const before = rows(f.db,'SELECT * FROM quixi_extract_operations ORDER BY id');
    for(const check of replay) check();
    f.reopen(); for(const check of replay) check();
    assert.deepEqual(rows(f.db,'SELECT * FROM quixi_extract_operations ORDER BY id'),before);
  } finally { f.close(); }
});

test('frozen actual v1 stage and publication receipts remain exact through the optimized digest path', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../extraction-layout/fixtures/v1.json',import.meta.url),'utf8'));
  const manifest = JSON.parse(await readFile(new URL('../extraction-layout/fixtures/extraction-v1-manifest.json',import.meta.url),'utf8'));
  assert.equal(createHash('sha256').update(await readFile(new URL('../extraction-layout/fixtures/extraction-v1.mjs',import.meta.url))).digest('hex'),manifest.bundleSha256);
  const f = fixture();
  try {
    for(const [operation, vector] of [['stagePageText',snapshot.staged],['publishExtractionPage',snapshot.published]] as const) {
      const row = snapshot.records.quixi_extract_operations.find((r: {id:string}) => r.id === vector.args.operationId);
      assert.ok(row); assert.equal(oldDigest(operation,vector.args),row.digest);
      // Import the unchanged genuine old receipt; full v1 database upgrade and
      // published text/map preservation are covered by extraction-layout tests.
      f.db.exec({sql:'INSERT INTO quixi_extract_operations VALUES(?,?,?,?,?,?)',bind:[row.id,row.kind,row.digest,row.run_id,row.result,row.bytes]});
      assert.deepEqual(f.repo.execute(operation,reverseKeys(vector.args)),vector.receipt);
      const changed = {...vector.args,...(operation==='stagePageText' ? {text:vector.args.text.replace(/./u,'X')} : {itemCount:vector.args.itemCount+1})};
      assert.throws(() => f.repo.execute(operation,changed),code('CONFLICT'));
    }
  } finally { f.close(); }
});

test('caller mutation after cloning cannot change nested text/maps, persisted digest or replay identity', () => {
  const f = fixture();
  try {
    const run=begin(f), p=page(f,run.runId), text='Original immutable 日本語 😀 text';
    const args: ExtractionOperations['stagePageText']['args'] = {...p,operationId:next(),sequence:0,expectedUTF16Offset:0,text,spans:[span(0,text)]};
    const original=structuredClone(args), expected=oldDigest('stagePageText',args), exec=f.db.exec.bind(f.db);
    let mutated=false;
    f.db.exec = options => {
      if(!mutated && typeof options!=='string' && options.sql==='SELECT kind,digest,result FROM quixi_extract_operations WHERE id=?') {
        mutated=true; args.text='Changed'; args.runId=next(); args.spans[0]!.source!.transform[0]=999; args.spans[0]!.end=1;
      }
      return exec(options);
    };
    const result=f.repo.execute('stagePageText',args); f.db.exec=exec;
    assert.ok(mutated); assert.equal(result.committedUTF16Offset,text.length);
    assert.equal(f.db.selectValue('SELECT text FROM quixi_extract_text_batches WHERE page_id=?',[p.pageAttemptId]),text);
    const map=String(f.db.selectValue('SELECT maps FROM quixi_extract_map_batches WHERE page_id=?',[p.pageAttemptId]));
    assert.deepEqual(JSON.parse(map),original.spans);
    assert.equal(f.db.selectValue('SELECT digest FROM quixi_extract_operations WHERE id=?',[original.operationId]),expected);
    assert.deepEqual(f.repo.execute('stagePageText',original),result);
    assert.throws(() => f.repo.execute('stagePageText',args),code('INVALID_REQUEST'));
  } finally { f.close(); }
});

test('non-finite values, unknown keys and oversized control data still fail before claiming or writing', () => {
  const f=fixture();
  try {
    const run=begin(f), p=page(f,run.runId), text='Bounded stage text';
    const valid={...p,operationId:next(),sequence:0,expectedUTF16Offset:0,text,spans:[span(0,text)]};
    const before=rows(f.db,'SELECT * FROM quixi_extract_operations ORDER BY id');
    const claims=rows(f.db,'SELECT * FROM proof_operation_claims ORDER BY id');
    const invalid=[{...valid,writerEpoch:NaN},{...valid,unknown:'not accepted'},{...valid,text:'x'.repeat(65537)}];
    for(const args of invalid) assert.throws(()=>f.repo.execute('stagePageText',args),code('INVALID_REQUEST'));
    assert.deepEqual(rows(f.db,'SELECT * FROM quixi_extract_operations ORDER BY id'),before);
    assert.deepEqual(rows(f.db,'SELECT * FROM proof_operation_claims ORDER BY id'),claims);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_text_batches'),0);
  } finally { f.close(); }
});
