/** Actual pinned SQLite/FTS; metadata-only image fixtures do not prove pixel decoding. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SearchRepository } from '../../src/worker/search/index.ts';
import type { SearchBlobAccess } from '../../src/worker/search/index.ts';
import { loadSource } from '../../src/worker/search/sources.ts';
import { StructuralChunker } from '@quixi/search';
import type { CanonicalMutation, SearchFilters } from '@quixi/core/contracts';
import type { ContentPart } from '@quixi/core/model';
import { fixture, next, identity, sourceSha } from '../extraction-search/fixture.ts';
const noBlobs: SearchBlobAccess = {
  async beginVerifiedRead() { throw new Error("Unexpected original verification"); },
  async advanceVerifiedRead() { throw new Error("Unexpected original verification"); },
  async openRead() { throw new Error('Image metadata search must never read pixels'); }, sliceRead() { throw new Error('Unexpected range'); }, readChunk() { throw new Error('Unexpected chunk'); }, acknowledge() { throw new Error('Unexpected ACK'); }, async discard() { throw new Error('Unexpected release'); },
};
function commit(f: ReturnType<typeof fixture>, kind: CanonicalMutation['kind'], payload: unknown) {
  return f.canonical.commit({ transactionId: next(), mutations: [{ version: 1, operationId: next(), kind, recordedAt: 1, payload } as CanonicalMutation], expectedThreadRevisions: [], stagedBlobIds: [] });
}
function setup(filename: string | null, description: string | null) {
  const f = fixture(), search = new SearchRepository(f.db, noBlobs, { publishedSources: f.repo.publishedSources }); search.initialize();
  const attachmentId = next(), threadId = next(), contextId = next(), messageId = next(), partId = next();
  commit(f, 'RegisterAttachment', { attachment: { id: attachmentId, availability: 'missing', filename, mimeType: 'image/png', sizeBytes: null, blobSha256: null, rawObjectId: null } });
  commit(f, 'CreateThread', { thread: { id: threadId, workspaceId: next(), createdAt: 1, recordedAt: 1, systemPrompt: null, preferredRoute: null, importSourceId: null }, context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: 1 }, state: { threadId, title: 'Field notes', tags: ['photographs'], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 } });
  const part: ContentPart = { id: partId, messageId, order: 0, kind: 'Image', data: { attachmentId, description } };
  commit(f, 'CreateMessage', { message: { id: messageId, threadId, parentId: null, role: 'user', createdAt: 1, recordedAt: 1, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true }, parts: [part] });
  return { f, search, attachmentId, threadId, messageId, partId, async close() { await search.close(); f.close(); } };
}
async function drain(search: SearchRepository) {
  for (let n = 0; n < 200; n++) { const status = await search.advance({ maxChunks: 4 }); assert.notEqual(status.state, 'failed', JSON.stringify(status)); if (!status.pendingSources) return; }
  throw new Error('Index did not converge');
}
const query = (s: ReturnType<typeof setup>, text: string, filters: SearchFilters = {}) => s.search.search({ query: text, mode: 'exact', filters, page: { cursor: null, maxItems: 32, maxBytes: 100000 } });

test('filename-only missing image is searchable with exact filename offsets and media/thread filters', async () => {
  const filename = 'Voyager 日本語\u0000 nebula.png';
  const s = setup(filename, null);
  try {
    await drain(s.search);
    const hit = query(s, 'Voyager', { mediaTypes: ['image/png'], threadIds: [s.threadId] }).items[0]; assert.ok(hit);
    assert.equal(hit.messageId, s.messageId); assert.equal(hit.position.partId, s.partId);
    assert.deepEqual(hit.position.sectionPath, ['attachment', s.attachmentId, 'filename']);
    assert.equal(hit.position.start, 0); assert.equal(hit.position.end, filename.length);
    assert.equal(query(s, 'Voyager', { mediaTypes: ['audio/mpeg'] }).items.length, 0);
    assert.equal(query(s, 'Voyager', { threadIds: [next()] }).items.length, 0);
    assert.equal(s.f.canonical.get('attachments', s.attachmentId)!.availability, 'missing');
  } finally { await s.close(); }
});

test('filename is a separate source and never prefixes or shifts an existing description', async () => {
  const description = 'Captionword 日本語\u0000 original description.';
  const s = setup('Filenameword.png', description);
  try {
    const source = loadSource(s.f.db, `p:${s.partId}`)!;
    const chunker = new StructuralChunker(source.chunk), expected = [...chunker.push(description), ...chunker.finish()];
    await drain(s.search);
    const caption = query(s, 'Captionword').items[0]!, filename = query(s, 'Filenameword').items[0]!;
    assert.ok(caption && filename); assert.notEqual(caption.chunkId, filename.chunkId);
    assert.equal(caption.chunkId, expected[0]!.id);
    assert.deepEqual(caption.position, expected[0]!.position);
    assert.deepEqual(caption.position.sectionPath, ['data', 'description']);
    assert.equal(caption.position.end, description.length);
  } finally { await s.close(); }
});

test('metadata-only filename changes fence old heads immediately and replay the unchanged caption identity', async () => {
  const s = setup('Oldfilename.png', 'Persistentcaption original description.');
  try {
    await drain(s.search);
    const before = query(s, 'Persistentcaption').items[0]!;
    // No public rename mutation exists yet. This test exercises the canonical
    // metadata SQL trigger, without bypassing attachment byte immutability.
    s.f.db.exec({ sql: "UPDATE quixi_records SET payload=json_set(payload,'$.filename',?) WHERE collection='attachments' AND id=?", bind: ['Newfilename.png', s.attachmentId] });
    assert.equal(query(s, 'Oldfilename').items.length, 0);
    await drain(s.search);
    assert.equal(query(s, 'Oldfilename').items.length, 0);
    assert.equal(query(s, 'Newfilename').items.length, 1);
    assert.equal(query(s, 'Persistentcaption').items[0]!.chunkId, before.chunkId);
    // Missing -> available uses the real canonical mutation. Fixture bytes are
    // retained provenance only; metadata indexing still must not decode them.
    commit(s.f, 'ResolveAttachment', { attachmentId: s.attachmentId, blobSha256: sourceSha, sizeBytes: identity.attachmentByteLength, provenance: [] });
    assert.equal(query(s, 'Newfilename').items.length, 0);
    await drain(s.search);
    assert.equal(query(s, 'Newfilename').items.length, 1);
  } finally { await s.close(); }
});

test('null filename creates no invented text and later metadata becomes searchable', async () => {
  const s = setup(null, 'Descriptiononly image.');
  try {
    await drain(s.search);
    assert.equal(loadSource(s.f.db, `f:${s.partId}`), null);
    assert.equal(query(s, 'Descriptiononly').items.length, 1);
    s.f.db.exec({ sql: "UPDATE quixi_records SET payload=json_set(payload,'$.filename','Addedfilename.png') WHERE collection='attachments' AND id=?", bind: [s.attachmentId] });
    await drain(s.search);
    assert.equal(query(s, 'Addedfilename').items.length, 1);
    const before = query(s, 'Addedfilename').items[0]!.chunkId;
    s.search.rebuild({ operationId: next() }); await drain(s.search);
    assert.equal(query(s, 'Addedfilename').items[0]!.chunkId, before);
  } finally { await s.close(); }
});

test('new Image parts and thread metadata changes discover filenames after the initial index is ready', async () => {
  const s = setup('Sharedfilename.png', null);
  try {
    await drain(s.search);
    const messageId = next(), partId = next();
    commit(s.f, 'CreateMessage', { message: { id: messageId, threadId: s.threadId, parentId: s.messageId, role: 'user', createdAt: 2, recordedAt: 2, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true }, parts: [{ id: partId, messageId, order: 0, kind: 'Image', data: { attachmentId: s.attachmentId, description: null } }] });
    await drain(s.search);
    assert.deepEqual(new Set(query(s, 'Sharedfilename').items.map(hit => hit.position.partId)), new Set([s.partId, partId]));
    commit(s.f, 'SetTitle', { threadId: s.threadId, value: 'Updated image conversation' });
    assert.equal(query(s, 'Sharedfilename').items.length, 0, 'Thread scope fences both filename heads');
    await drain(s.search);
    assert.ok(query(s, 'Sharedfilename').items.every(hit => hit.title === 'Updated image conversation'));
    assert.equal(query(s, 'Sharedfilename').items.length, 2);
  } finally { await s.close(); }
});

test('a filename changed while its source is held cannot publish stale chunks', async () => {
  const s = setup(('Oldheldfilename descriptionword ').repeat(2500), null);
  try {
    await s.search.advance({ maxChunks: 1 });
    assert.equal(query(s, 'Oldheldfilename').items.length, 0, 'Partial filename is not visible');
    s.f.db.exec({ sql: "UPDATE quixi_records SET payload=json_set(payload,'$.filename','Currentfilename.png') WHERE collection='attachments' AND id=?", bind: [s.attachmentId] });
    await drain(s.search);
    assert.equal(query(s, 'Oldheldfilename').items.length, 0);
    const hit = query(s, 'Currentfilename').items[0]!; assert.ok(hit);
    assert.equal(hit.position.end, 'Currentfilename.png'.length);
    assert.deepEqual(hit.position.sectionPath, ['attachment', s.attachmentId, 'filename']);
  } finally { await s.close(); }
});
