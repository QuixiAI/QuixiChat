import { assertStorageRequest, jsonByteLength, STORAGE_BOUNDARIES } from '@quixi/core/contracts';
import type { StorageOperations, StorageRequest } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import { ARCHIVE_PROTOCOL_VERSION, ArchiveStorageError, archiveError } from '../archive-protocol.ts';

export const RETAINED_ARCHIVE_OPERATIONS = ['readEntity', 'readEntities', 'readMessageParts', 'readSyncOperations', 'operationStatus', 'getExtractionOperation', 'listLibrary', 'readThreadView', 'readConversationWindow', 'readMessageChildren'] as const;
export type RetainedArchiveOperation = typeof RETAINED_ARCHIVE_OPERATIONS[number];
export const RETAINED_ARCHIVE_LIMITS = Object.freeze({ maxWorkers: 4, maxRequestBytes: 262_144, maxAdmittedBytes: 1_048_576, maxResponseBytes: STORAGE_BOUNDARIES.maxResponseBytes, defaultTimeoutMs: 15_000, maxTimeoutMs: 60_000 });
let workers = 0, admittedBytes = 0;

/** One bounded logical read of the caller's literal existing archive. This does
 * not resolve active selection, migrate, recover, or open a writable session. */
export async function readRetainedArchive<K extends RetainedArchiveOperation>(
  archiveId: string, requestId: string, operation: K, args: StorageOperations[K]['args'], options: { timeoutMs?: number } = {},
): Promise<StorageOperations[K]['result']> {
  const failure = (message: string, code: Parameters<typeof archiveError>[3] = 'INVALID_REQUEST') => new ArchiveStorageError(archiveError(new Error(message), requestId, null, code));
  let bytes: number;
  const timeoutMs = options.timeoutMs ?? RETAINED_ARCHIVE_LIMITS.defaultTimeoutMs;
  const request = { version: 1, requestId, operation, args } as StorageRequest;
  const envelope = { version: ARCHIVE_PROTOCOL_VERSION, type: 'retained-read', archiveId, request };
  try {
    if (!(archiveId === 'default' || isQuixiId(archiveId)) || !RETAINED_ARCHIVE_OPERATIONS.includes(operation)) throw new Error('Unsupported retained archive identity or read operation');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RETAINED_ARCHIVE_LIMITS.maxTimeoutMs) throw new Error('Invalid retained read deadline');
    assertStorageRequest(request);
    bytes = jsonByteLength(envelope, RETAINED_ARCHIVE_LIMITS.maxRequestBytes);
  } catch (error) { throw failure(error instanceof Error ? error.message : String(error)); }
  if (workers >= RETAINED_ARCHIVE_LIMITS.maxWorkers || admittedBytes + bytes > RETAINED_ARCHIVE_LIMITS.maxAdmittedBytes)
    throw failure('Retained read admission is full; await existing reads before retrying', 'OVERLOADED');
  workers++; admittedBytes += bytes;
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('../worker/retained-archive.ts', import.meta.url), { type: 'module' });
    return await new Promise<StorageOperations[K]['result']>((resolve, reject) => {
      const timer = setTimeout(() => reject(failure('Retained read deadline exceeded; no mutation was dispatched', 'IO_ERROR')), timeoutMs);
      worker!.onerror = event => { clearTimeout(timer); reject(failure(event.message || 'Retained archive worker failed', 'IO_ERROR')); };
      worker!.onmessageerror = () => { clearTimeout(timer); reject(failure('Retained archive reply could not be decoded', 'IO_ERROR')); };
      worker!.onmessage = ({ data }) => {
        clearTimeout(timer);
        try {
          jsonByteLength(data, RETAINED_ARCHIVE_LIMITS.maxResponseBytes);
          if (!data || data.version !== ARCHIVE_PROTOCOL_VERSION || data.type !== 'retained-reply' || data.archiveId !== archiveId || data.requestId !== requestId || typeof data.ok !== 'boolean') throw failure('Retained archive reply identity is invalid', 'IO_ERROR');
          if (!data.ok) {
            if (!data.error || data.error.requestId !== requestId || typeof data.error.code !== 'string' || typeof data.error.message !== 'string') throw failure('Retained archive error envelope is invalid', 'IO_ERROR');
            reject(new ArchiveStorageError(data.error));
          } else resolve(data.result as StorageOperations[K]['result']);
        } catch (error) { reject(error); }
      };
      try { worker!.postMessage(envelope); } catch (error) { clearTimeout(timer); reject(error); }
    });
  } finally { worker?.terminate(); workers--; admittedBytes -= bytes; }
}
