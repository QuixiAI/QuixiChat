import type { StorageClient, MutationBatch } from '@quixi/core/contracts';
import type { ArchiveStorageClient } from '../../src/client/archive.ts';
const id = () => crypto.randomUUID();
const page = { maxItems: 16, maxBytes: 100_000, cursor: null };
const needle = 'incrementalverificationtailquartz';
const assert = (value: unknown, message: string): void => { if (!value) throw new Error(message); };

export async function verifyIncrementalSearch(client: ArchiveStorageClient) {
  const bytes = new TextEncoder().encode('bounded verification padding '.repeat(75_000) + `\n${needle}`);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const transfer = await client.request(id(), 'beginBlobTransfer', { operationId: id(), purpose: 'canonical_text', expectedBytes: bytes.length, expectedSha256: sha256 });
  let sequence = 0;
  for (let offset = 0; offset < bytes.length; offset += transfer.maxChunkBytes) {
    const chunk = bytes.slice(offset, offset + transfer.maxChunkBytes);
    await client.sendChunk({ transferId: transfer.transferId, sequence: sequence++, offset, bytes: chunk, final: offset + chunk.length === bytes.length });
  }
  await client.request(id(), 'finishBlobTransfer', { operationId: id(), transferId: transfer.transferId, expectedBytes: bytes.length, expectedSha256: sha256 });
  const threadId = id(), contextId = id(), messageId = id(), partId = id(), now = Date.now();
  const batch: MutationBatch = { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [transfer.transferId], mutations: [
    { version: 1, operationId: id(), recordedAt: now, kind: 'CreateThread', payload: {
      thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
      context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
      state: { threadId, title: 'Incremental verification', tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
    } },
    { version: 1, operationId: id(), recordedAt: now, kind: 'CreateMessage', payload: {
      message: { id: messageId, threadId, parentId: null, role: 'user', createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
      parts: [{ id: partId, messageId, order: 0, kind: 'Text', data: { textBlob: { sha256, byteLength: bytes.length, encoding: 'utf-8' } } }],
    } },
  ] };
  const observations: number[] = [];
  let observationOverflow = false;
  const unsubscribe = client.onSearchChange(status => {
    const active = status.activeSource;
    if (active?.sourceId.endsWith(partId) && active.phase === 'verifying') {
      if (observations.length >= 512) { observationOverflow = true; return; }
      observations.push(active.readBytes);
    }
  });
  try {
    await client.request(id(), 'commit', batch);
    const before = await client.request(id(), 'diagnostics', null);
    const original = await client.request(id(), 'readEntity', { collection: 'messages', id: messageId });
    let status = await client.request(id(), 'searchStatus', null), turns = 0, foregroundDuringVerification = 0, maxForegroundMs = 0;
    while (status.pendingSources && turns++ < 2048) {
      const advance = client.request(id(), 'advanceSearchIndex', { maxChunks: 128 });
      const started = performance.now();
      const foreground = client.request(id(), 'readEntity', { collection: 'messages', id: messageId });
      const [next, read] = await Promise.all([advance, foreground]);
      maxForegroundMs = Math.max(maxForegroundMs, performance.now() - started);
      assert(JSON.stringify(read) === JSON.stringify(original), 'Foreground canonical read changed during verification');
      status = next;
      if (status.activeSource?.sourceId.endsWith(partId) && status.activeSource.phase === 'verifying') {
        foregroundDuringVerification++;
        const hidden = await client.request(id(), 'searchArchive', { query: needle, mode: 'exact', filters: { threadIds: [threadId] }, page });
        assert(hidden.items.length === 0, 'Unverified source became searchable');
      }
    }
    assert(status.state === 'ready' && !status.failedSources, 'Large verified text did not finish indexing');
    assert(foregroundDuringVerification >= 2, 'Foreground reads did not return between incomplete verification turns');
    assert(!observationOverflow && observations.length >= 3, 'Incremental verification progress was missing or exceeded its capture bound');
    let maximumProgressDelta = 0;
    for (let i = 1; i < observations.length; i++) {
      const delta = observations[i]! - observations[i - 1]!;
      assert((delta >= 0 || observations[i] === 0) && delta <= 131072, 'Owner verification progress exceeded one admitted slice or reset without a new verifier');
      maximumProgressDelta = Math.max(maximumProgressDelta, delta);
    }
    await verifyIncrementalSearchResult(client, { threadId, messageId, partId });
    const after = await client.request(id(), 'diagnostics', null);
    assert(before.canonicalRecords === after.canonicalRecords && before.syncOperations === after.syncOperations, 'Derived indexing changed canonical records or sync operations');
    return { threadId, messageId, partId, sha256, byteLength: bytes.length, turns, foregroundDuringVerification, maxForegroundMs, maximumProgressDelta, observations, canonicalRecords: after.canonicalRecords, syncOperations: after.syncOperations };
  } finally { unsubscribe(); }
}

export async function verifyIncrementalSearchResult(client: StorageClient, fixture: { threadId: string; messageId: string; partId: string }) {
  const result = await client.request(id(), 'searchArchive', { query: needle, mode: 'exact', filters: { threadIds: [fixture.threadId] }, page });
  assert(result.items.length === 1 && result.items[0]!.messageId === fixture.messageId && result.items[0]!.position.partId === fixture.partId, 'Verified tail search lost its canonical source');
  return { hits: result.items.length, messageId: result.items[0]!.messageId, partId: result.items[0]!.position.partId };
}
