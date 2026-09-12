import { assertArchiveSelection } from '@quixi/core/contracts';
import type { ArchiveSelection, ArchiveActivationArgs, ArchiveActivationStatus } from '@quixi/core/contracts';
import { ARCHIVE_PROTOCOL_VERSION, ArchiveStorageError, archiveError, hasArchiveProtocolVersion } from '../archive-protocol.ts';
import { ArchiveStorageClient } from './archive.ts';

/** Catalog requests use their own Storage Worker and never open a selected
 * archive merely to inspect an activation receipt after an uncertain reply. */
async function selectionRequest(type: 'read' | 'status', args: object, timeoutMs = 60_000): Promise<unknown> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('Invalid selection request deadline');
  const worker = new Worker(new URL('../worker/selection.ts', import.meta.url), { type: 'module' });
  const id = crypto.randomUUID();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ArchiveStorageError(archiveError(new Error('Archive selection could not be read before its deadline; close old Quixi tabs and retry.'), id, null, 'IO_ERROR'))), timeoutMs);
      worker.onmessage = ({ data }) => {
        if (!hasArchiveProtocolVersion(data as unknown) || data.id !== id) return;
        clearTimeout(timer);
        data.ok ? resolve(data.result) : reject(new ArchiveStorageError(data.error));
      };
      worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message || 'Archive selection worker failed')); };
      worker.postMessage({ version: ARCHIVE_PROTOCOL_VERSION, type, id, ...args });
    });
  } finally { worker.terminate(); }
}
export async function readArchiveSelection(options: { timeoutMs?: number } = {}): Promise<ArchiveSelection> {
  const selected = await selectionRequest('read', {}, options.timeoutMs);
  assertArchiveSelection(selected); return selected;
}
export async function archiveActivationStatus(operationId: string, fullArgs?: ArchiveActivationArgs): Promise<ArchiveActivationStatus> {
  return await selectionRequest('status', { operationId, fullArgs }) as ArchiveActivationStatus;
}
/** Resolve once, pin the complete fence, and await the actual owner handshake.
 * A later switch never retargets this client's queued operations. */
export async function openActiveStorageClient(options: { timeoutMs?: number } = {}): Promise<ArchiveStorageClient> {
  const selection = await readArchiveSelection(options);
  const storage = new ArchiveStorageClient({ selection, ...options });
  try { await storage.request(crypto.randomUUID(), 'diagnostics', null); return storage; }
  catch (error) { await storage.close(); throw error; }
}
