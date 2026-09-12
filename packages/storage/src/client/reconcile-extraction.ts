import { sameArchiveSelection } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import { ArchiveStorageError, archiveError } from '../archive-protocol.ts';
import type { ArchiveStorageClient } from './archive.ts';
import { readArchiveSelection } from './selection.ts';
import { readRetainedArchive } from './retained-archive.ts';

/** Resolve one exact extraction write in its retained original archive. The
 * caller must first drain all workflows borrowing this shared client: this
 * explicit recovery closes it to release the old archive's owner lock. No write,
 * replay, active-archive open, migration or derived repair occurs. */
export async function reconcilePreviousArchiveExtraction(
  storage: ArchiveStorageClient, pending: { operationId: string; requestDigest: string },
): Promise<'committed' | 'not_committed'> {
  const requestId = crypto.randomUUID();
  if (!pending || Object.keys(pending).sort().join(',') !== 'operationId,requestDigest' || !isQuixiId(pending.operationId) ||
      typeof pending.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(pending.requestDigest))
    throw new ArchiveStorageError(archiveError(new Error('Invalid exact extraction recovery identity'), requestId, null, 'INVALID_REQUEST'));
  const { operationId, requestDigest } = pending;
  const archiveId = storage.archiveId, selected = { ...storage.selection };
  if (archiveId !== selected.archiveId)
    throw new ArchiveStorageError(archiveError(new Error('Original archive identity differs from its captured selection'), requestId, operationId, 'CONFLICT'));
  const current = await readArchiveSelection();
  if (sameArchiveSelection(current, selected))
    throw new ArchiveStorageError(archiveError(new Error('The original archive is still selected; reconcile its exact operation in that session'), requestId, operationId, 'CONFLICT'));
  await storage.close();
  const receipt = await readRetainedArchive(archiveId, requestId, 'getExtractionOperation', { operationId });
  if (receipt?.status === 'not_found') return 'not_committed';
  if (receipt?.status === 'committed' && receipt.requestDigest === requestDigest) return 'committed';
  throw new ArchiveStorageError(archiveError(new Error('Retained extraction receipt differs from the original request; preserve its recovery identity'), requestId, operationId, 'UNKNOWN_OUTCOME'));
}
