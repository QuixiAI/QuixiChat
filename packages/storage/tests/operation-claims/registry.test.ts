import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import initialize from '../../sqlite/dist/sqlite3.mjs';
import { CanonicalRepository } from '../../src/worker/canonical/repository.ts';
import type { CanonicalSqlite, SqlValue } from '../../src/worker/canonical/repository.ts';
import { OperationClaimRegistry, operationClaimIdentity, installArchiveOperationClaimFences, readOperationClaim } from '../../src/worker/operation-claims.ts';
import type { OperationClaim } from '../../src/worker/operation-claims.ts';
import { OPERATION_CLAIMS_MIGRATION } from '../../migrations/operation-claims.ts';
import { CANONICAL_MIGRATIONS } from '../../migrations/index.ts';
import { ExtractionRepository } from '../../src/worker/extraction/index.ts';
import type { ExtractionOperationClaims } from '../../src/worker/extraction/index.ts';
import type { ExtractionIdentity, ExtractionOperations } from '../../../core/src/contracts/extraction.ts';
import { CleanSnapshotCopy } from '../../src/worker/archives/clean-copy.ts';
import { CanonicalArchiveValidator } from '../../src/worker/archives/validation.ts';
import { restrictRestoreConnection } from '../../src/worker/archives/schema-validation.ts';
import { snapshotSummary } from '../../src/worker/archives/snapshot.ts';
import { ARCHIVE_EXCLUDED } from '../../src/worker/archives/format.ts';
import type { ArchiveManifest } from '../../src/worker/archives/format.ts';
import type { FileSqlite } from '../../src/worker/archives/sqlite-file.ts';
import { installArchiveOperationFences } from '../../src/worker/archive-operation-fences.ts';
import type { MutationBatch } from '@quixi/core/contracts';

const wasm = await readFile(new URL('../../sqlite/dist/sqlite3.wasm', import.meta.url));
const artifact = JSON.parse(await readFile(new URL('../../sqlite/artifacts.json', import.meta.url), 'utf8'));
assert.equal(createHash('sha256').update(wasm).digest('hex'), artifact.artifacts['sqlite3.wasm'].sha256);
(globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }).sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
type Database = CanonicalSqlite & { pointer: number; close(): void };
const initOptions = {
  instantiateWasm: async (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => { const { instance, module } = await WebAssembly.instantiate(wasm, imports); success(instance, module); }, print: () => {}, printErr: () => {},
};
const sqlite = await initialize(initOptions) as { oo1: { DB: new (name: string, flags: string) => Database }; capi: { sqlite3_get_autocommit(pointer: number): number; sqlite3_js_db_export(pointer: number): Uint8Array } };
const id = () => randomUUID();
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const claim = (operationId = id(), domain = 'extraction', requestDigest = digest('request')): OperationClaim => ({ operationId, domain, requestDigest });
const rows = (db: CanonicalSqlite, sql: string, bind: SqlValue[] = []) => db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as Record<string, SqlValue>[];
const has = (db: CanonicalSqlite, name: string) => db.selectValue("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)", [name]) === 1;
const code = (value: string) => (error: unknown) => (error as { code?: string }).code === value;
const constraint = (error: unknown) => ((error as { resultCode?: number }).resultCode ?? 0) % 256 === 19;
function tx<T>(db: Database, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* FULL can roll back itself. */ } throw error; }
}
function fixture(installed = true, archive = true) {
  const filename = `/claims-${id()}.sqlite3`, db = new sqlite.oo1.DB(filename, 'c');
  const canonical = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  canonical.migrate(9);
  if (installed) db.exec(OPERATION_CLAIMS_MIGRATION.sql);
  if (archive) {
    db.exec("CREATE TABLE quixi_archive_operations(id TEXT PRIMARY KEY,identity TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result) AND length(CAST(result AS BLOB))<=65536)) STRICT");
    installArchiveOperationFences(db);
    if (installed) installArchiveOperationClaimFences(db);
  }
  const registry = new OperationClaimRegistry(db, sqlite);
  const compatible: ExtractionOperationClaims = registry; void compatible;
  return { filename, db, canonical, registry, close: () => db.close() };
}
function threadBatch(operationId: string = id()): MutationBatch {
  const threadId = id(), contextId = id();
  return { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: [{ version: 1, operationId, kind: 'CreateThread', recordedAt: 1, payload: {
    thread: { id: threadId, workspaceId: id(), createdAt: 1, recordedAt: 1, systemPrompt: null, preferredRoute: null, importSourceId: null },
    context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: 1 },
    state: { threadId, title: 'Canonical 日本語\u0000unchanged', tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
  } }] };
}
function canonicalSnapshot(db: Database) {
  return ['quixi_records', 'quixi_sync_ops', 'quixi_transactions'].map(table => rows(db, `SELECT * FROM ${table} ORDER BY rowid`));
}
function extraction(f: ReturnType<typeof fixture>, beforeCommit?: () => void) {
  const identity: ExtractionIdentity = { documentId: id(), attachmentId: id(), attachmentSha256: digest('synthetic-source'), attachmentByteLength: 123, extractorVersion: 'test-extractor-v1', normalizerVersion: 'identity-v1' };
  const make = () => {
    const repo = new ExtractionRepository(f.db, {
      lookupIdentity: documentId => documentId === identity.documentId ? { ...identity, available: true, mediaType: 'application/pdf' } : null,
      supportedVersions: [{ extractorVersion: identity.extractorVersion, normalizerVersion: 'identity-v1' }, { extractorVersion: identity.extractorVersion, normalizerVersion: 'identity-v2' }],
      operations: f.registry, ...(beforeCommit ? { beforeCommit } : {}),
    });
    repo.initialize(); return repo;
  };
  return { identity, make, repo: make() };
}

