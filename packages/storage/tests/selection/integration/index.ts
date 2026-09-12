import { openActiveStorageClient, readArchiveSelection, archiveActivationStatus, acquireGenerationLease, readRetainedArchive, reconcilePreviousArchiveOperations } from '@quixi/storage/client';
import type { ArchiveStorageClient, GenerationLease } from '@quixi/storage/client';
import type { ArchiveActivationArgs, ArchiveJobStatus, CanonicalMutation, MutationBatch } from '@quixi/core/contracts';
import type { ContentPart, Generation, Message, RawObject } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const id = () => crypto.randomUUID();
const page = { maxItems: 32, maxBytes: 200_000, cursor: null };
const text = 'Actual managed archive: preserved NUL \0 and Unicode 🧪.\n'.repeat(80);
const length = 2 * 1_048_576 + 17;
let previousClient: ArchiveStorageClient | undefined;
let client: ArchiveStorageClient | undefined, lease: GenerationLease | undefined;
let producer: { generationId: string; producerId: string } | undefined;
let dropRequestId: string | undefined, suppressedReplies = 0;
const NativeWorker = Worker;
// Drop a real already-executed worker reply; do not replace the worker or its storage operations.
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener('message', event => {
      if (event.data.type === 'reply' && event.data.ok && event.data.id === dropRequestId) {
        dropRequestId = undefined; suppressedReplies++; event.stopImmediatePropagation();
      }
    });
  }
};
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const batch = (...mutations: CanonicalMutation[]): MutationBatch => ({ transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations });
interface Fixture { threadId: string; contextId: string; messageId: string; rawId: string; digest: string; workspaceId: string }
async function thread(title: string, workspaceId: string): Promise<{ threadId: string; contextId: string; operationId: string }> {
  const now = Date.now(), threadId = id(), contextId = id(), operationId = id();
  await client!.request(id(), 'commit', batch({ version: 1, operationId, recordedAt: now, kind: 'CreateThread', payload: {
    thread: { id: threadId, workspaceId, createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
    context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
    state: { threadId, title, tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
  } }));
  return { threadId, contextId, operationId };
}
async function seed(): Promise<Fixture> {
  const workspaceId = (await client!.request(id(), 'archiveWorkspace', null)).workspaceId;
  const ids = await thread('Managed history before export', workspaceId), messageId = id(), rawId = id(), hash = sha256.create();
  const upload = await client!.request(id(), 'beginBlobTransfer', { operationId: id(), purpose: 'raw_source', expectedBytes: length, expectedSha256: null });
  for (let offset = 0, sequence = 0; offset < length; offset += 65_536, sequence++) {
    const bytes = new Uint8Array(Math.min(65_536, length - offset));
    for (let n = 0; n < bytes.length; n++) bytes[n] = (offset + n) % 251;
    hash.update(bytes); await client!.sendChunk({ transferId: upload.transferId, sequence, offset, bytes, final: offset + bytes.length === length });
  }
  const digest = bytesToHex(hash.digest());
  await client!.request(id(), 'finishBlobTransfer', { operationId: id(), transferId: upload.transferId, expectedBytes: length, expectedSha256: digest });
  const now = Date.now();
  const commit = batch(
    { version: 1, operationId: id(), recordedAt: now, kind: 'RegisterRawObject', payload: { rawObject: { id: rawId, availability: 'available', sha256: digest, byteLength: length, mediaType: 'application/octet-stream', storageRef: `sha256:${digest}` } } },
    { version: 1, operationId: id(), recordedAt: now, kind: 'CreateMessage', payload: {
      message: { id: messageId, threadId: ids.threadId, parentId: null, role: 'user', createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
      parts: [{ id: id(), messageId, order: 0, kind: 'Text', data: { text } }],
    } },
  ); commit.stagedBlobIds = [upload.transferId]; await client!.request(id(), 'commit', commit);
  return { ...ids, messageId, rawId, digest, workspaceId };
}
async function advance(initial: ArchiveJobStatus): Promise<{ job: ArchiveJobStatus; steps: number }> {
  let job = initial, steps = 0;
  while (job.state === 'working') {
    assert(++steps <= 5000, 'Bounded fixture archive exceeded its step budget');
    job = await client!.request(id(), 'advanceArchiveJob', { operationId: id(), jobId: job.jobId, maxRecords: 16, maxBytes: 262_144 });
  }
  assert(job.state === 'ready', `Archive job failed: ${JSON.stringify(job)}`); return { job, steps };
}
async function copy(): Promise<{ job: ArchiveJobStatus; peakChunkBytes: number; byteLength: number; steps: number }> {
  const exported = await advance(await client!.request(id(), 'beginArchiveExport', { operationId: id(), format: 'portable' }));
  const transfer = await client!.request(id(), 'openArchiveExport', { jobId: exported.job.jobId });
  const restore = await client!.request(id(), 'beginArchiveRestore', { operationId: id(), expectedBytes: transfer.byteLength, expectedSha256: transfer.sha256 });
  let peakChunkBytes = 0;
  for (;;) {
    const chunk = await client!.readChunk(transfer.transferId); peakChunkBytes = Math.max(peakChunkBytes, chunk.bytes.length);
    assert(chunk.bytes.length <= 65_536, 'Archive transfer exceeded its byte window');
    // StorageClient transfers ownership; preserve only one bounded copy for this upload.
    await client!.sendChunk({ ...chunk, transferId: restore.inputTransfer.transferId, bytes: chunk.bytes.slice() });
    await client!.acknowledgeChunk({ transferId: transfer.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
    if (chunk.final) break;
  }
  await client!.request(id(), 'releaseArchiveJob', { operationId: id(), jobId: exported.job.jobId });
  const finished = await client!.request(id(), 'finishArchiveRestore', { operationId: id(), jobId: restore.job.jobId, byteLength: transfer.byteLength, sha256: transfer.sha256 });
  const restored = await advance(finished);
  assert(restored.job.candidate?.schemaVersion === 12, 'Restore candidate did not validate canonical schema 12');
  return { job: restored.job, peakChunkBytes, byteLength: transfer.byteLength, steps: exported.steps + restored.steps };
}
async function review(jobId: string): Promise<ArchiveActivationArgs> {
  const context = await client!.request(id(), 'readArchiveActivationContext', null);
  const reviewed = await client!.request(id(), 'prepareArchiveActivation', { operationId: id(), jobId, expectedActiveArchiveId: context.selection.archiveId, expectedRevision: context.expectedRevision });
  return { operationId: id(), expectedSelection: context.selection, review: reviewed };
}
async function verify(fixture: Fixture): Promise<unknown> {
  const diagnostics = await client!.request(id(), 'diagnostics', null);
  assert(diagnostics.integrity === 'ok' && diagnostics.schemaVersion === 12, 'Selected archive integrity or version changed');
  const parts = await client!.request(id(), 'readMessageParts', { messageId: fixture.messageId, page });
  const part = parts.items[0] as unknown as ContentPart;
  assert(parts.items.length === 1 && part.kind === 'Text' && part.data.text === text, 'Restored immutable message text changed');
  const raw = await client!.request(id(), 'readEntity', { collection: 'rawObjects', id: fixture.rawId }) as unknown as RawObject | null;
  assert(raw && raw.sha256 === fixture.digest, 'Restored raw metadata changed');
  const download = await client!.request(id(), 'readBlobTransfer', { sha256: fixture.digest }), hash = sha256.create(); let bytes = 0;
  for (;;) {
    const chunk = await client!.readChunk(download.transferId); hash.update(chunk.bytes); bytes += chunk.bytes.length;
    await client!.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
    if (chunk.final) break;
  }
  assert(bytes === length && bytesToHex(hash.digest()) === fixture.digest, 'Restored original bytes changed');
  assert((await client!.request(id(), 'archiveWorkspace', null)).workspaceId === fixture.workspaceId, 'Restored workspace identity changed');
  return diagnostics;
}
async function live(fixture: Fixture): Promise<void> {
  const generationId = id(), producerId = id(), outputMessageId = id(), now = Date.now();
  lease = await acquireGenerationLease(client!.archiveId, generationId);
  await client!.request(id(), 'registerGenerationProducer', { generationId, producerId });
  producer = { generationId, producerId };
  const generation: Generation = { id: generationId, threadId: fixture.threadId, parentMessageId: fixture.messageId, outputMessageId, contextSnapshotId: fixture.contextId, provider: 'synthetic', providerAccountId: 'fixture', model: 'fixture', parameters: {}, status: 'streaming', createdAt: now, recordedAt: now, completedAt: null, tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null, reportedCost: null, lastSequence: 0, rawResponseId: null, compatibility: [] };
  const output: Message = { id: outputMessageId, threadId: fixture.threadId, parentId: fixture.messageId, role: 'assistant', createdAt: now, recordedAt: now, generationId, editedFromMessageId: null, partCount: 0, sealed: false };
  await client!.request(id(), 'commit', batch({ version: 1, operationId: id(), recordedAt: now, kind: 'CreateGeneration', payload: { generation, output, parts: [] } }));
}
async function stop(): Promise<void> {
  assert(producer && lease, 'No live producer');
  await client!.request(id(), 'commit', batch({ version: 1, operationId: id(), recordedAt: Date.now(), kind: 'CompleteGeneration', payload: { generationId: producer.generationId, status: 'partial', completedAt: Date.now(), tokensIn: null, tokensOut: null, cachedTokens: null, estimatedCost: null, reportedCost: null, rawResponseId: null } }));
  await client!.request(id(), 'releaseGenerationProducer', producer); await lease.release(); lease = undefined; producer = undefined;
}
const api = {
  async open() { client = await openActiveStorageClient({ timeoutMs: 3000 }); return { selection: await readArchiveSelection(), diagnostics: await client.request(id(), 'diagnostics', null) }; },
  async close() { previousClient = client; await client?.close(); client = undefined; },
  reconcilePrevious: (operationIds: string[]) => reconcilePreviousArchiveOperations(previousClient!, operationIds),
  reconcileActive: (operationIds: string[]) => reconcilePreviousArchiveOperations(client!, operationIds),
  retainedStatus: (archiveId: string, operationId: string) => readRetainedArchive(archiveId, id(), 'operationStatus', { operationId }),
  selection: () => readArchiveSelection({ timeoutMs: 10_000 }),
  status: (args: ArchiveActivationArgs) => archiveActivationStatus(args.operationId, args),
  diagnostics: () => client!.request(id(), 'diagnostics', null),
  context: () => client!.request(id(), 'readArchiveActivationContext', null),
  seed, copy, review, verify, live, stop,
  write: async (title: string) => thread(title, (await client!.request(id(), 'archiveWorkspace', null)).workspaceId),
  readThread: (threadId: string) => client!.request(id(), 'readEntity', { collection: 'threads', id: threadId }),
  retainedThread: (archiveId: string, threadId: string) => readRetainedArchive(archiveId, id(), 'readEntity', { collection: 'threads', id: threadId }),
  retainedSync: (archiveId: string) => readRetainedArchive(archiveId, id(), 'readSyncOperations', { afterSequence: 0, page }),
  activate: (args: ArchiveActivationArgs, drop = false) => { const requestId = id(); if (drop) dropRequestId = requestId; return client!.request(requestId, 'activateRestoredArchive', args); },
  suppressed: () => suppressedReplies,
  async removeCatalog() { await (await navigator.storage.getDirectory()).removeEntry('quixi-selection', { recursive: true }); },
  async removeSelectedNamespace(archiveId: string) { assert(/^[a-f0-9-]{36}$/.test(archiveId), 'Only the synthetic restored candidate can be deleted'); await (await navigator.storage.getDirectory()).removeEntry(`quixi-${archiveId}`, { recursive: true }); },
  async exists(name: string) { try { await (await navigator.storage.getDirectory()).getDirectoryHandle(name); return true; } catch (error) { if ((error as DOMException).name === 'NotFoundError') return false; throw error; } },
};
(window as unknown as { activationTest: typeof api }).activationTest = api;
