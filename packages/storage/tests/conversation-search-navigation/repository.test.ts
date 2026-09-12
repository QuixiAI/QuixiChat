import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSearchArgs, assertStorageRequest } from '@quixi/core/contracts';
import type { SearchHit, SearchOperations } from '@quixi/core/contracts';
import { resolveConversationHitSource } from '../../src/worker/search/navigation.ts';
import { VISIBLE_HEAD } from '../../src/worker/search/schema.ts';
import type { CanonicalSqlite } from '../../src/worker/canonical/index.ts';
import { setup, drain, query, commit, next } from './fixture.ts';
const code = (code: string) => (error: unknown) => (error as { code: string }).code === code;
const args = (hit: SearchHit): SearchOperations['resolveConversationSearchHit']['args'] => ({ chunkId: hit.chunkId, threadId: hit.threadId!, messageId: hit.messageId!, partId: hit.position.partId });

test('exact filename and description navigation preserve authoritative Unicode/NUL positions without writes', async () => {
  const s = setup('Voyager 日本語\u0000 nebula.png', 'Captionword 原文\u0000 description.');
  try {
    await drain(s.search);
    const changes = s.f.db.selectValue('SELECT total_changes()');
    for (const term of ['Voyager', 'Captionword']) {
      const hit = query(s, term).items[0]!;
      const resolved = s.search.resolveConversationHit(args(hit));
      assert.deepEqual(resolved, { threadId: s.threadId, messageId: s.messageId, partId: s.partId, position: hit.position });
      assertSearchArgs('resolveConversationSearchHit', args(hit));
      assertStorageRequest({ version: 1, requestId: next(), operation: 'resolveConversationSearchHit', args: args(hit) });
    }
    assert.equal(s.f.db.selectValue('SELECT total_changes()'), changes);
    const hit = query(s, 'Voyager').items[0]!, sql: string[] = [];
    const db: CanonicalSqlite = { exec(options) { sql.push(typeof options === 'string' ? options : options.sql); return s.f.db.exec(options); }, selectValue(statement, bind) { sql.push(statement); return s.f.db.selectValue(statement, bind); } };
    assert.deepEqual(resolveConversationHitSource(db, args(hit), VISIBLE_HEAD).position, hit.position);
    assert.ok(sql.some(statement => statement.includes('INDEXED BY quixi_search_chunk_lookup')));
    assert.ok(!sql.some(statement => /(?:FROM|JOIN) quixi_extract_/.test(statement)));
    assert.ok(!sql.some(statement => /SELECT .*\bc\.text\b/.test(statement)));
  } finally { await s.close(); }
});

test('equal-length filename rename rejects the old chunk before and after reindex', async () => {
  const s = setup('Oldfilename.png', null);
  try {
    await drain(s.search); const hit = query(s, 'Oldfilename').items[0]!;
    assert.equal('Oldfilename.png'.length, 'Newfilename.png'.length);
    s.f.db.exec({ sql: "UPDATE quixi_records SET payload=json_set(payload,'$.filename','Newfilename.png') WHERE collection='attachments' AND id=?", bind: [s.attachmentId] });
    assert.throws(() => s.search.resolveConversationHit(args(hit)), code('CONFLICT'));
    await drain(s.search);
    assert.throws(() => s.search.resolveConversationHit(args(hit)), code('CONFLICT'));
    const current = query(s, 'Newfilename').items[0]!;
    assert.deepEqual(s.search.resolveConversationHit(args(current)).position, current.position);
  } finally { await s.close(); }
});

test('canonical source digest independently rejects rename when test-only dirty trigger suppression leaves a stale head', async () => {
  const s = setup('Oldfilename.png', null);
  try {
    await drain(s.search); const hit = query(s, 'Oldfilename').items[0]!;
    // Deliberate test corruption: prove current-source verification independently
    // of the normal canonical revision trigger. No production bypass exists.
    s.f.db.exec('DROP TRIGGER quixi_search_dirty_update');
    s.f.db.exec({ sql: "UPDATE quixi_records SET payload=json_set(payload,'$.filename','Newfilename.png') WHERE collection='attachments' AND id=?", bind: [s.attachmentId] });
    assert.equal(query(s, 'Oldfilename').items.length, 1, 'The deliberately unfenced head is still present');
    assert.throws(() => s.search.resolveConversationHit(args(hit)), code('CONFLICT'));
  } finally { await s.close(); }
});