test('versioned full claim identity is deterministic and domain/payload sensitive', t => {
  const value = claim('00000000-0000-4000-8000-000000000001');
  const encoded = JSON.stringify({ domain: value.domain, operationId: value.operationId, requestDigest: value.requestDigest, version: 1 });
  assert.equal(operationClaimIdentity(value), digest(encoded));
  assert.equal(operationClaimIdentity({ requestDigest: value.requestDigest, domain: value.domain, operationId: value.operationId }), digest(encoded));
  assert.notEqual(operationClaimIdentity({ ...value, domain: 'another.domain' }), digest(encoded));
  assert.notEqual(operationClaimIdentity({ ...value, requestDigest: digest('different') }), digest(encoded));
  assert.throws(() => operationClaimIdentity({ ...value, domain: 'x'.repeat(65) }), code('INVALID_REQUEST'));
  assert.throws(() => operationClaimIdentity({ ...value, requestDigest: 'z'.repeat(64) }), code('INVALID_REQUEST'));
  t.diagnostic('claims-migration ' + JSON.stringify({ version: OPERATION_CLAIMS_MIGRATION.version, name: OPERATION_CLAIMS_MIGRATION.name, sqlSha256: digest(OPERATION_CLAIMS_MIGRATION.sql), registeredInRoot: CANONICAL_MIGRATIONS.some(m => Number(m.version) === 10) }));
});

test('missing registry/guards and absent active transaction fail without lazy schema creation', () => {
  const f = fixture(false, false);
  try {
    const before = rows(f.db, 'SELECT name,sql FROM sqlite_schema ORDER BY name');
    assert.throws(() => tx(f.db, () => f.registry.claim(claim())), code('MIGRATION_FAILED'));
    assert.deepEqual(rows(f.db, 'SELECT name,sql FROM sqlite_schema ORDER BY name'), before);
    f.db.exec(OPERATION_CLAIMS_MIGRATION.sql);
    assert.throws(() => f.registry.claim(claim()), code('INTERNAL'));
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 0);
    assert.throws(() => installArchiveOperationClaimFences(f.db), code('MIGRATION_FAILED'));
    f.db.exec('CREATE TABLE quixi_archive_operations(id TEXT PRIMARY KEY,identity TEXT NOT NULL,result TEXT NOT NULL) STRICT');
    assert.throws(() => tx(f.db, () => f.registry.claim(claim())), code('MIGRATION_FAILED'));
    installArchiveOperationClaimFences(f.db); installArchiveOperationClaimFences(f.db);
    tx(f.db, () => f.registry.claim(claim()));
    f.db.exec('DROP TRIGGER quixi_blob_operations_local_claim');
    assert.throws(() => tx(f.db, () => f.registry.claim(claim())), code('MIGRATION_FAILED'));
  } finally { f.close(); }
});

