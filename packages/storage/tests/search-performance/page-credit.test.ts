import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchRepository } from '../../src/worker/search/index.ts';
import type { SearchBlobAccess } from '../../src/worker/search/index.ts';
import type { CanonicalSqlite } from '../../src/worker/canonical/index.ts';
import type { PageSourceSpan } from '@quixi/core/contracts';
import { fixture, begin, page, span, stage, publish, next, rows, status } from '../extraction-search/fixture.ts';
const noBlobs: SearchBlobAccess = {
  async beginVerifiedRead() { throw new Error("Unexpected original verification"); },
  async advanceVerifiedRead() { throw new Error("Unexpected original verification"); },
  async openRead() { throw new Error('Unexpected original read'); }, sliceRead() { throw new Error('Unexpected range'); }, readChunk() { throw new Error('Unexpected chunk'); }, acknowledge() { throw new Error('Unexpected ACK'); }, async discard() { throw new Error('Unexpected discard'); },
};
function setup() {
  const f = fixture(), statements: string[] = [];
  let notifications = 0, currentChecks = 0;
  const db: CanonicalSqlite = {
    exec(options) { statements.push(typeof options === 'string' ? options : options.sql); return f.db.exec(options); },
    selectValue(sql, bind) { statements.push(sql); return f.db.selectValue(sql, bind); },
  };
  const publishedSources = { ...f.repo.publishedSources, current(ref: Parameters<typeof f.repo.publishedSources.current>[0]) {
    currentChecks++; return f.repo.publishedSources.current(ref);
  } };
  const search = new SearchRepository(db, noBlobs, { publishedSources, onProgress() { notifications++; } });
  search.initialize();
  return { f, search, statements, get notifications() { return notifications; }, get currentChecks() { return currentChecks; }, async close() { await search.close(); f.close(); } };
}
function publishText(f: ReturnType<typeof fixture>, runId: string, text: string, number = 1, count = 1) {
  const p = page(f, runId, number, count), maps: PageSourceSpan[] = [];
  let sequence = 0;
  for (let offset = 0; offset < text.length; offset += 4096) {
    const fragment = text.slice(offset, offset + 4096), map = span(offset, fragment);
    maps.push(map); stage(f, p, fragment, sequence++, offset, [map]);
  }
  return publish(f, p, text, maps, sequence - 1).receipt.pageRef;
}
function assertNoGlobalScan(statements: string[]) {
  assert.ok(!statements.some(sql => sql.startsWith('SELECT count(*) FROM quixi_search_chunks')), 'Page credit must not count the archive');
  assert.ok(!statements.some(sql => sql.startsWith('SELECT EXISTS(SELECT 1 FROM quixi_search_page_refs er LEFT')), 'Page credit must not scan healthy page refs');
  assert.ok(!statements.some(sql => sql.startsWith('SELECT EXISTS(SELECT 1 FROM quixi_search_chunks c WHERE NOT EXISTS')), 'Page credit must not scan healthy chunks');
}
async function index(s: ReturnType<typeof setup>, ref: ReturnType<typeof publishText>) {
  for (let attempt = 0; attempt < 250; attempt++) {
    s.statements.length = 0;
    await s.search.advanceExtractionIndex();
    assertNoGlobalScan(s.statements);
    assert.ok(s.statements.filter(sql => sql.startsWith('INSERT INTO quixi_search_chunks(')).length <= 4);
    if (s.search.isExtractionPageIndexed(ref)) return;
  }
  throw new Error('Page credit failed to converge');
}

test('growing page population has no page-credit global scan or summary; public status stays exact', async () => {
  const s = setup();
  try {
    const run = begin(s.f);
    for (let number = 1; number <= 100; number++) {
      const ref = publishText(s.f, run.runId, 'Navigation searchable 日本語\u0000 text. '.repeat(4), number, 100);
      await index(s, ref);
    }
    assert.equal(s.notifications, 0, 'Private page credit has no global summary callback');
    s.statements.length = 0;
    const status = s.search.status();
    assert.equal(status.state, 'ready');
    assert.equal(status.indexedChunks, 100, '100 one-chunk published pages');
    assert.ok(s.statements.some(sql => sql.startsWith('SELECT count(*) FROM quixi_search_chunks')));
    const publicResult = await s.search.advance({ maxChunks: 4 });
    assert.equal(publicResult.indexedChunks, status.indexedChunks);
    assert.ok(s.notifications > 0, 'Ordinary public advance retains progress summaries');
  } finally { await s.close(); }
});

test('long and empty pages retain exact credit and the four-chunk write cap', async () => {
  const s = setup();
  try {
    const run = begin(s.f);
    const ref = publishText(s.f, run.runId, ('Words 日本語\u0000 text in a long paragraph.\n').repeat(5000), 1, 2);
    s.statements.length = 0;
    await s.search.advanceExtractionIndex();
    assert.equal(s.search.isExtractionPageIndexed(ref), false, 'Partial chunk writes cannot grant page credit');
    assert.ok(s.statements.filter(sql => sql.startsWith('INSERT INTO quixi_search_chunks(')).length <= 4);
    await index(s, ref);
    const empty = publishText(s.f, run.runId, '', 2, 2);
    await index(s, empty);
    assert.equal(s.search.isExtractionPageIndexed(ref), true);
    assert.equal(s.search.isExtractionPageIndexed(empty), true);
    assert.equal(Number(s.f.db.selectValue('SELECT count(*) FROM quixi_search_chunks WHERE source_key=?', [`e:${empty.pageAttemptId}`])), 0);
  } finally { await s.close(); }
});

