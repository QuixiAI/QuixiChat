/** Read-only production instrumentation; writes only disposable fixture databases. */
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SearchRepository } from '../../src/worker/search/index.ts';
import type { SearchBlobAccess } from '../../src/worker/search/index.ts';
import type { CanonicalSqlite } from '../../src/worker/canonical/index.ts';
import { fixture, begin, page, span, stage, publish, rows } from '../extraction-search/fixture.ts';

const pages = Number(process.env.QUIXI_PERF_PAGES ?? 1000);
const capture = process.env.QUIXI_PERF_CAPTURE ?? 'baseline';
assert.ok(['baseline', 'optimized'].includes(capture));
assert.ok(Number.isInteger(pages) && pages >= 10 && pages <= 1000);
const f = fixture();
let active = false;
type Stats = { calls: number; ms: number; sql: string };
let sample = new Map<string, Stats>();
const total = new Map<string, Stats>();
const classify = (sql: string) => {
  if (sql.startsWith('SELECT count(*) FROM quixi_search_chunks')) return 'visible_chunk_count';
  if (sql.startsWith('SELECT EXISTS(SELECT 1 FROM quixi_search_page_refs er LEFT')) return 'obsolete_page_refs';
  if (sql.startsWith('SELECT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE NOT EXISTS')) return 'obsolete_chunks';
  if (sql.startsWith('SELECT * FROM quixi_search_queue WHERE failed=0 ORDER')) return 'queue_pick';
  if (sql.startsWith('SELECT count(*) FROM quixi_search_queue')) return 'queue_count';
  return 'other';
};
function measure<T>(sql: string, action: () => T): T {
  if (!active) return action();
  const started = performance.now();
  try { return action(); }
  finally {
    const elapsed = performance.now() - started, key = classify(sql);
    for (const map of [sample, total]) {
      const value = map.get(key) ?? { calls: 0, ms: 0, sql };
      value.calls++; value.ms += elapsed; map.set(key, value);
    }
  }
}
const db: CanonicalSqlite = {
  exec(options) { const sql = typeof options === 'string' ? options : options.sql; return measure(sql, () => f.db.exec(options)); },
  selectValue(sql, bind) { return measure(sql, () => f.db.selectValue(sql, bind)); },
};
const noBlobs: SearchBlobAccess = {
  async beginVerifiedRead() { throw new Error("Unexpected original verification"); },
  async advanceVerifiedRead() { throw new Error("Unexpected original verification"); },
  async openRead() { throw new Error('Unexpected original read'); }, sliceRead() { throw new Error('Unexpected range'); }, readChunk() { throw new Error('Unexpected chunk'); }, acknowledge() { throw new Error('Unexpected ACK'); }, async discard() { throw new Error('Unexpected discard'); },
};
let progressCalls = 0;
const search = new SearchRepository(db, noBlobs, { publishedSources: f.repo.publishedSources, onProgress() { progressCalls++; } });
search.initialize();
const run = begin(f);
const samples = [];
let totalAdvanceMs = 0, admissions = 0;
try {
  for (let number = 1; number <= pages; number++) {
    const text = `Synthetic page ${number} with small searchable words and Unicode 日本語. `.padEnd(159, 'x');
    const p = page(f, run.runId, number, pages), map = span(0, text);
    stage(f, p, text, 0, 0, [map]);
    const ref = publish(f, p, text, [map]).receipt.pageRef;
    let ready = false;
    for (let slices = 0; !ready && slices < 20; slices++) {
      sample = new Map(); const beforeProgress = progressCalls;
      active = true; const start = performance.now();
      await search.advanceExtractionIndex();
      const advanceMs = performance.now() - start;
      active = false; totalAdvanceMs += advanceMs; admissions++;
      ready = search.isExtractionPageIndexed(ref);
      if ([1, 10, 100, 500, pages].includes(number)) samples.push({ page: number, slices, advanceMs, progressCalls: progressCalls - beforeProgress, stats: Object.fromEntries(sample) });
    }
    assert.ok(ready);
  }
  const queryPlans = Object.fromEntries([...total].filter(([key]) => key !== 'other').map(([key, value]) => [key, rows(f.db, 'EXPLAIN QUERY PLAN ' + value.sql, value.sql.includes('h.epoch=?') ? [1] : [])]));
  const sourceHashes: Record<string, string> = {};
  for (const file of ['packages/storage/src/worker/search/index.ts', 'packages/storage/src/worker/search/schema.ts', 'packages/storage/src/worker/search/extraction.ts', 'packages/storage/src/worker/archive-database.ts', 'packages/storage/tests/search-performance/diagnose.ts']) sourceHashes[file] = createHash('sha256').update(await readFile(file)).digest('hex');
  const report = { completedAt: new Date().toISOString(), backend: 'pinned SQLite WASM in Node fixture; no OPFS/browser timing claim', pages, admissions, totalAdvanceMs, total: Object.fromEntries(total), samples, queryPlans, sourceHashes };
  await mkdir(new URL('./results/', import.meta.url), { recursive: true });
  await writeFile(new URL(`./results/${capture}.json`, import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ pages, admissions, totalAdvanceMs, categories: [...total].map(([key, value]) => ({ key, calls: value.calls, ms: value.ms })), samples: samples.map(({ page, advanceMs, progressCalls }) => ({ page, advanceMs, progressCalls })) }, null, 2));
} finally { await search.close(); f.close(); }