test('same claim without derived receipt requires recovery; domain/payload changes conflict', () => {
  const f = fixture();
  try {
    const value = claim(); tx(f.db, () => f.registry.claim(value));
    assert.throws(() => tx(f.db, () => f.registry.claim(value)), code('UNKNOWN_OUTCOME'));
    assert.throws(() => tx(f.db, () => f.registry.claim({ ...value, domain: 'other' })), code('CONFLICT'));
    assert.throws(() => tx(f.db, () => f.registry.claim({ ...value, requestDigest: digest('changed') })), code('CONFLICT'));
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 1);
  } finally { f.close(); }
});

test('read-only lookup verifies stored identity without a writer transaction or schema changes', () => {
  const f = fixture();
  try {
    const value = claim(); tx(f.db, () => f.registry.claim(value));
    const changes = f.db.selectValue('SELECT total_changes()');
    assert.deepEqual(f.registry.lookup(value.operationId), value);
    assert.deepEqual(readOperationClaim(f.db, value.operationId), value);
    assert.equal(readOperationClaim(f.db, id()), null);
    assert.equal(f.db.selectValue('SELECT total_changes()'), changes);
    const malformed = claim();
    f.db.exec({ sql: 'INSERT INTO quixi_local_operation_claims VALUES(?,?,?,?)', bind: [malformed.operationId, malformed.domain, malformed.requestDigest, '0'.repeat(64)] });
    assert.throws(() => readOperationClaim(f.db, malformed.operationId), code('MIGRATION_FAILED'));
    assert.throws(() => f.registry.lookup('not-a-uuid'), code('INVALID_REQUEST'));
  } finally { f.close(); }
  const missing = fixture(false, false);
  try { assert.throws(() => readOperationClaim(missing.db, id()), code('MIGRATION_FAILED')); }
  finally { missing.close(); }
});

const journals = ['canonical-sync', 'import-control', 'import-record', 'blob', 'import-work', 'archive'] as const;
function journalInsert(f: ReturnType<typeof fixture>, journal: typeof journals[number], operationId: string): void {
  const jobId = id();
  switch (journal) {
    case 'canonical-sync': f.db.exec({ sql: "INSERT INTO quixi_sync_ops(operation_id,kind,recorded_at,identity,payload,affects,result) VALUES(?,'SetTitle',1,?,'{}','[]','{}')", bind: [operationId, digest('native')] }); break;
    case 'import-control': case 'import-record':
      f.db.exec({ sql: "INSERT INTO quixi_import_jobs(id,thread_id,mode,recorded_at,state) VALUES(?,?,'create',1,'staging')", bind: [jobId, id()] });
      f.db.exec({ sql: journal === 'import-control' ? "INSERT INTO quixi_import_operations VALUES(?,?,?,'{}')" : 'INSERT INTO quixi_import_record_identities VALUES(?,?,?)', bind: [operationId, jobId, digest('native')] }); break;
    case 'blob': f.db.exec({ sql: "INSERT INTO quixi_blob_operations VALUES(?,?,'{}')", bind: [operationId, digest('native')] }); break;
    case 'import-work':
      f.db.exec({ sql: "INSERT INTO quixi_import_runs VALUES(?,'{}')", bind: [jobId] });
      f.db.exec({ sql: "INSERT INTO quixi_import_work_operations VALUES(?,?,?,'{}')", bind: [operationId, jobId, digest('native')] }); break;
    case 'archive': f.db.exec({ sql: "INSERT INTO quixi_archive_operations VALUES(?,?,'{}')", bind: [operationId, digest('native')] }); break;
  }
}
for (const journal of journals) test(`${journal} collisions are fenced in both insertion orders, including direct SQL claims`, () => {
  const f = fixture();
  try {
    const nativeFirst = claim(); tx(f.db, () => journalInsert(f, journal, nativeFirst.operationId));
    assert.throws(() => tx(f.db, () => f.registry.claim(nativeFirst)), code('CONFLICT'));
    assert.throws(() => tx(f.db, () => f.db.exec({ sql: 'INSERT INTO quixi_local_operation_claims VALUES(?,?,?,?)', bind: [nativeFirst.operationId, nativeFirst.domain, nativeFirst.requestDigest, operationClaimIdentity(nativeFirst)] })), constraint);
    const claimFirst = claim(); tx(f.db, () => f.registry.claim(claimFirst));
    assert.throws(() => tx(f.db, () => journalInsert(f, journal, claimFirst.operationId)), constraint);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 1);
    assert.equal(f.db.selectValue('PRAGMA integrity_check'), 'ok');
  } finally { f.close(); }
});

