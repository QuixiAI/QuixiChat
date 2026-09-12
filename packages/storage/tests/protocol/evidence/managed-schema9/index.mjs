import { openActiveStorageClient } from '../../src/client/index.ts';

const clients = new Map(), workers = new Map(), buses = new Map(), jobs = new Map();
function raw(name, legacy = false) {
  const worker = legacy ? new Worker('/frozen/archive-schema8.mjs', { type: 'module' })
    : new Worker(new URL('../../src/worker/archive.ts', import.meta.url), { type: 'module' });
  const state = { worker, messages: [], pending: new Map(), legacy, selection: null };
  worker.onmessage = ({ data }) => {
    state.messages.push(data);
    if (data.type === 'fatal') {
      for (const resolve of state.pending.values()) resolve({ ok: false, error: data.error });
      state.pending.clear();
    }
    const pending = state.pending.get(data.id);
    if (pending) { state.pending.delete(data.id); pending(data); }
  };
  workers.set(name, state);
}
function batch(title) {
  const id = () => crypto.randomUUID(), threadId = id(), contextId = id(), now = Date.now();
  return { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: [{ version: 1, operationId: id(), kind: 'CreateThread', recordedAt: now, payload: {
    thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
    context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
    state: { threadId, title, tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
  } }] };
}
function call(operation, args) {
  const id = crypto.randomUUID();
  return { id, kind: 'request', request: { version: 1, requestId: id, operation, args } };
}
function rawRequest(name, operation, args, version = 2) {
  const state = workers.get(name), request = call(operation, args);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.pending.delete(request.id); reject(new Error('Raw worker reply deadline exceeded')); }, 15_000);
    state.pending.set(request.id, reply => { clearTimeout(timer); resolve(reply); });
    state.worker.postMessage({ ...(version === null ? {} : { version }), ...(state.legacy ? {} : { selection: state.selection }), type: 'call', call: request });
  });
}
window.protocolProof = {
  async client(name) { const client = await openActiveStorageClient({ timeoutMs: 15_000 }); clients.set(name, client); return client.selection; },
  request(name, operation, args = null) { return clients.get(name).request(crypto.randomUUID(), operation, args); },
  write(name, title) { return clients.get(name).request(crypto.randomUUID(), 'commit', batch(title)); },
  closeClient(name) { return clients.get(name).close(); },
  raw,
  init(name, selection, version = 2) {
    const state = workers.get(name); state.selection = selection;
    state.worker.postMessage({ ...(version === null ? {} : { version }), type: 'init', ...(state.legacy ? { archiveId: selection.archiveId } : { selection }) });
  },
  rawRequest,
  rawWrite(name, title, version = 2) { return rawRequest(name, 'commit', batch(title), version); },
  queuedOldWrite(name, key) {
    jobs.set(key, { status: 'pending' });
    rawRequest(name, 'commit', batch('old writer must remain undispatched'), null).then(reply => jobs.set(key, { status: reply.ok ? 'committed' : 'failed', reply }), error => jobs.set(key, { status: 'deadline', error: String(error) }));
  },
  job(key) { return jobs.get(key); },
  messages(name) { return workers.get(name).messages; },
  terminate(name) { workers.get(name).worker.terminate(); },
  bus(name, archiveId, version) {
    const channel = new BroadcastChannel(`quixi:archive:${archiveId}:v${version}`);
    const state = { channel, messages: [] };
    channel.onmessage = ({ data }) => state.messages.push(data);
    buses.set(name, state);
  },
  busMessages(name) { return buses.get(name).messages; },
  hello(name, version = 2) { buses.get(name).channel.postMessage({ ...(version === null ? {} : { version }), type: 'hello' }); },
  invalidBusWrites(name, ownerId, selection) {
    const channel = buses.get(name).channel, senderId = crypto.randomUUID();
    const ids = [];
    for (const version of [null, 1, 3, '2']) {
      const request = call('commit', batch(`unsupported bus version ${version}`)); ids.push(request.id);
      channel.postMessage({ ...(version === null ? {} : { version }), type: 'call', ownerId, senderId, selection, call: request });
    }
    // Same sender ordering: this hello reaches the owner after the invalid calls.
    channel.postMessage({ version: 2, type: 'hello' });
    return ids;
  },
  async namespaceExists(archiveId) {
    const root = await navigator.storage.getDirectory();
    try { await root.getDirectoryHandle(archiveId === 'default' ? 'quixi' : `quixi-${archiveId}`); return true; }
    catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
  },
};