test('ownership mismatch, malformed IDs, unsupported null-part and corrupted positions refuse', async () => {
  const s = setup('Voyager.png', null);
  try {
    await drain(s.search); const hit = query(s, 'Voyager').items[0]!, request = args(hit);
    for (const wrong of [{ threadId: next() }, { messageId: next() }, { partId: next() }, { partId: null }, { chunkId: 'f'.repeat(64) }]) assert.throws(() => s.search.resolveConversationHit({ ...request, ...wrong }), code('CONFLICT'));
    for (const wrong of [{ chunkId: 'invalid' }, { partId: undefined }, { threadId: 'invalid' }, { extra: 'invalid' }]) {
      assert.throws(() => assertSearchArgs('resolveConversationSearchHit', { ...request, ...wrong }));
      assert.throws(() => s.search.resolveConversationHit({ ...request, ...wrong } as typeof request), code('INVALID_REQUEST'));
    }
    s.f.db.exec({ sql: "UPDATE quixi_search_chunks SET position=json_set(position,'$.end',?) WHERE chunk_id=?", bind: [hit.position.end + 1, hit.chunkId] });
    assert.throws(() => s.search.resolveConversationHit(request), code('MIGRATION_FAILED'));
  } finally { await s.close(); }
});

test('thread tombstone refuses navigation even with deliberately unfenced search heads', async () => {
  const s = setup('Voyager.png', null);
  try {
    await drain(s.search); const hit = query(s, 'Voyager').items[0]!;
    s.f.db.exec('DROP TRIGGER quixi_search_dirty_insert');
    s.f.db.exec('DROP TRIGGER quixi_search_dirty_update');
    const state = s.f.canonical.get('threadStates', s.threadId)!;
    commit(s.f, 'TombstoneThread', { tombstone: { id: next(), threadId: s.threadId, rootMessageId: null, createdAt: 2, reason: null }, state: { ...state, revision: state.revision + 1 } });
    assert.throws(() => s.search.resolveConversationHit(args(hit)), code('CONFLICT'));
  } finally { await s.close(); }
});

test('rebuild preserves exact unchanged chunk identity; explicit clear refuses until republished; no extraction schema dependency', async () => {
  const s = setup('Voyager.png', null);
  try {
    await drain(s.search); const hit = query(s, 'Voyager').items[0]!;
    s.search.rebuild({ operationId: next() }); await drain(s.search);
    assert.deepEqual(s.search.resolveConversationHit(args(hit)).position, hit.position);
    await s.search.repairDerived({ operationId: next() });
    assert.throws(() => s.search.resolveConversationHit(args(hit)), code('CONFLICT'));
    await drain(s.search);
    assert.deepEqual(s.search.resolveConversationHit(args(hit)).position, hit.position);
    s.f.db.exec('DROP TABLE quixi_extract_pages');
    assert.deepEqual(s.search.resolveConversationHit(args(hit)).position, hit.position);
  } finally { await s.close(); }
});

test('code-classified text and structured data retain exact source addressing', async () => {
  const s = setup(null, null);
  try {
    const messageId = next(), partId = next(), toolPartId = next();
    commit(s.f, 'CreateMessage', { message: { id: messageId, threadId: s.threadId, parentId: s.messageId, role: 'user', createdAt: 2, recordedAt: 2, generationId: null, editedFromMessageId: null, partCount: 2, sealed: true }, parts: [
      { id: partId, messageId, order: 0, kind: 'Text', data: { text: '```js\nconst Uniqueprogram = 42;\n```' } },
      { id: toolPartId, messageId, order: 1, kind: 'StructuredData', data: { value: { uniquedata: 'sourcevalue' } } },
    ] });
    await drain(s.search);
    const codeHit = query(s, 'Uniqueprogram').items[0]!; assert.equal(codeHit.sourceType, 'code');
    assert.deepEqual(s.search.resolveConversationHit(args(codeHit)).position, codeHit.position);
    const structured = query(s, 'uniquedata').items[0]!;
    assert.deepEqual(s.search.resolveConversationHit(args(structured)).position.sectionPath, ['canonical-json', 'data', 'value']);
  } finally { await s.close(); }
});
