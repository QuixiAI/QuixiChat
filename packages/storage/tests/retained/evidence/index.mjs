import { openActiveStorageClient } from '../../src/client/selection.ts';
import { readRetainedArchive, RETAINED_ARCHIVE_LIMITS } from '../../src/client/retained-archive.ts';

const id = () => crypto.randomUUID();
const page = { maxItems: 8, maxBytes: 65_536, cursor: null };
let client, fixture, heldWorker;
const request = (operation, args = null) => client.request(id(), operation, args);
function thread(title) {
  const threadId = id(), contextId = id(), now = Date.now();
  return { threadId, mutation: { version: 1, operationId: id(), kind: 'CreateThread', recordedAt: now, payload: {
    thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
    context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
    state: { threadId, title, tags: ['日本語'], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
  } } };
}
const batch = mutations => ({ transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations });
async function advance(job) {
  for (let n = 0; job.state === 'working'; n++) {
    if (n > 1000) throw new Error('Fixture archive step bound exceeded');
    job = await request('advanceArchiveJob', { operationId: id(), jobId: job.jobId, maxRecords: 16, maxBytes: 262144 });
  }
  if (job.state !== 'ready') throw new Error(JSON.stringify(job));
  return job;
}
async function clone() {
  const operationId = id();
  const exported = await advance(await request('beginArchiveExport', { operationId, format: 'portable' }));
  const transfer = await request('openArchiveExport', { jobId: exported.jobId });
  const restore = await request('beginArchiveRestore', { operationId: id(), expectedBytes: transfer.byteLength, expectedSha256: transfer.sha256 });
  for (;;) {
    const chunk = await client.readChunk(transfer.transferId);
    await client.sendChunk({ ...chunk, transferId: restore.inputTransfer.transferId, bytes: chunk.bytes.slice() });
    await client.acknowledgeChunk({ transferId: chunk.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
    if (chunk.final) break;
  }
  await request('releaseArchiveJob', { operationId: id(), jobId: exported.jobId });
  const copied = await advance(await request('finishArchiveRestore', { operationId: id(), jobId: restore.job.jobId, byteLength: transfer.byteLength, sha256: transfer.sha256 }));
  await request('releaseArchiveJob', { operationId: id(), jobId: copied.jobId });
  return { candidateId: copied.candidate.archiveId, archiveOperationId: operationId };
}
const result = async action => { try { return { ok: true, result: await action() }; } catch (error) { return { ok: false, code: error.code, message: error.message }; } };
window.retainedProof = {
  async private(command, archiveId, targetId) {
    const worker = new Worker(new URL('./fixture-worker.mjs', import.meta.url), { type: 'module' });
    let held = false;
    try { return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Private fixture worker deadline')), 15000);
      worker.onmessage = ({ data }) => {
        clearTimeout(timer); held = !!data.held;
        if (held) heldWorker = worker;
        data.ok ? resolve(data.held ? data : data.result) : reject(new Error(data.error));
      };
      worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.postMessage({ command, archiveId, targetId });
    }); } finally { if (!held) worker.terminate(); }
  },
  killHeld() { heldWorker.terminate(); heldWorker = undefined; },
  async seed() {
    client = await openActiveStorageClient();
    const initial = thread('Retained 日本語 😀'), messageId = id(), now = Date.now(), text = 'before\u0000after 日本語 😀 café\nline two';
    const message = { version: 1, operationId: id(), kind: 'CreateMessage', recordedAt: now, payload: {
      message: { id: messageId, threadId: initial.threadId, parentId: null, role: 'user', createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
      parts: [{ id: id(), messageId, order: 0, kind: 'Text', data: { text } }],
    } };
    await request('commit', batch([initial.mutation, message]));
    fixture = { ...await clone(), threadId: initial.threadId, messageId, text, operationId: message.operationId };
    const later = thread('Source only after candidate snapshot'); await request('commit', batch([later.mutation]));
    fixture.laterThreadId = later.threadId;
    fixture.selection = client.selection;
    return fixture;
  },
  close() { return client.close(); },
  read(archiveId, operation, args, options) { return result(() => readRetainedArchive(archiveId, id(), operation, args, options)); },
  async allReads(archiveId) {
    const entries = [
      ['readEntity', { collection: 'threads', id: fixture.threadId }],
      ['readEntities', { collection: 'threads', threadId: null, page }],
      ['readMessageParts', { messageId: fixture.messageId, page }],
      ['readSyncOperations', { afterSequence: 0, page }],
      ['operationStatus', { operationId: fixture.operationId }],
      ['listLibrary', { archived: false, title: '', page }],
      ['readThreadView', { threadId: fixture.threadId }],
      ['readConversationWindow', { threadId: fixture.threadId, leafMessageId: fixture.messageId, page }],
      ['readMessageChildren', { threadId: fixture.threadId, parentMessageId: null, page }],
    ];
    const values = {};
    for (const [operation, args] of entries) values[operation] = await readRetainedArchive(archiveId, id(), operation, args);
    return values;
  },
  async admission(archiveId) {
    const Native = globalThis.Worker; let active = 0, peak = 0, created = 0;
    globalThis.Worker = class extends Native {
      constructor(...args) { super(...args); active++; created++; peak = Math.max(active, peak); }
      terminate() { active--; super.terminate(); }
    };
    try {
      const args = { collection: 'threads', id: fixture.threadId };
      const calls = Array.from({ length: 5 }, () => result(() => readRetainedArchive(archiveId, id(), 'readEntity', args)));
      const values = await Promise.all(calls);
      const beforeInvalid = created;
      const invalid = await result(() => readRetainedArchive(archiveId, id(), 'commit', batch([])));
      const oversized = await result(() => readRetainedArchive(archiveId, id(), 'readEntities', { collection: 'threads', threadId: null, page: { ...page, cursor: 'x'.repeat(262144) } }));
      return { values, invalid, oversized, peak, active, created, beforeInvalid, limits: RETAINED_ARCHIVE_LIMITS };
    } finally { globalThis.Worker = Native; }
  },
  async timeout(archiveId) {
    const Native = globalThis.Worker; let dropped = 0, terminated = 0;
    globalThis.Worker = class extends Native {
      constructor(...args) { super(...args); this.addEventListener('message', event => { dropped++; event.stopImmediatePropagation(); }); }
      terminate() { terminated++; super.terminate(); }
    };
    try { return { outcome: await result(() => readRetainedArchive(archiveId, id(), 'readEntity', { collection: 'threads', id: fixture.threadId }, { timeoutMs: 2000 })), dropped, terminated }; }
    finally { globalThis.Worker = Native; }
  },
  async namespaceExists(archiveId) {
    try { await (await navigator.storage.getDirectory()).getDirectoryHandle(`quixi-${archiveId}`); return true; }
    catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
  },
  async raw(operation, archiveId, version = 2, args, requestId = id()) {
    const worker = new Worker(new URL('../../src/worker/retained-archive.ts', import.meta.url), { type: 'module' });
    try { return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Raw reader fixture deadline')), 15000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); resolve(data); };
      worker.postMessage({ version, type: 'retained-read', archiveId, request: { version: 1, requestId, operation, args: args ?? (operation === 'commit' ? batch([]) : null) } });
    }); } finally { worker.terminate(); }
  },
};
