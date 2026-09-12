import type { BlobCleanupResult, BlobInventoryFinding, StorageClient } from '@quixi/core/contracts';
import { BLOB_CLEANUP_MAX_ITEMS } from '@quixi/core/contracts';
import type { StorageHealthController } from './controller.ts';

export interface CleanupSnapshot {
  /** Digest → stored bytes of the orphan findings the user ticked in the current scan. */
  selected: Record<string, number | null>;
  reviewing: boolean;
  busy: boolean;
  result: BlobCleanupResult | null;
  error: string | null;
}
const message = (error: unknown) => { const text = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : String(error); return text.length > 200 ? `${text.slice(0, 199)}…` : text; };
/** Plan 23 reviewed cleanup: selection is explicit per finding, the scope is
 * shown before anything is deleted, deletion is bound to the reviewed scan,
 * and the storage worker re-checks every digest. Nothing canonical is touched. */
export function createCleanupController(storage: StorageClient, health: StorageHealthController) {
  let state: CleanupSnapshot = { selected: {}, reviewing: false, busy: false, result: null, error: null };
  const listeners = new Set<() => void>();
  let disposed = false, boundScan: string | null = null;
  const publish = (patch: Partial<CleanupSnapshot>) => { state = { ...state, ...patch }; if (!disposed) for (const listener of listeners) listener(); };
  // A new or stale scan drops the selection: the ticked findings no longer describe current storage.
  const unsubscribe = health.subscribe(() => {
    const current = health.scanId(), status = health.getSnapshot().status;
    if (current !== boundScan) { boundScan = current; if (Object.keys(state.selected).length || state.reviewing || state.result) publish({ selected: {}, reviewing: false, result: null }); }
    else if (status && status.state !== 'complete' && (Object.keys(state.selected).length || state.reviewing)) publish({ selected: {}, reviewing: false });
  });
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    toggle(finding: BlobInventoryFinding) {
      if (disposed || state.busy || finding.kind !== 'orphan_blob' || !finding.sha256) return;
      boundScan = health.scanId();
      const selected = { ...state.selected };
      if (finding.sha256 in selected) delete selected[finding.sha256];
      else if (Object.keys(selected).length < BLOB_CLEANUP_MAX_ITEMS) selected[finding.sha256] = finding.actualBytes;
      publish({ selected, reviewing: false, result: null, error: null });
    },
    review() { if (!disposed && Object.keys(state.selected).length) publish({ reviewing: true, error: null }); },
    cancelReview() { if (!disposed) publish({ reviewing: false }); },
    /** Deletes exactly the reviewed selection; refusals come back named per digest. */
    async confirm() {
      const scanId = health.scanId(), sha256s = Object.keys(state.selected);
      if (disposed || state.busy || !state.reviewing || !scanId || !sha256s.length) return;
      publish({ busy: true, error: null });
      try {
        const result = await storage.request(crypto.randomUUID(), 'deleteOrphanBlobs', { scanId, sha256s });
        if (disposed) return;
        publish({ result, selected: {}, reviewing: false, busy: false });
        // The worker marks the scan stale once files changed; refresh shows that state.
        await health.refresh();
      } catch (error) { if (!disposed) publish({ busy: false, error: message(error) }); }
    },
    dispose() { disposed = true; unsubscribe(); listeners.clear(); },
  };
}
export type CleanupController = ReturnType<typeof createCleanupController>;