test('claim rows cannot UPDATE, DELETE, REPLACE, IGNORE or UPSERT over an existing identity', () => {
  const f = fixture();
  try {
    const value = claim(); tx(f.db, () => f.registry.claim(value));
    const before = rows(f.db, 'SELECT * FROM quixi_local_operation_claims');
    for (const sql of [
      "UPDATE quixi_local_operation_claims SET domain='changed'", 'DELETE FROM quixi_local_operation_claims',
      'INSERT OR REPLACE INTO quixi_local_operation_claims SELECT * FROM quixi_local_operation_claims',
      'INSERT OR IGNORE INTO quixi_local_operation_claims SELECT * FROM quixi_local_operation_claims',
      "INSERT INTO quixi_local_operation_claims SELECT * FROM quixi_local_operation_claims WHERE true ON CONFLICT(operation_id) DO UPDATE SET domain='changed'",
    ]) { assert.throws(() => f.db.exec(sql), constraint); assert.deepEqual(rows(f.db, 'SELECT * FROM quixi_local_operation_claims'), before); }
  } finally { f.close(); }
});

test('real extraction receipt/effect and stable claim roll back together and exact receipt replay returns before claim', () => {
  const f = fixture(); let abort = false;
  const e = extraction(f, () => { if (abort) throw new Error('precommit rollback fixture'); });
  try {
    f.canonical.commit(threadBatch()); const before = canonicalSnapshot(f.db);
    const args = { operationId: id(), identity: e.identity };
    abort = true;
    assert.throws(() => e.repo.execute('beginDocumentExtraction', args), /precommit rollback/);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 0);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_operations'), 0);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_runs'), 0);
    abort = false;
    const receipt = e.repo.execute('beginDocumentExtraction', args), changes = f.db.selectValue('SELECT total_changes()');
    assert.deepEqual(e.repo.execute('beginDocumentExtraction', args), receipt);
    assert.equal(f.db.selectValue('SELECT total_changes()'), changes);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 1);
    assert.deepEqual(canonicalSnapshot(f.db), before);
  } finally { e.repo.close(); f.close(); }
});

test('canonical commit rejects a claimed operation atomically and canonical-first claims conflict', () => {
  const f = fixture();
  try {
    const value = claim(); tx(f.db, () => f.registry.claim(value));
    const before = canonicalSnapshot(f.db);
    assert.throws(() => f.canonical.commit(threadBatch(value.operationId)), code('CONFLICT'));
    assert.deepEqual(canonicalSnapshot(f.db), before);
    const canonicalFirst = claim(); f.canonical.commit(threadBatch(canonicalFirst.operationId));
    assert.throws(() => tx(f.db, () => f.registry.claim(canonicalFirst)), code('CONFLICT'));
    assert.deepEqual(f.registry.lookup(value.operationId), value);
  } finally { f.close(); }
});

test('registered migration 9 to 10 keeps canonical data and creates empty fenced local metadata', () => {
  const f = fixture(false, false);
  try {
    f.canonical.commit(threadBatch()); const before = canonicalSnapshot(f.db);
    assert.equal(f.db.selectValue('SELECT max(version) FROM quixi_schema_migrations'), 9);
    assert.equal(f.canonical.migrate(10), 10);
    assert.deepEqual(canonicalSnapshot(f.db), before);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 0);
    assert.equal(f.db.selectValue('SELECT checksum FROM quixi_schema_migrations WHERE version=10'), digest(JSON.stringify(OPERATION_CLAIMS_MIGRATION.sql)));
    const value = claim(); tx(f.db, () => f.registry.claim(value));
    assert.equal(f.canonical.migrate(10), 10);
    assert.deepEqual(f.registry.lookup(value.operationId), value);
  } finally { f.close(); }
});

