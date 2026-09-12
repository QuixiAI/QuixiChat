import { isQuixiId } from '@quixi/core/model';
import { ARCHIVE_PROTOCOL_VERSION, ArchiveStorageError, archiveError } from '../archive-protocol.ts';
import type { RescueManifest } from '../worker/archives/rescue-format.ts';
export type { RescueManifest, RescueLedgerRow } from '../worker/archives/rescue-format.ts';

export interface RescueExportSummary {
  byteLength: number;
  sha256: string;
  entries: number;
  manifest: RescueManifest;
}
export const RESCUE_EXPORT_LIMITS = Object.freeze({ maxConcurrent: 1, defaultTimeoutMs: 60_000, maxTimeoutMs: 600_000 });
let active = 0;

/** Stream a byte-level rescue archive of the caller's literal existing archive
 * through `sink`, one acknowledged chunk at a time. The worker holds the
 * archive owner lock only while it is free and never migrates, repairs or
 * writes. `timeoutMs` bounds each step of progress, not the whole export. */
export async function exportRescueArchive(
  archiveId: string,
  requestId: string,
  sink: (chunk: Uint8Array) => Promise<void>,
  options: { timeoutMs?: number } = {},
): Promise<RescueExportSummary> {
  const failure = (message: string, code: Parameters<typeof archiveError>[3] = 'INVALID_REQUEST') => new ArchiveStorageError(archiveError(new Error(message), requestId, null, code));
  const timeoutMs = options.timeoutMs ?? RESCUE_EXPORT_LIMITS.defaultTimeoutMs;
  if (!(archiveId === 'default' || isQuixiId(archiveId)) || !isQuixiId(requestId)) throw failure('Unsupported rescue archive identity');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RESCUE_EXPORT_LIMITS.maxTimeoutMs) throw failure('Invalid rescue export deadline');
  if (active >= RESCUE_EXPORT_LIMITS.maxConcurrent) throw failure('A rescue export is already running; wait for it to finish', 'OVERLOADED');
  active++;
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL('../worker/rescue-export.ts', import.meta.url), { type: 'module' });
    return await new Promise<RescueExportSummary>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let expected = 0, settled = false, consuming = Promise.resolve();
      const finish = (action: () => void) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); action(); };
      const arm = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish(() => reject(failure('Rescue export made no progress before its deadline', 'IO_ERROR'))), timeoutMs); };
      arm();
      worker!.onerror = event => finish(() => reject(failure(event.message || 'Rescue export worker failed', 'IO_ERROR')));
      worker!.onmessageerror = () => finish(() => reject(failure('Rescue export message could not be decoded', 'IO_ERROR')));
      worker!.onmessage = ({ data }) => {
        const message = data as { version?: unknown; type?: unknown; archiveId?: unknown; requestId?: unknown; sequence?: unknown; bytes?: unknown; ok?: unknown; error?: unknown; byteLength?: unknown; sha256?: unknown; entries?: unknown; manifest?: unknown } | null;
        if (settled || !message || message.version !== ARCHIVE_PROTOCOL_VERSION || message.archiveId !== archiveId || message.requestId !== requestId) return;
        arm();
        if (message.type === 'rescue-chunk') {
          if (message.sequence !== expected || !(message.bytes instanceof ArrayBuffer)) return finish(() => reject(failure('Rescue export chunk sequence is invalid', 'IO_ERROR')));
          const sequence = expected++;
          const bytes = new Uint8Array(message.bytes);
          consuming = consuming.then(() => sink(bytes)).then(
            () => { if (!settled) worker!.postMessage({ type: 'rescue-ack', requestId, sequence }); },
            error => finish(() => reject(error)),
          );
        } else if (message.type === 'rescue-done') {
          const { byteLength, sha256, entries, manifest } = message;
          if (typeof byteLength !== 'number' || typeof sha256 !== 'string' || typeof entries !== 'number' || !manifest) return finish(() => reject(failure('Rescue export summary is invalid', 'IO_ERROR')));
          void consuming.then(() => finish(() => resolve({ byteLength, sha256, entries, manifest: manifest as RescueManifest })));
        } else if (message.type === 'rescue-reply' && message.ok === false) {
          const error = message.error as { code?: unknown; message?: unknown; requestId?: unknown } | undefined;
          if (!error || error.requestId !== requestId || typeof error.code !== 'string' || typeof error.message !== 'string') return finish(() => reject(failure('Rescue export error envelope is invalid', 'IO_ERROR')));
          finish(() => reject(new ArchiveStorageError(error as ConstructorParameters<typeof ArchiveStorageError>[0])));
        }
      };
      try { worker!.postMessage({ version: ARCHIVE_PROTOCOL_VERSION, type: 'rescue-export', archiveId, requestId }); }
      catch (error) { finish(() => reject(error)); }
    });
  } finally { worker?.terminate(); active--; }
}
