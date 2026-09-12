import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assertPageLayout, assertExtractionArgs, jsonByteLength } from '@quixi/core/contracts';
import type { ExtractionOperations, PageLayout } from '@quixi/core/contracts';
import { fixture, begin, page, span, stage, publish, next, rows, identity, status } from '../extraction-search/fixture.ts';
import { extractionTextDigest, extractionMapDigest } from '../../src/worker/extraction/index.ts';
import { EXTRACTION_SCHEMA_V1 } from '../../src/worker/extraction/schema.ts';
import { ExtractionRepository as OldRepository } from './fixtures/extraction-v1.mjs';
const snapshot = JSON.parse(await readFile(new URL('./fixtures/v1.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('./fixtures/extraction-v1-manifest.json', import.meta.url), 'utf8'));
assert.equal(createHash('sha256').update(await readFile(new URL('./fixtures/extraction-v1.mjs', import.meta.url))).digest('hex'), manifest.bundleSha256);
const code = (value: string) => (e: unknown) => (e as { code: string }).code === value;
const layout: PageLayout = { mode: 'source_order', reasons: ['non_ltr', 'rotated_or_skewed'], columns: 1 };
function restoreV1(f: ReturnType<typeof fixture>) {
  const names = rows(f.db, "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'quixi_extract_*'");
  f.db.exec('BEGIN');
  for (const { name } of names) f.db.exec(`DROP TABLE ${name}`);
  f.db.exec(EXTRACTION_SCHEMA_V1);
  for (const [table, records] of Object.entries(snapshot.records) as [string, Record<string,string|number|null>[]][]) {
    assert.match(table, /^quixi_extract_[a-z_]+$/);
    for (const row of records) f.db.exec({ sql: `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`, bind: Object.values(row) });
  }
  f.db.exec('DELETE FROM proof_operation_claims');
  for (const row of snapshot.claims as Record<string,string>[]) f.db.exec({ sql: 'INSERT INTO proof_operation_claims(id,domain,digest) VALUES(?,?,?)', bind: [row.id!, row.domain!, row.digest!] });
  f.db.exec('COMMIT');
}
function fingerprint(f: ReturnType<typeof fixture>) {
  const tables = rows(f.db, "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'quixi_extract_*' ORDER BY name");
  return Object.fromEntries(tables.map(({ name }) => [String(name), rows(f.db, `SELECT * FROM ${name}`)]));
}
function publication(f: ReturnType<typeof fixture>, supplied: PageLayout | null = layout) {
  const run = begin(f), p = page(f, run.runId), text = 'Mixed 日本語 Arabic rotated page text.';
  const map = span(0, text), staged = stage(f, p, text, 0, 0, [map]);
  const args: ExtractionOperations['publishExtractionPage']['args'] = { ...p, operationId: next(),
    lastSequence: 0, expectedUTF16Length: text.length,
    expectedTextSha256: extractionTextDigest(text), expectedMapSha256: extractionMapDigest([map]),
    itemCount: 1, classification: 'text', ...(supplied ? { layout: supplied } : {}) };
  return { run, p, text, map, staged, args };
}
function read(f: ReturnType<typeof fixture>, ref: ExtractionOperations['publishExtractionPage']['result']['pageRef']) {
  return f.repo.execute('readExtractedPageText', { pageRef: ref, startUTF16: 0, maxUTF16: 16384 });
}
function clean(f: ReturnType<typeof fixture>) { for (let n=0;n<100;n++) if (!f.repo.cleanup({ maxRows: 7 }).rows) return; throw new Error('Cleanup did not converge'); }

test('actual v1 checkpoint/page/receipt fixture upgrades and reopens without rewriting legacy content or operations', () => {
  const f = fixture();
  try {
    restoreV1(f);
    const before = fingerprint(f), claims = rows(f.db, 'SELECT * FROM proof_operation_claims ORDER BY id');
    f.repo.initialize();
    assert.equal(f.db.selectValue('SELECT version FROM quixi_extract_schema'), 2);
    const after = fingerprint(f);
    for (const [table, records] of Object.entries(before)) if (table !== 'quixi_extract_schema') assert.deepEqual(after[table], records, table);
    assert.deepEqual(after.quixi_extract_page_layout, []);
    assert.deepEqual(rows(f.db, 'SELECT * FROM proof_operation_claims ORDER BY id'), claims);
    const ref = snapshot.published.receipt.pageRef;
    assert.equal(read(f, ref).text, snapshot.text); assert.equal(read(f, ref).layout, null);
    assert.deepEqual(f.repo.execute('publishExtractionPage', snapshot.published.args), snapshot.published.receipt);
    assert.deepEqual(f.repo.execute('stagePageText', snapshot.staged.args), snapshot.staged.receipt);
    const state = status(f); assert.equal(state.completedPage, 1); assert.equal(state.currentPage!.utf16, snapshot.pending.receipt.committedUTF16Offset);
    f.reopen();
    assert.equal(read(f, ref).layout, null);
    assert.deepEqual(f.repo.execute('publishExtractionPage', snapshot.published.args), snapshot.published.receipt);
  } finally { f.close(); }
});

test('schema upgrade interruption rolls back every DDL/ledger change and safely retries after reopen', () => {
  const f = fixture();
  try {
    restoreV1(f); const before = fingerprint(f);
    f.fail(true); assert.throws(() => f.repo.initialize(), /synthetic precommit failure/);
    assert.deepEqual(fingerprint(f), before);
    assert.equal(f.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name='quixi_extract_page_layout'"), 0);
    f.fail(false); f.reopen(); assert.equal(f.db.selectValue('SELECT version FROM quixi_extract_schema'), 2);
    assert.equal(read(f, snapshot.published.receipt.pageRef).text, snapshot.text);
  } finally { f.close(); }
});

test('unknown ledger and partial prior schema fail without resetting legacy pages or receipts', () => {
  for (const corruption of ["UPDATE quixi_extract_schema SET checksum='bad'", 'DROP INDEX quixi_extract_page_cursor']) {
    const f = fixture();
    try {
      restoreV1(f); f.db.exec(corruption); const before = fingerprint(f);
      assert.throws(() => f.repo.initialize(), code('MIGRATION_FAILED'));
      assert.deepEqual(fingerprint(f), before);
      assert.equal(f.db.selectValue("SELECT count(*) FROM sqlite_schema WHERE name='quixi_extract_page_layout'"), 0);
    } finally { f.close(); }
  }
});

test('frozen actual v1 repository accepts v1 but refuses schema2 reads/writes before mutation', () => {
  const f = fixture();
  try {
    restoreV1(f);
    const options = { lookupIdentity: () => ({ ...identity, available: true, mediaType: 'application/pdf' }), operations: { claim() { throw new Error('Legacy writer must never claim'); } }, supportedVersions: [{ extractorVersion: identity.extractorVersion, normalizerVersion: identity.normalizerVersion }] };
    const old = new OldRepository(f.db, options); old.initialize();
    assert.deepEqual(old.execute('publishExtractionPage', snapshot.published.args), snapshot.published.receipt); old.close();
    f.repo.initialize(); const before = fingerprint(f);
    const incompatible = new OldRepository(f.db, options);
    assert.throws(() => incompatible.initialize(), code('MIGRATION_FAILED'));
    assert.throws(() => incompatible.execute('publishExtractionPage', snapshot.published.args), code('MIGRATION_FAILED'));
    assert.deepEqual(fingerprint(f), before); incompatible.close();
  } finally { f.close(); }
});

test('layout publication is transactional, replay-fenced and durable with a digest-bound nullable read outcome', () => {
  const f = fixture();
  try {
    const p = publication(f), before = fingerprint(f);
    f.fail(true); assert.throws(() => f.repo.execute('publishExtractionPage', p.args), /synthetic precommit failure/); f.fail(false);
    assert.deepEqual(fingerprint(f), before);
    const result = f.repo.execute('publishExtractionPage', p.args);
    assert.deepEqual(read(f, result.pageRef).layout, layout);
    assert.deepEqual(f.repo.execute('publishExtractionPage', p.args), result);
    assert.throws(() => f.repo.execute('publishExtractionPage', { ...p.args, layout: { mode: 'geometric', reasons: [], columns: 1 } }), code('CONFLICT'));
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_page_layout'), 1);
    assert.equal(f.db.selectValue('SELECT published_bytes FROM quixi_extract_pages WHERE id=?', [p.p.pageAttemptId]), new TextEncoder().encode(p.text).length + jsonByteLength(layout) + 128);
    f.reopen(); assert.deepEqual(read(f, result.pageRef).layout, layout);
  } finally { f.close(); }
});

test('deleted, malformed and changed valid v2 layout metadata refuse instead of becoming unknown legacy layout', () => {
  for (const mutation of ["DELETE FROM quixi_extract_page_layout", "UPDATE quixi_extract_page_layout SET layout='{}'", `UPDATE quixi_extract_page_layout SET layout='{"mode":"geometric","reasons":[],"columns":1}'`]) {
    const f = fixture();
    try {
      const p = publication(f), result = f.repo.execute('publishExtractionPage', p.args);
      f.db.exec(mutation);
      assert.throws(() => read(f, result.pageRef), code('MIGRATION_FAILED'));
      assert.throws(() => f.repo.publishedSources.current(result.pageRef), code('MIGRATION_FAILED'));
      assert.deepEqual(f.repo.execute('publishExtractionPage', p.args), result, 'Committed receipt remains authoritative, without pretending its current derived bytes are healthy');
    } finally { f.close(); }
  }
});

test('layout bounds and semantic outcome constraints are validated without mutating omitted legacy args', () => {
  assertPageLayout(layout); assertPageLayout({ mode: 'geometric', reasons: [], columns: 2 });
  for (const invalid of [null, {}, { mode: 'geometric', reasons: ['non_ltr'], columns: 1 }, { mode: 'source_order', reasons: [], columns: 1 }, { mode: 'source_order', reasons: ['non_ltr','non_ltr'], columns: 1 }, { ...layout, columns: 2 }, { ...layout, extra: 1 }]) assert.throws(() => assertPageLayout(invalid));
  const oldArgs = JSON.stringify(snapshot.published.args);
  assertExtractionArgs('publishExtractionPage', snapshot.published.args);
  assert.equal(JSON.stringify(snapshot.published.args), oldArgs);
  assert.throws(() => assertExtractionArgs('publishExtractionPage', { ...snapshot.published.args, layout: undefined }));
});

test('cleanup releases layout metadata accounting while preserving historical receipts', () => {
  const f = fixture({ runBytes: 13000, archiveBytes: 18000 });
  try {
    const p = publication(f), result = f.repo.execute('publishExtractionPage', p.args);
    const before = f.repo.execute('getExtractionOperation', { operationId: p.args.operationId });
    f.repo.execute('clearDocumentExtraction', { operationId: next(), documentId: identity.documentId, expectedRunId: p.run.runId, expectedDocumentRevision: status(f).documentRevision });
    clean(f);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_page_layout'), 0);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_pages'), 0);
    assert.equal(f.db.selectValue('SELECT used_bytes FROM quixi_extract_meta'), f.db.selectValue('SELECT sum(used_bytes) FROM quixi_extract_runs'));
    assert.deepEqual(f.repo.execute('getExtractionOperation', { operationId: p.args.operationId }), before);
    assert.equal(f.repo.publishedSources.current(result.pageRef), false);
  } finally { f.close(); }
});

test('a changed normalizer cannot displace an interrupted old run checkpoint before explicit producer recovery', () => {
  const f = fixture();
  try {
    restoreV1(f); f.repo.initialize();
    assert.throws(() => begin(f, { normalizerVersion: 'identity-v2' }), code('OVERLOADED'));
    f.repo.execute('interruptDocumentExtraction', { operationId: next(), runId: snapshot.run.runId, writerEpoch: snapshot.run.writerEpoch, reason: 'confirmed_producer_loss' });
    const replacement = begin(f, { normalizerVersion: 'identity-v2' });
    assert.notEqual(replacement.runId, snapshot.run.runId);
    assert.equal(read(f, snapshot.published.receipt.pageRef).text, snapshot.text, 'Previous visible page remains until replacement publication');
    assert.deepEqual(f.repo.execute('publishExtractionPage', snapshot.published.args), snapshot.published.receipt);
  } finally { f.close(); }
});


test('logical budget counts layout metadata and rolls back a publication that no longer fits', () => {
  const baseline = fixture();
  let legacyBytes: number;
  try {
    const p = publication(baseline, null); baseline.repo.execute('publishExtractionPage', p.args);
    legacyBytes = Number(baseline.db.selectValue('SELECT used_bytes FROM quixi_extract_runs WHERE id=?', [p.run.runId]));
  } finally { baseline.close(); }
  // The payload budget retains a 25% control reserve at these small test limits.
  const runBytes = Math.ceil(legacyBytes! * 4 / 3);
  const f = fixture({ runBytes, archiveBytes: 100000 });
  try {
    const p = publication(f), before = fingerprint(f), claims = rows(f.db, 'SELECT * FROM proof_operation_claims ORDER BY id');
    assert.throws(() => f.repo.execute('publishExtractionPage', p.args), code('CAPACITY'));
    assert.deepEqual(fingerprint(f), before, 'Budget denial retains staged checkpoint/text/maps without a visible page');
    assert.deepEqual(rows(f.db, 'SELECT * FROM proof_operation_claims ORDER BY id'), claims);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_page_layout'), 0);
    assert.deepEqual(f.repo.execute('getExtractionOperation', { operationId: p.args.operationId }), { status: 'not_found' });
    f.repo.execute('clearDocumentExtraction', { operationId: next(), documentId: identity.documentId, expectedRunId: p.run.runId, expectedDocumentRevision: status(f).documentRevision });
    clean(f); assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_pages'), 0);
  } finally { f.close(); }
});
