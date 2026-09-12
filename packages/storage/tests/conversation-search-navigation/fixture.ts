/** Actual pinned SQLite/FTS; metadata-only image fixtures do not prove pixel decoding. */
import assert from 'node:assert/strict';
import { SearchRepository } from '../../src/worker/search/index.ts';
import type { SearchBlobAccess } from '../../src/worker/search/index.ts';
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


export { setup, drain, query, commit, next };
