const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
let nextId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let failure: Error | undefined;
const fail = (error: Error) => {
  failure = error;
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
};
worker.onerror = event => fail(new Error(event.message || "Blob acceptance worker failed"));
worker.onmessageerror = () => fail(new Error("Blob acceptance worker response could not be decoded"));
worker.onmessage = event => {
  const entry = pending.get(event.data.id);
  if (!entry) return;
  pending.delete(event.data.id);
  if (event.data.error) entry.reject(new Error(event.data.error)); else entry.resolve(event.data.result);
};
Object.assign(window, {
  blobTest: (operation: string, namespace: string) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = nextId++; pending.set(id, { resolve, reject }); worker.postMessage({ id, operation, namespace });
  }),
});