test('missing extraction receipts and full derived repair preserve claims; canonical writes never depend on derived tables', () => {
  const f = fixture(), e = extraction(f);
  try {
    const args = { operationId: id(), identity: e.identity }; e.repo.execute('beginDocumentExtraction', args);
    f.db.exec('DELETE FROM quixi_extract_operations');
    assert.throws(() => e.repo.execute('beginDocumentExtraction', args), code('UNKNOWN_OUTCOME'));
    assert.throws(() => e.repo.execute('beginDocumentExtraction', { ...args, identity: { ...e.identity, normalizerVersion: 'identity-v2' } }), code('CONFLICT'));
    const before = rows(f.db, 'SELECT * FROM quixi_local_operation_claims');
    e.repo.close();
    for (const row of rows(f.db, "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'quixi_extract_*'")) f.db.exec(`DROP TABLE ${row.name}`);
    f.db.exec('CREATE TABLE quixi_search_repair_fixture(value TEXT); DROP TABLE quixi_search_repair_fixture');
    f.canonical.commit(threadBatch());
    assert.deepEqual(rows(f.db, 'SELECT * FROM quixi_local_operation_claims'), before);
    assert.equal(rows(f.db, "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name NOT GLOB 'quixi_extract_*' AND (sql LIKE '%quixi_extract_%' OR sql LIKE '%quixi_search_%')").length, 0);
    const rebuilt = e.make();
    try { assert.throws(() => rebuilt.execute('beginDocumentExtraction', args), code('UNKNOWN_OUTCOME')); rebuilt.execute('beginDocumentExtraction', { ...args, operationId: id() }); }
    finally { rebuilt.close(); }
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 2);
  } finally { e.repo.close(); f.close(); }
});

test('actual SQLite FULL rolls back the new stable claim together with extraction text/receipt', () => {
  const f = fixture(), e = extraction(f);
  try {
    const run = e.repo.execute('beginDocumentExtraction', { operationId: id(), identity: e.identity });
    const page = e.repo.execute('beginExtractionPage', { operationId: id(), runId: run.runId, writerEpoch: 1, page: 1, documentPageCount: 1 });
    const before = canonicalSnapshot(f.db);
    f.db.exec(`PRAGMA max_page_count=${Number(f.db.selectValue('PRAGMA page_count'))}`);
    let failed: ExtractionOperations['stagePageText']['args'] | undefined;
    for (let sequence = 0; sequence < 32; sequence++) {
      const text = 's'.repeat(4096), offset = sequence * 4096;
      const args: ExtractionOperations['stagePageText']['args'] = { operationId: id(), runId: run.runId, writerEpoch: 1, pageAttemptId: page.pageAttemptId, sequence, expectedUTF16Offset: offset, text, spans: [{ start: offset, end: offset + text.length, source: { itemIndex: sequence, itemStart: 0, itemEnd: text.length, transform: [1, 0, 0, 1, 40, 750], width: 200, height: 12, direction: 'ltr' } }] };
      try { e.repo.execute('stagePageText', args); }
      catch (error) { assert.equal((error as { code?: string }).code, 'CAPACITY'); failed = args; break; }
    }
    assert.ok(failed, 'Actual SQLite page limit did not produce FULL');
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims WHERE operation_id=?', [failed.operationId]), 0);
    assert.equal(e.repo.operationStatus(failed.operationId).status, 'not_found');
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_extract_text_batches'), failed.sequence);
    assert.deepEqual(canonicalSnapshot(f.db), before);
    f.db.exec('PRAGMA max_page_count=2147483646');
    e.repo.execute('stagePageText', failed);
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims WHERE operation_id=?', [failed.operationId]), 1);
  } finally { e.repo.close(); f.close(); }
});

test('explicit extraction clear preserves prior claims and commits its own claim with the clear receipt', () => {
  const f = fixture(), e = extraction(f);
  try {
    const beginArgs = { operationId: id(), identity: e.identity };
    const run = e.repo.execute('beginDocumentExtraction', beginArgs);
    const original = f.registry.lookup(beginArgs.operationId);
    const args = { operationId: id(), documentId: e.identity.documentId, expectedRunId: run.runId, expectedDocumentRevision: run.documentRevision };
    const result = e.repo.execute('clearDocumentExtraction', args);
    assert.equal(result.cleared, true);
    assert.deepEqual(f.registry.lookup(beginArgs.operationId), original);
    assert.ok(f.registry.lookup(args.operationId));
    assert.equal(f.db.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 2);
    assert.deepEqual(e.repo.execute('clearDocumentExtraction', args), result);
    assert.deepEqual(e.repo.execute('beginDocumentExtraction', beginArgs), run);
    assert.equal(f.db.selectValue('SELECT state FROM quixi_extract_runs WHERE id=?', [run.runId]), 'cleared');
  } finally { e.repo.close(); f.close(); }
});

