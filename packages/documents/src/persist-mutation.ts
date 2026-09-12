import { canonicalJson } from '@quixi/core/contracts';
import type { ExtractionOperations, StorageClient } from '@quixi/core/contracts';
import type { JsonValue } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ExtractionError } from './contracts.ts';

export type ExtractionWriteOperation = { [K in keyof ExtractionOperations]: ExtractionOperations[K]['args'] extends { operationId: string } ? K : never }[keyof ExtractionOperations];
export interface PendingExtractionOperation {
  operation: ExtractionWriteOperation;
  args: ExtractionOperations[ExtractionWriteOperation]['args'];
  requestDigest: string;
}
/** Preserve the exact identity/payload when a reply and its reconciliation are
 * unavailable. A UI must retain this information rather than invent a new ID. */
export class PendingExtractionOperationError extends Error {
  readonly code = 'UNKNOWN_OUTCOME';
  cleanupFailures: readonly unknown[] = [];
  constructor(readonly pending: PendingExtractionOperation, cause: unknown) {
    super('Document storage outcome is unknown. Preserve this operation for recovery before retrying.', { cause });
    this.name = 'PendingExtractionOperationError';
  }
}

const id = () => crypto.randomUUID();
const code = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;
const cancelled = (signal?: AbortSignal) => { if (signal?.aborted) throw new ExtractionError('CANCELLED', 'Document extraction cancelled; published pages remain available.'); };

/** A not-found lookup does not prove an earlier dispatched mutation cannot still
 * commit. Keep its exact identity across every subsequent refusal or abort. */
export async function writeExtractionMutation<K extends ExtractionWriteOperation>(
  storage: Pick<StorageClient, 'request' | 'cancel'>,
  operation: K,
  input: Omit<ExtractionOperations[K]['args'], 'operationId'>,
  signal?: AbortSignal,
  control = false,
): Promise<ExtractionOperations[K]['result']> {
  const args = { ...input, operationId: id() } as ExtractionOperations[K]['args'];
  const requestDigest = bytesToHex(sha256(new TextEncoder().encode(canonicalJson({ operation, args } as JsonValue))));
  const pending: PendingExtractionOperation = { operation, args, requestDigest };
  const started = performance.now();
  let unknownRetries = 0;
  let uncertain = false;
  try {
    for (;;) {
      if (!control) cancelled(signal);
      const requestId = id();
      const abort = () => { void storage.cancel(requestId, args.operationId).catch(() => {}); };
      if (!control) signal?.addEventListener('abort', abort, { once: true });
      try { return await storage.request(requestId, operation, args); }
      catch (error) {
        if (code(error) === 'OVERLOADED' && performance.now() - started < 30_000) {
          // Reuse the same ID after admission refusal. A prior unknown dispatch
          // remains unresolved even though this particular attempt was refused.
          if (!control) cancelled(signal);
          await new Promise<void>(resolve => setTimeout(resolve, 25));
          if (!control) cancelled(signal);
          continue;
        }
        if (code(error) !== 'UNKNOWN_OUTCOME') throw error;
        uncertain = true;
        const receipt = await storage.request(id(), 'getExtractionOperation', { operationId: args.operationId });
        if (receipt.status === 'committed') {
          if (receipt.requestDigest !== requestDigest) throw new Error('Extraction receipt identity differs from the dispatched operation.');
          return receipt.result as ExtractionOperations[K]['result'];
        }
        if (++unknownRetries <= 1) continue;
        throw error;
      } finally { if (!control) signal?.removeEventListener('abort', abort); }
    }
  } catch (error) {
    // This encloses the loop boundary, backoff, dispatch and receipt read. The
    // workflow recognizes this class and must not issue a fresh interrupt.
    if (uncertain) throw new PendingExtractionOperationError(pending, error);
    throw error;
  }
}
