import type { BlobHashAuditFinding, BlobHashAuditStatus, BlobInventoryFinding, BlobInventoryStatus, DoctorAuditFinding, DoctorAuditStatus, StorageClient, StorageOperations } from '@quixi/core/contracts';

export const INVENTORY_PAGE = { maxItems: 32, maxBytes: 16_384 } as const;
export const AUDIT_PAGE = { maxItems: 32, maxBytes: 16_384 } as const;
type ScanState = 'running' | 'complete' | 'cancelled' | 'stale' | 'failed';
export interface ScanSnapshot<TStatus, TFinding> {
  status: TStatus | null;
  findings: TFinding[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}
export type StorageHealthSnapshot = ScanSnapshot<BlobInventoryStatus, BlobInventoryFinding>;
export type DoctorAuditSnapshot = ScanSnapshot<DoctorAuditStatus, DoctorAuditFinding>;
/** The five operations of one bounded worker scan (blob inventory, Doctor audit). */
export interface ScanOperations {
  begin: keyof StorageOperations; advance: keyof StorageOperations; status: keyof StorageOperations; read: keyof StorageOperations; cancel: keyof StorageOperations;
  advanceItems: number; page: { maxItems: number; maxBytes: number };
  stale: string; unavailable: string;
}
export const INVENTORY_OPERATIONS: ScanOperations = {
  begin: 'beginBlobInventory', advance: 'advanceBlobInventory', status: 'blobInventoryStatus', read: 'readBlobInventoryFindings', cancel: 'cancelBlobInventory',
  advanceItems: 64, page: INVENTORY_PAGE,
  stale: 'Storage changed during or after this scan. Start a new scan to see current findings.',
  unavailable: 'This scan is no longer available. Storage may have restarted or become unavailable. Start a new scan; if that fails, reopen the app.',
};
export const AUDIT_OPERATIONS: ScanOperations = {
  begin: 'beginDoctorAudit', advance: 'advanceDoctorAudit', status: 'doctorAuditStatus', read: 'readDoctorAuditFindings', cancel: 'cancelDoctorAudit',
  advanceItems: 64, page: AUDIT_PAGE,
  stale: 'Saved history changed during or after this audit. Start a new audit to see current findings.',
  unavailable: 'This audit is no longer available. Storage may have restarted or become unavailable. Start a new audit; if that fails, reopen the app.',
};
export const HASH_AUDIT_OPERATIONS: ScanOperations = {
  begin: 'beginBlobHashAudit', advance: 'advanceBlobHashAudit', status: 'blobHashAuditStatus', read: 'readBlobHashAuditFindings', cancel: 'cancelBlobHashAudit',
  advanceItems: 16, page: AUDIT_PAGE,
  stale: 'Stored files or their catalog changed during or after this audit. Start a new audit to see current findings.',
  unavailable: 'This audit is no longer available. Storage may have restarted or become unavailable. Start a new audit; if that fails, reopen the app.',
};
/** A scan is explicit, bounded and read-only. Its lifetime follows the app,
 * so moving to another panel does not restart or discard an active scan. */
export function createScanController<TStatus extends { state: ScanState }, TFinding>(storage: StorageClient, operations: ScanOperations) {
  let state: ScanSnapshot<TStatus, TFinding> = { status: null, findings: [], nextCursor: null, loading: false, error: null };
  const listeners = new Set<() => void>();
  let epoch = 0, scanId: string | null = null, pending: string | null = null, pendingScanId: string | null = null, disposed = false;
  let active: Promise<void> | null = null;
  const publish = (patch: Partial<ScanSnapshot<TStatus, TFinding>>) => { state = { ...state, ...patch }; if (!disposed) for (const listener of listeners) listener(); };
  const request = async (current: number, operation: keyof StorageOperations, args: unknown) => {
    if (disposed || current !== epoch) throw new Error('Inventory request is no longer current');
    const requestId = crypto.randomUUID(); pending = requestId; pendingScanId = (args as { scanId?: string } | null)?.scanId ?? null;
    try {
      const result = await storage.request(requestId, operation, args as never);
      if (disposed || current !== epoch) throw new Error('Inventory request is no longer current');
      return result;
    } finally { if (pending === requestId) { pending = null; pendingScanId = null; } }
  };
  const release = async (value: string | null) => {
    const requestId = pendingScanId === value ? pending : null;
    if (requestId) await storage.cancel(requestId, null).catch(() => {});
    if (value) await storage.request(crypto.randomUUID(), operations.cancel, { scanId: value } as never).catch(() => {});
  };
  const invalidate = () => {
    if (!scanId || disposed) return;
    epoch++;
    const previous = scanId; scanId = null;
    publish({ status: state.status ? { ...state.status, state: 'stale' } : null, findings: [], nextCursor: null, loading: false,
      error: operations.stale });
    const previousTask = active;
    void (async () => { await release(previous); await previousTask; await release(previous); })();
  };
  const unsubscribe = storage.onChange(invalidate);
  const accept = (status: TStatus) => {
    publish({ status, ...(status.state === 'stale' || status.state === 'failed' || status.state === 'cancelled' ? { findings: [], nextCursor: null } : {}) });
  };
  const readPage = async (current: number, value: string, cursor: string | null) => {
    const status = await request(current, operations.status, { scanId: value }) as TStatus; accept(status);
    if (status.state !== 'complete') return;
    const page = await request(current, operations.read, { scanId: value, page: { ...operations.page, cursor } }) as { items: TFinding[]; nextCursor: string | null };
    // The worker is authoritative for freshness and bounds. A final status
    // check also prevents an expired result from becoming a visible page.
    const latest = await request(current, operations.status, { scanId: value }) as TStatus; accept(latest);
    if (latest.state === 'complete') publish({ findings: page.items, nextCursor: page.nextCursor });
  };
  const failed = (current: number) => {
    if (disposed || current !== epoch) return;
    publish({ findings: [], nextCursor: null, loading: false,
      status: state.status ? { ...state.status, state: 'failed' } : null,
      error: operations.unavailable });
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
          let status = await request(current, operations.begin, { scanId: value }) as TStatus; accept(status); publish({ loading: false });
          while (status.state === 'running') {
            // Yield between bounded worker slices so Stop and navigation remain
            // responsive even when the archive contains many files.
            await new Promise<void>(resolve => setTimeout(resolve, 16));
            status = await request(current, operations.advance, { scanId: value, maxItems: operations.advanceItems }) as TStatus; accept(status);
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
      try { accept(await request(current, operations.status, { scanId: value }) as TStatus); }
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
export const createStorageHealthController = (storage: StorageClient) => createScanController<BlobInventoryStatus, BlobInventoryFinding>(storage, INVENTORY_OPERATIONS);
export type StorageHealthController = ReturnType<typeof createStorageHealthController>;
export const createDoctorAuditController = (storage: StorageClient) => createScanController<DoctorAuditStatus, DoctorAuditFinding>(storage, AUDIT_OPERATIONS);
export type DoctorAuditController = ReturnType<typeof createDoctorAuditController>;
export const createBlobHashAuditController = (storage: StorageClient) => createScanController<BlobHashAuditStatus, BlobHashAuditFinding>(storage, HASH_AUDIT_OPERATIONS);
export type BlobHashAuditController = ReturnType<typeof createBlobHashAuditController>;
