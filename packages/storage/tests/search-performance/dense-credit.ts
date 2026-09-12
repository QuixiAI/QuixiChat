/** Disposable real SQLite-WASM repository workload; no browser/OPFS latency claim. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SearchRepository } from '../../src/worker/search/index.ts';
import type { SearchBlobAccess } from '../../src/worker/search/index.ts';
import type { PageSourceSpan } from '@quixi/core/contracts';
import { fixture, begin, page, span, stage, publish, canonicalFingerprint } from '../extraction-search/fixture.ts';

const capture = process.env.QUIXI_CREDIT_CAPTURE ?? 'baseline';
assert.match(capture, /^[a-z][a-z0-9-]{0,40}$/);
const f = fixture(), before = canonicalFingerprint(f);
let measuring = false, depth = 0, currentCalls = 0, currentMs = 0;
const statements = new Map<string, { calls: number; ms: number }>();
function measure<T>(sql: string, action: () => T): T {
  if (!measuring || depth) return action();
  depth++; const start = performance.now();
  try { return action(); }
  finally {
    const entry = statements.get(sql) ?? { calls: 0, ms: 0 };
    entry.calls++; entry.ms += performance.now() - start; statements.set(sql, entry); depth--;
  }
}
const originalExec = f.db.exec.bind(f.db), originalScalar = f.db.selectValue.bind(f.db);
f.db.exec = options => measure(typeof options === 'string' ? options : options.sql, () => originalExec(options));
f.db.selectValue = (sql, bind) => measure(sql, () => originalScalar(sql, bind));
const sources = { ...f.repo.publishedSources, current: (ref: Parameters<typeof f.repo.publishedSources.current>[0]) => {
  const start = performance.now();
  try { return f.repo.publishedSources.current(ref); }
  finally { if (measuring) { currentCalls++; currentMs += performance.now() - start; } }
} };
const noBlobs: SearchBlobAccess = {
  async beginVerifiedRead() { throw new Error("Unexpected original verification"); },
  async advanceVerifiedRead() { throw new Error("Unexpected original verification"); },
  async openRead() { throw new Error('Unexpected original read'); }, sliceRead() { throw new Error('Unexpected range'); },
  readChunk() { throw new Error('Unexpected chunk'); }, acknowledge() { throw new Error('Unexpected ACK'); }, async discard() { throw new Error('Unexpected discard'); },
};
const search = new SearchRepository(f.db, noBlobs, { publishedSources: sources });
search.initialize();
const run = begin(f), pages = 10, samples = [];
const sourcePaths = ['packages/storage/src/worker/search/index.ts', 'packages/storage/src/worker/search/extraction.ts',
  'packages/storage/src/worker/search/schema.ts', 'packages/storage/src/worker/search/sources.ts',
  'packages/storage/src/worker/extraction/index.ts', 'packages/storage/src/worker/extraction/schema.ts',
  'packages/core/src/contracts/extraction.ts', 'packages/storage/tests/search-performance/dense-credit.ts',
  'packages/storage/tests/extraction-search/fixture.ts', 'packages/storage/sqlite/artifacts.json'];
const hashSources = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
const sourceSha256 = await hashSources();
try {
  for (let number = 1; number <= pages; number++) {
    const p = page(f, run.runId, number, pages), lines: string[] = [], maps: PageSourceSpan[] = [];
    let sequence = 0, units = 0;
    for (let first = 0; first < 1000; first += 27) {
      const batch: string[] = [], batchMaps: PageSourceSpan[] = [];
      for (let line = first; line < Math.min(first + 27, 1000); line++) {
        const value = (`Quixi document fixture page ${String(number).padStart(3, '0')} line ${String(line).padStart(4, '0')} ` +
          'amber birch cedar delta elm fern grove harbor iris juniper kelp larch maple north oak pine quartz river spruce timber '.repeat(2)).slice(0, 150);
        const source = span(units, value, line);
        source.source!.itemStart = 0; source.source!.itemEnd = value.length;
        batchMaps.push(source, { start: units + 150, end: units + 151, source: null });
        batch.push(value + '\n'); units += 151;
      }
      const text = batch.join('');
      stage(f, p, text, sequence++, units - text.length, batchMaps); lines.push(text); maps.push(...batchMaps);
    }
    const text = lines.join(''); assert.equal(text.length, 151000); assert.equal(maps.length, 2000); assert.equal(sequence, 38);
    const ref = publish(f, p, text, maps, sequence - 1).receipt.pageRef;
    const start = performance.now(), callsBefore = currentCalls; measuring = true;
    let slices = 0;
    try {
      while (!search.isExtractionPageIndexed(ref)) {
        assert.ok(++slices <= 100); await search.advanceExtractionIndex();
      }
    } finally { measuring = false; }
    samples.push({ page: number, elapsedMs: performance.now() - start, slices, currentCalls: currentCalls - callsBefore });
  }
  assert.equal(canonicalFingerprint(f), before);
  const endSha256 = await hashSources(); assert.deepEqual(endSha256, sourceSha256);
  const report = { status: 'passed', finishedAt: new Date().toISOString(), qualification:
    'Synthetic dense text/maps through actual extraction/search repositories and shipped SQLite WASM in Node. Publication is outside timing; index-credit timing includes nested instrumentation. No OPFS, PDF parser or production durable-claim timing claim.',
    pages, textUTF16PerPage: 151000, spansPerPage: 2000, stageBatchesPerPage: 38,
    currentCalls, currentMs, samples, statements: [...statements].map(([sql, stats]) => ({ sql, ...stats })).sort((a, b) => b.ms - a.ms),
    sourceSha256, sourceStable: true, search: search.status() };
  await mkdir(new URL('./results/', import.meta.url), { recursive: true });
  await writeFile(new URL(`./results/dense-credit-${capture}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ samples, currentCalls, currentMs, sqlCalls: report.statements.reduce((n, row) => n + row.calls, 0), top: report.statements.slice(0, 12) }, null, 2));
} finally { measuring = false; await search.close(); f.close(); }
