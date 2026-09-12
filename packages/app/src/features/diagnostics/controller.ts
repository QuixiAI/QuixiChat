import type { BlobInventoryFinding, BlobInventoryStatus, StorageClient, StorageOperations } from '@quixi/core/contracts';

export const INVENTORY_PAGE = { maxItems: 32, maxBytes: 16_384 } as const;
export interface StorageHealthSnapshot {
  status: BlobInventoryStatus | null;
  findings: BlobInventoryFinding[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}
/** Inventory is explicit, bounded and read-only. Its lifetime follows the app,
 * so moving to another panel does not restart or discard an active scan. */
export function createStorageHealthController(storage: StorageClient) {
  let state: StorageHealthSnapshot = { status: null, findings: [], nextCursor: null, loading: false, error: null };
  const listeners = new Set<() => void>();
  let epoch = 0, scanId: string | null = null, pending: string | null = null, pendingScanId: string | null = null, disposed = false;
  let active: Promise<void> | null = null;
  const publish = (patch: Partial<StorageHealthSnapshot>) => { state = { ...state, ...patch }; if (!disposed) for (const listener of listeners) listener(); };
  const request = async <K extends keyof StorageOperations>(current: number, operation: K, args: StorageOperations[K]['args']) => {
    if (disposed || current !== epoch) throw new Error('Inventory request is no longer current');
    const requestId = crypto.randomUUID(); pending = requestId; pendingScanId = (args as { scanId?: string } | null)?.scanId ?? null;
    try {
      const result = await storage.request(requestId, operation, args);
      if (disposed || current !== epoch) throw new Error('Inventory request is no longer current');
      return result;
    } finally { if (pending === requestId) { pending = null; pendingScanId = null; } }
  };
  const release = async (value: string | null) => {
    const requestId = pendingScanId === value ? pending : null;
    if (requestId) await storage.cancel(requestId, null).catch(() => {});
    if (value) await storage.request(crypto.randomUUID(), 'cancelBlobInventory', { scanId: value }).catch(() => {});
  };
  const invalidate = () => {
    if (!scanId || disposed) return;
    epoch++;
    const previous = scanId; scanId = null;
    publish({ status: state.status ? { ...state.status, state: 'stale' } : null, findings: [], nextCursor: null, loading: false,
      error: 'Storage changed during or after this scan. Start a new scan to see current findings.' });
    const previousTask = active;
    void (async () => { await release(previous); await previousTask; await release(previous); })();
  };
  const unsubscribe = storage.onChange(invalidate);
  const accept = (status: BlobInventoryStatus) => {
    publish({ status, ...(status.state === 'stale' || status.state === 'failed' || status.state === 'cancelled' ? { findings: [], nextCursor: null } : {}) });
  };
  const readPage = async (current: number, value: string, cursor: string | null) => {
    const status = await request(current, 'blobInventoryStatus', { scanId: value }); accept(status);
    if (status.state !== 'complete') return;
    const page = await request(current, 'readBlobInventoryFindings', { scanId: value, page: { ...INVENTORY_PAGE, cursor } });
    // The worker is authoritative for freshness and bounds. A final status
    // check also prevents an expired result from becoming a visible page.
    const latest = await request(current, 'blobInventoryStatus', { scanId: value }); accept(latest);
    if (latest.state === 'complete') publish({ findings: page.items, nextCursor: page.nextCursor });
  };
  const failed = (current: number) => {
    if (disposed || current !== epoch) return;
    publish({ findings: [], nextCursor: null, loading: false,
      status: state.status ? { ...state.status, state: 'failed' } : null,
      error: 'This scan is no longer available. Storage may have restarted or become unavailable. Start a new scan; if that fails, reopen the app.' });
  };
  const track = (task: Promise<void>) => { active = task; void task.finally(() => { if (active === task) active = null; }); return task; };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (disposed || active || state.loading) return Promise.resolve();
      const current = ++epoch, previous = scanId, value = crypto.randomUUID(); scanId = value;
      publish({ status: null, findings: [], nextCursor: null, loading: true, error: null });
      return track((async () => {
        try {
          await release(previous);
          let status = await request(current, 'beginBlobInventory', { scanId: value }); accept(status); publish({ loading: false });
          while (status.state === 'running') {
            // Yield between bounded worker slices so Stop and navigation remain
            // responsive even when the archive contains many files.
            await new Promise<void>(resolve => setTimeout(resolve, 16));
            status = await request(current, 'advanceBlobInventory', { scanId: value, maxItems: 64 }); accept(status);
          }
          if (status.state === 'complete') { publish({ loading: true }); await readPage(current, value, null); }
        } catch { failed(current); }
        finally { if (!disposed && current === epoch) publish({ loading: false }); }
      })());
    },
    async stop() {
      if (disposed || !scanId) return;
      const current = ++epoch, value = scanId;
      const previousTask = active;
      publish({ loading: true, findings: [], nextCursor: null });
      await release(value);
      await previousTask;
      // A begin request can finish after its cancellation acknowledgement.
      // Retire that late scan before allowing another explicit start.
      await release(value);
      if (disposed || current !== epoch) return;
      try { accept(await request(current, 'blobInventoryStatus', { scanId: value })); }
      catch { if (state.status) publish({ status: { ...state.status, state: 'cancelled' } }); }
      if (current === epoch) publish({ loading: false });
    },
    refresh() {
      if (disposed || active || !scanId) return Promise.resolve();
      const current = epoch, value = scanId;
      publish({ loading: true, findings: [], nextCursor: null });
      return track(readPage(current, value, null).catch(() => failed(current)).finally(() => { if (!disposed && current === epoch) publish({ loading: false }); }));
    },
    page(first = false) {
      if (disposed || active || state.loading || state.status?.state !== 'complete' || !scanId || !first && !state.nextCursor) return Promise.resolve();
      const current = epoch, value = scanId, cursor = first ? null : state.nextCursor;
      publish({ loading: true, findings: [], nextCursor: null });
      return track(readPage(current, value, cursor).catch(() => failed(current)).finally(() => { if (!disposed && current === epoch) publish({ loading: false }); }));
    },
    invalidate,
    async dispose() {
      if (disposed) return;
      disposed = true; epoch++; unsubscribe(); listeners.clear();
      const previous = scanId; scanId = null;
      await release(previous); await active; await release(previous);
    },
  };
}
export type StorageHealthController = ReturnType<typeof createStorageHealthController>;
