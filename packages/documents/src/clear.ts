import { assertExtractionArgs } from '@quixi/core/contracts';
import type { ExtractionOperations, StorageClient } from '@quixi/core/contracts';
import { acquireStoredPdfProducerLease } from './storage-source.ts';
import { PendingExtractionOperationError, writeExtractionMutation } from './persist-mutation.ts';

export type ClearPdfExtractionTarget = Omit<ExtractionOperations['clearDocumentExtraction']['args'], 'operationId'>;
export interface ClearPdfExtractionOptions {
  storage: StorageClient & { readonly archiveId: string };
  target: ClearPdfExtractionTarget;
  signal?: AbortSignal;
}

/** Clear only the reviewed derived run. Original attachment/canonical history
 * remain owned by storage. An active producer must finish or stop first. */
export async function clearStoredPdfExtraction(options: ClearPdfExtractionOptions): Promise<ExtractionOperations['clearDocumentExtraction']['result']> {
  const { storage, signal } = options;
  const archiveId = storage.archiveId;
  const target = Object.freeze({ ...options.target });
  assertExtractionArgs('clearDocumentExtraction', { ...target, operationId: crypto.randomUUID() });
  const lease = await acquireStoredPdfProducerLease(archiveId, target.documentId, signal);
  let failure: unknown;
  try {
    return await writeExtractionMutation(storage, 'clearDocumentExtraction', target, signal);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await lease.release(); }
    catch (error) {
      if (failure instanceof PendingExtractionOperationError) failure.cleanupFailures = [...failure.cleanupFailures, error];
      else if (!failure) throw new AggregateError([error], 'Saved text was cleared, but producer lease release is unconfirmed.');
    }
  }
}