test('SQLite close/reopen keeps stable claims and refuses same-ID redo', () => {
  const f = fixture(), value = claim(); tx(f.db, () => f.registry.claim(value)); f.close();
  const db = new sqlite.oo1.DB(f.filename, 'w');
  try { const registry = new OperationClaimRegistry(db, sqlite); assert.throws(() => tx(db, () => registry.claim(value)), code('UNKNOWN_OUTCOME')); assert.equal(db.selectValue('PRAGMA integrity_check'), 'ok'); }
  finally { db.close(); }
});

test('clean-copy whitelist excludes claim rows while staged fresh schema keeps an empty stable table', () => {
  const f = fixture(), output = new sqlite.oo1.DB(`/claims-copy-${id()}.sqlite3`, 'c');
  try {
    f.canonical.commit(threadBatch()); tx(f.db, () => f.registry.claim(claim()));
    const copy = new CleanSnapshotCopy(f.db, output);
    if (!has(output, 'quixi_local_operation_claims')) output.exec(OPERATION_CLAIMS_MIGRATION.sql);
    let steps = 0; while (!copy.done) { assert.ok(++steps < 100); copy.step(16); }
    assert.equal(output.selectValue('SELECT count(*) FROM quixi_local_operation_claims'), 0);
    assert.deepEqual(canonicalSnapshot(output), canonicalSnapshot(f.db));
    assert.equal(output.selectValue('PRAGMA integrity_check'), 'ok');
  } finally { output.close(); f.close(); }
});

for (const withClaim of [false, true]) test(`actual portable canonical validator ${withClaim ? 'rejects nonempty' : 'accepts empty'} schema-10 claims without modifying candidate`, () => {
  const candidate = new sqlite.oo1.DB(`/claims-portable-${id()}.sqlite3`, 'c');
  const scratch = new sqlite.oo1.DB(`/claims-scratch-${id()}.sqlite3`, 'c');
  try {
    const canonical = new CanonicalRepository(candidate, { assertBlobAvailable: () => {} });
    canonical.migrate(10); canonical.commit(threadBatch());
    const schema = rows(candidate, 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name');
    if (withClaim) tx(candidate, () => new OperationClaimRegistry(candidate, sqlite).claim(claim()));
    assert.deepEqual(rows(candidate, 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name'), schema);
    scratch.exec('CREATE TABLE quixi_archive_received_entries(job_id TEXT,path TEXT,byte_length INTEGER,sha256 TEXT)');
    const manifest: ArchiveManifest = {
      format: 'quixi-archive', version: 1, kind: 'portable',
      source: { ...snapshotSummary(candidate), migrations: rows(candidate, 'SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version').map(row => ({ version: Number(row.version), name: String(row.name), checksum: String(row.checksum) })) },
      inventory: { path: 'checksums.jsonl', byteLength: 0, sha256: '0'.repeat(64), entries: 2 },
      excluded: ARCHIVE_EXCLUDED,
    };
    const fileDigest = () => createHash('sha256').update(sqlite.capi.sqlite3_js_db_export(candidate.pointer)).digest('hex');
    const before = fileDigest();
    restrictRestoreConnection(sqlite as unknown as FileSqlite, candidate);
    const validator = new CanonicalArchiveValidator(candidate, scratch, id(), manifest);
    const validate = () => {
      for (let step = 0; step < 1000; step++) if (validator.step(1).phase === 'ready') return;
      throw new Error('Validation exceeded bounded fixture steps');
    };
    if (withClaim) assert.throws(validate, /Portable archives cannot contain local operation claims/);
    else assert.doesNotThrow(validate);
    assert.equal(fileDigest(), before);
  } finally { candidate.close(); scratch.close(); }
});
