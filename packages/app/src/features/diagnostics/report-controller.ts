import type { DiagnosticsReport, SearchIndexStatus, StorageClient } from '@quixi/core/contracts';

export interface DiagnosticsSnapshot {
  report: DiagnosticsReport | null;
  running: boolean;
  /** Last repair action outcome, in plain words. */
  notice: string | null;
  error: string | null;
}
const message = (error: unknown) => {
  const text = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};
/** Product §100/§101: an explicit, read-only diagnostics report and the two
 * derived-index repairs that never touch canonical rows. Semantic delete and
 * rebuild live in the semantic controller because they also own the runtime. */
export function createDiagnosticsController(storage: StorageClient) {
  let state: DiagnosticsSnapshot = { report: null, running: false, notice: null, error: null };
  const listeners = new Set<() => void>();
  let disposed = false, epoch = 0;
  const publish = (patch: Partial<DiagnosticsSnapshot>) => { state = { ...state, ...patch }; if (!disposed) for (const listener of listeners) listener(); };
  const guard = async <T>(current: number, work: () => Promise<T>): Promise<T | undefined> => {
    try { const result = await work(); if (disposed || current !== epoch) return undefined; return result; }
    catch (error) { if (!disposed && current === epoch) publish({ error: message(error) }); return undefined; }
  };
  const describe = (status: SearchIndexStatus) => status.rebuildingEpoch === null
    ? `Search index rebuild recorded; ${status.indexedChunks.toLocaleString()} chunks are indexed at epoch ${status.activeEpoch}.`
    : `Search index rebuild started at epoch ${status.rebuildingEpoch}; the current index (${status.indexedChunks.toLocaleString()} chunks) stays searchable until the rebuild replaces it. Saved history is untouched.`;
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** One explicit report; integrity_check runs in the storage worker, so this is never polled. */
    async run() {
      if (disposed || state.running) return;
      const current = ++epoch;
      publish({ running: true, error: null });
      const report = await guard(current, () => storage.request(crypto.randomUUID(), 'diagnosticsReport', null));
      if (disposed || current !== epoch) return;
      publish({ running: false, ...(report ? { report } : {}) });
    },
    /** Rebuilds only derived lexical data (product §101 "rebuild FTS"); canonical rows, provenance, branches and blob bytes are not read for writing. */
    async rebuildSearchIndex() {
      if (disposed || state.running) return;
      const current = ++epoch;
      publish({ running: true, error: null, notice: null });
      const status = await guard(current, () => storage.request(crypto.randomUUID(), 'rebuildSearch', { operationId: crypto.randomUUID() }));
      if (disposed || current !== epoch) return;
      if (status) publish({ notice: describe(status) });
      const report = await guard(current, () => storage.request(crypto.randomUUID(), 'diagnosticsReport', null));
      if (disposed || current !== epoch) return;
      publish({ running: false, ...(report ? { report } : {}) });
    },
    /** Called after a semantic action so the report reflects it. */
    async refreshAfter(notice: string) {
      if (disposed) return;
      const current = ++epoch;
      publish({ running: true, error: null, notice });
      const report = await guard(current, () => storage.request(crypto.randomUUID(), 'diagnosticsReport', null));
      if (disposed || current !== epoch) return;
      publish({ running: false, ...(report ? { report } : {}) });
    },
    invalidate() { if (disposed) return; epoch++; publish({ report: null, running: false, notice: null, error: null }); },
    dispose() { disposed = true; epoch++; listeners.clear(); },
  };
}
export type DiagnosticsController = ReturnType<typeof createDiagnosticsController>;
