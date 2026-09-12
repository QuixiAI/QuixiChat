const workers = new Map();
const jobs = new Map();
function connect(name, worker) {
  const state = { worker, pending: new Map(), fatal: null, events: [], closed: false };
  worker.onmessage = ({ data }) => {
    if (data.event) { state.events.push(data); return; }
    if (data.type === 'closed') { state.closed = true; return; }
    if (data.type === 'fatal') {
      state.fatal = data.error;
      for (const pending of state.pending.values()) pending.reject(data.error);
      state.pending.clear(); return;
    }
    const pending = state.pending.get(data.id);
    if (pending) { state.pending.delete(data.id); data.ok ? pending.resolve(data.result) : pending.reject(data.error); }
  };
  workers.set(name, state); return state;
}
function message(name, data) {
  const state = workers.get(name);
  if (state.fatal) return Promise.reject(state.fatal);
  const id = data.call?.id ?? data.id;
  return new Promise((resolve, reject) => { state.pending.set(id, { resolve, reject }); state.worker.postMessage(data); });
}
const request = (name, operation, args) => {
  const id = crypto.randomUUID();
  return message(name, { type: 'call', call: { id, kind: 'request', request: { version: 1, requestId: id, operation, args } } });
};
function batch(title) {
  const id = () => crypto.randomUUID(), threadId = id(), contextId = id(), now = Date.now();
  return { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: [{ version: 1, operationId: id(), kind: 'CreateThread', recordedAt: now, payload: {
    thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
    context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
    state: { threadId, title, tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
  } }] };
}
window.schema8Proof = {
  old(name, archiveId) { connect(name, new Worker('/frozen/archive-schema8.mjs', { type: 'module' })).worker.postMessage({ type: 'init', archiveId }); },
  marker(name) { connect(name, new Worker(new URL('./marker.ts', import.meta.url), { type: 'module' })); },
  request,
  write(name, title) { return request(name, 'commit', batch(title)); },
  queuedWrite(name, title, key) { jobs.set(key, { state: 'pending' }); request(name, 'commit', batch(title)).then(result => jobs.set(key, { state: 'committed', result }), error => jobs.set(key, { state: 'failed', error })); },
  job(key) { return jobs.get(key); },
  markerCall(name, command, args = {}) { return message(name, { id: crypto.randomUUID(), command, args }); },
  startMarker(name, command, args, key) { jobs.set(key, { state: 'pending' }); this.markerCall(name, command, args).then(result => jobs.set(key, { state: 'committed', result }), error => jobs.set(key, { state: 'failed', error })); },
  events(name) { return workers.get(name).events; },
  fatal(name) { return workers.get(name).fatal; },
  close(name) { workers.get(name).worker.postMessage({ type: 'close' }); },
  closed(name) { return workers.get(name).closed; },
  kill(name) { workers.get(name).worker.terminate(); },
  locks() { return navigator.locks.query(); },
};