test('dense page credit bounds redundant checks but revalidates a cleared source at the next admission', async () => {
  const s = setup();
  try {
    const run = begin(s.f), ref = publishText(s.f, run.runId, 'Dense page searchable words and provenance. '.repeat(3500));
    for (let slice = 0; slice < 2; slice++) {
      const before = s.currentChecks; s.statements.length = 0;
      await s.search.advanceExtractionIndex();
      assert.ok(s.currentChecks - before >= 1, 'Every admission revalidates its held source');
      assert.ok(s.currentChecks - before <= 3, 'At most one segment check plus the two publication checks');
      assert.equal(s.statements.filter(sql => sql.startsWith('INSERT INTO quixi_search_chunks(')).length, 4);
    }
    assert.equal(s.search.isExtractionPageIndexed(ref), false);
    s.f.repo.execute('clearDocumentExtraction', { operationId: next(), documentId: ref.identity.documentId,
      expectedRunId: run.runId, expectedDocumentRevision: status(s.f).documentRevision });
    s.statements.length = 0;
    await s.search.advanceExtractionIndex();
    assert.equal(s.statements.filter(sql => sql.startsWith('INSERT INTO quixi_search_chunks(')).length, 0);
    assert.equal(s.search.isExtractionPageIndexed(ref), false, 'Cached validation never survives an admission boundary');
  } finally { await s.close(); }
});

test('publication retains fresh source checks even after the synchronous page check was reused', async () => {
  const f = fixture(); let checks = 0, invalidateAt = Infinity;
  const publishedSources = { ...f.repo.publishedSources, current(ref: Parameters<typeof f.repo.publishedSources.current>[0]) {
    if (++checks === invalidateAt) f.repo.execute('clearDocumentExtraction', { operationId: next(), documentId: ref.identity.documentId,
      expectedRunId: ref.runId, expectedDocumentRevision: status(f).documentRevision });
    return f.repo.publishedSources.current(ref);
  } };
  const search = new SearchRepository(f.db, noBlobs, { publishedSources }); search.initialize();
  try {
    const run = begin(f), ref = publishText(f, run.runId, 'A small original searchable page.');
    // The segment check succeeds; force a source change at the independent
    // publication check. This hook models the fence, not an actual JS interleave.
    invalidateAt = 2;
    await search.advanceExtractionIndex();
    assert.ok(checks >= 2);
    assert.equal(search.isExtractionPageIndexed(ref), false);
    assert.equal(Number(f.db.selectValue('SELECT count(*) FROM quixi_search_heads WHERE source_key=?', [`e:${ref.pageAttemptId}`])), 0);
  } finally { await search.close(); f.close(); }
});

test('replacement and held source fences survive deferred cleanup; ordinary maintenance reclaims stale chunks', async () => {
  const s = setup();
  try {
    const first = begin(s.f);
    const old = publishText(s.f, first.runId, 'Obsolete original navigation text.'); await index(s, old);
    const oldChunks = Number(s.f.db.selectValue('SELECT count(*) FROM quixi_search_chunks WHERE source_key=?', [`e:${old.pageAttemptId}`])); assert.ok(oldChunks > 0);
    s.f.repo.execute('completeDocumentExtraction', { operationId: next(), runId: first.runId, writerEpoch: first.writerEpoch });
    const replacement = begin(s.f, { normalizerVersion: 'identity-v2' });
    const current = publishText(s.f, replacement.runId, ('Replacement 日本語 current text.\n').repeat(5000));
    await s.search.advanceExtractionIndex();
    assert.equal(s.search.isExtractionPageIndexed(old), false);
    assert.equal(s.search.isExtractionPageIndexed(current), false);
    s.f.repo.execute('clearDocumentExtraction', { operationId: next(), documentId: current.identity.documentId, expectedRunId: replacement.runId, expectedDocumentRevision: status(s.f).documentRevision });
    for (let i = 0; i < 5; i++) await s.search.advanceExtractionIndex();
    assert.equal(s.search.isExtractionPageIndexed(current), false, 'Held stale source may never publish');
    for (let i = 0; i < 100; i++) { const status = await s.search.advance({ maxChunks: 4 }); if (status.state === 'ready') break; }
    assert.equal(s.search.status().state, 'ready');
    assert.equal(rows(s.f.db, "SELECT 1 FROM quixi_search_chunks WHERE source_key IN(?,?)", [`e:${old.pageAttemptId}`, `e:${current.pageAttemptId}`]).length, 0);
  } finally { await s.close(); }
});
