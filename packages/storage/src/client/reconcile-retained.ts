import { sameArchiveSelection, STORAGE_BOUNDARIES } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import type { ArchiveStorageClient } from './archive.ts';
import { readArchiveSelection } from './selection.ts';
import { readRetainedArchive } from './retained-archive.ts';

/** Resolve a pending canonical batch in its original archive after a switch.
 * Closes the stale client before taking bounded read-only ownership. Never
 * resubmits the batch or redirects its identities to the selected archive. */
export async function reconcilePreviousArchiveOperations(storage: ArchiveStorageClient, operationIds: readonly string[]): Promise<'committed' | 'not_committed'> {
  if (!operationIds.length || operationIds.length > STORAGE_BOUNDARIES.maxBatchMutations || !operationIds.every(isQuixiId) || new Set(operationIds).size !== operationIds.length)
    throw new Error('Invalid pending canonical operation identities');
  const current = await readArchiveSelection();
  if (sameArchiveSelection(current, storage.selection)) throw new Error('This archive is still selected; resolve the original write conflict before retrying.');
  await storage.close();
  let committed = 0;
  for (const operationId of operationIds) {
    const status = await readRetainedArchive(storage.archiveId, crypto.randomUUID(), 'operationStatus', { operationId });
    if (status.status === 'committed') committed++;
  }
  if (committed && committed !== operationIds.length) throw new Error('Pending transaction has inconsistent retained receipts; preserve its identities for recovery.');
  return committed ? 'committed' : 'not_committed';
}
