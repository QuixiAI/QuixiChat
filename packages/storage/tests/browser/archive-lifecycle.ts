import { acquireGenerationLease } from '@quixi/storage/client';
import type { GenerationLease } from '@quixi/storage/client';
import type { StorageClient, MutationBatch, CanonicalMutation } from '@quixi/core/contracts';
import type { Generation, Message, ContentPart } from '@quixi/core/model';
const id = () => crypto.randomUUID();
const leases = new Map<string, GenerationLease>();
const page = { maxItems: 1000, maxBytes: 900_000, cursor: null };
const assert = (value: unknown, reason: string) => { if (!value) throw new Error(reason); };
const batch = (...mutations: CanonicalMutation[]): MutationBatch => ({ transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations });
async function rejects(work: Promise<unknown>, code: string) { try { await work; } catch (error) { assert((error as {code:string}).code === code, `Expected ${code}, got ${String(error)}`); return; } throw new Error(`Expected ${code}`); }
export interface ProducerFixture { generationId: string; producerId: string; outputId: string; partId: string; threadId: string; create: MutationBatch; append: MutationBatch }
export async function prepareProducer(client: StorageClient, archiveId: string, options: { registered?: boolean; create?: boolean } = {}): Promise<ProducerFixture> {
  const now = Date.now(), threadId = id(), contextId = id(), parentId = id(), generationId = id(), outputId = id(), producerId = id(), partId = id();
  await client.request(id(), 'commit', batch(
    { version: 1, operationId: id(), recordedAt: now, kind: 'CreateThread', payload: {
      thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: '', preferredRoute: null, importSourceId: null },
      context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: '', preferredRoute: null, recordedAt: now },
      state: { threadId, title: 'Producer recovery acceptance', tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
    } },
    { version: 1, operationId: id(), recordedAt: now, kind: 'CreateMessage', payload: {
      message: { id: parentId, threadId, parentId: null, role: 'user', createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
      parts: [{ id: id(), messageId: parentId, order: 0, kind: 'Text', data: { text: 'A durable synthetic prompt' } }],
    } },
  ));
  const generation: Generation = { id: generationId, threadId, parentMessageId: parentId, outputMessageId: outputId, contextSnapshotId: contextId, provider: 'synthetic', providerAccountId: 'acceptance', model: 'fixture', parameters: {}, status: 'streaming', createdAt: now, recordedAt: now, completedAt: null, tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null, reportedCost: null, lastSequence: 0, rawResponseId: null, compatibility: [] };
  const output: Message = { id: outputId, threadId, parentId, role: 'assistant', createdAt: now, recordedAt: now, generationId, editedFromMessageId: null, partCount: 0, sealed: false };
  const create = batch({ version: 1, operationId: id(), recordedAt: now, kind: 'CreateGeneration', payload: { generation, output, parts: [] } });
  const append = batch({ version: 1, operationId: id(), recordedAt: now, kind: 'AppendGenerationOutput', payload: { generationId, sequence: 1, newParts: [{ id: partId, messageId: outputId, order: 0, kind: 'Text', data: { text: 'Preserved prefix <script>not markup</script> needlequartz' } }], textAppend: null } });
  if (options.registered !== false) {
    await rejects(client.request(id(), 'registerGenerationProducer', { generationId, producerId }), 'CONFLICT');
    const lease = await acquireGenerationLease(archiveId, generationId); leases.set(generationId, lease);
    await rejects(acquireGenerationLease(archiveId, generationId), 'CONFLICT');
    const registered = await client.request(id(), 'registerGenerationProducer', { generationId, producerId });
    assert(registered.state === 'active', 'Producer registration was not durable');
    await client.request(id(), 'registerGenerationProducer', { generationId, producerId });
    await rejects(client.request(id(), 'registerGenerationProducer', { generationId, producerId: id() }), 'CONFLICT');
  }
  if (options.create !== false) { await client.request(id(), 'commit', create); await client.request(id(), 'commit', append); }
  return { generationId, producerId, outputId, partId, threadId, create, append };
}
export async function verifyProducer(client: StorageClient, fixture: ProducerFixture, expected: 'streaming'|'partial'|'absent') {
  const reconciliation = await client.request(id(), 'reconcileGenerationProducers', { maxProducers: 32 });
  const generation = await client.request(id(), 'readEntity', { collection: 'generations', id: fixture.generationId }) as Generation | null;
  if (expected === 'absent') {
    assert(generation === null, 'Uncreated generation became visible');
    await rejects(client.request(id(), 'commit', fixture.create), 'CONFLICT');
  } else {
    assert(generation?.status === expected, `Expected ${expected} after reconciliation, got ${generation?.status}`);
    const output = await client.request(id(), 'readEntity', { collection: 'messages', id: fixture.outputId }) as unknown as Message;
    assert(output.sealed === (expected === 'partial'), 'Recovery sealing does not match lifecycle');
    const parts = await client.request(id(), 'readMessageParts', { messageId: fixture.outputId, page });
    const part = parts.items[0] as unknown as ContentPart;
    assert(parts.items.length === 1 && part?.kind === 'Text' && part.data.text === 'Preserved prefix <script>not markup</script> needlequartz', 'Recovery lost or changed the committed prefix');
    // Already-committed retries must remain successful after the producer fence.
    await client.request(id(), 'commit', fixture.create); await client.request(id(), 'commit', fixture.append);
    if (expected === 'partial') {
      await rejects(client.request(id(), 'commit', batch({ version: 1, operationId: id(), recordedAt: Date.now(), kind: 'AppendGenerationOutput', payload: { generationId: fixture.generationId, sequence: 2, newParts: [], textAppend: { partId: fixture.partId, text: 'late' } } })), 'CONFLICT');
      const events = await client.request(id(), 'readEntities', { collection: 'events', threadId: fixture.threadId, page });
      assert(events.items.length === 1, 'Producer loss did not produce exactly one durable event');
    }
  }
  return { status: expected, reconciliation };
}
export async function verifySearch(client: StorageClient, fixture: ProducerFixture) {
  let status = await client.request(id(), 'searchStatus', null);
  for (let slice = 0; status.pendingSources && slice < 1000; slice++) status = await client.request(id(), 'advanceSearchIndex', { maxChunks: 8 });
  assert(status.state === 'ready', `FTS index did not settle: ${JSON.stringify(status)}`);
  const args = { query: 'needlequartz', mode: 'best' as const, filters: { threadIds: [fixture.threadId] }, page };
  const result = await client.request(id(), 'searchArchive', args);
  assert(result.items.length === 1 && result.modeUsed === 'best_lexical', 'Best did not return the exact text without embeddings');
  const hit = result.items[0]!;
  assert(hit.position.partId === fixture.partId && hit.messageId === fixture.outputId && hit.excerpt.text.includes('<script>'), 'Search lost source location or changed text into markup');
  assert(hit.excerpt.highlights.some(range => hit.excerpt.text.slice(range.start, range.end) === 'needlequartz'), 'Search highlight does not identify exact source text');
  await rejects(client.request(id(), 'searchArchive', { ...args, mode: 'semantic' }), 'UNSUPPORTED');
  await client.request(id(), 'rebuildSearch', { operationId: id() });
  assert((await client.request(id(), 'searchArchive', args)).items.length === 1, 'Rebuild hid the valid old index');
  do { status = await client.request(id(), 'advanceSearchIndex', { maxChunks: 8 }); } while (status.pendingSources);
  assert((await client.request(id(), 'searchArchive', args)).items.length === 1, 'Rebuilt index changed exact results');
  return { indexedChunks: status.indexedChunks, activeEpoch: status.activeEpoch, partId: hit.position.partId, semantic: status.semantic };
}
