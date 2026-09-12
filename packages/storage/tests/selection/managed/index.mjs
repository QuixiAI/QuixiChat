const workers = new Map(), jobs = new Map();
window.managedProof = {
  create(name) {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const state = { worker, pending: new Map(), events: [] }; workers.set(name, state);
    worker.onmessage = ({ data }) => {
      if (data.event) { state.events.push(data); return; }
      const pending = state.pending.get(data.id); if (!pending) return;
      state.pending.delete(data.id); clearTimeout(pending.timer);
      data.ok ? pending.resolve(data.result) : pending.reject(data.error);
    };
  },
  call(name, command, args = {}) {
    const id = crypto.randomUUID(), state = workers.get(name);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { state.pending.delete(id); reject({ code: 'TEST_TIMEOUT', message: command }); }, 30_000);
      state.pending.set(id, { resolve, reject, timer }); state.worker.postMessage({ id, command, args });
    });
  },
  start(name, command, args, key) { jobs.set(key, { state: 'pending' }); this.call(name, command, args).then(result => jobs.set(key, { state: 'done', result }), error => jobs.set(key, { state: 'failed', error })); },
  job(key) { return jobs.get(key); },
  events(name) { return workers.get(name).events; },
  kill(name) { workers.get(name).worker.terminate(); },
};
