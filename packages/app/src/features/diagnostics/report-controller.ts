import type { DiagnosticsReport, HostClient, SearchIndexStatus, StorageClient } from '@quixi/core/contracts';
import type { InferenceSelfTest } from '@quixi/quixi-embed/service';
import { buildDiagnosticsExport, saveDiagnosticsExport } from './export.ts';

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
export function createDiagnosticsController(storage: StorageClient, host?: HostClient) {
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
    /** Runs a semantic action under this controller's busy state (buttons disabled, notice cleared), then refreshes the report with the action's outcome. */
    async trackSemanticAction(action: () => Promise<string>) {
      if (disposed || state.running) return;
      const current = ++epoch;
      publish({ running: true, error: null, notice: null });
      let notice: string;
      try { notice = await action(); } catch (error) { notice = `The action did not complete: ${message(error)}`; }
      if (disposed || current !== epoch) return;
      publish({ notice });
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
    /** Product §100 exportable report: the last storage report and inference self-test as one JSON file through the host save flow. */
    async save(inference: InferenceSelfTest | null, options: { inferenceOmitted?: string | null } = {}) {
      if (disposed || state.running || !host) return;
      const current = ++epoch;
      publish({ running: true, error: null, notice: null });
      const kind = (await host.capabilities().catch(() => null))?.host ?? 'web';
      const userAgent = typeof navigator === 'undefined' ? null : navigator.userAgent;
      const saved = await guard(current, () => saveDiagnosticsExport(host, buildDiagnosticsExport({ storage: state.report, inference, host: kind, userAgent, inferenceOmitted: options.inferenceOmitted ?? null })));
      if (disposed || current !== epoch) return;
      publish({ running: false, ...(saved ? { notice: `Diagnostics report saved as ${saved.name} (${saved.byteLength.toLocaleString()} bytes; operational metadata only).` } : {}) });
    },
    invalidate() { if (disposed) return; epoch++; publish({ report: null, running: false, notice: null, error: null }); },
    dispose() { disposed = true; epoch++; listeners.clear(); },
  };
}
export type DiagnosticsController = ReturnType<typeof createDiagnosticsController>;
