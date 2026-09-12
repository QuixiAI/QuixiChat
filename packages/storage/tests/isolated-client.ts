import { ArchiveStorageClient } from '../src/client/archive.ts';

/** Private fixture route. No production namespace or runtime policy override. */
export function createIsolatedStorageClient(options: { archiveId: string; timeoutMs?: number }): ArchiveStorageClient {
  if (!/^test-[A-Za-z0-9_-]{1,59}$/.test(options.archiveId)) throw new Error('An isolated fixture requires an explicit test-* archive ID');
  return new ArchiveStorageClient({ selection: { archiveId: options.archiveId, selectionRevision: 0 }, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
    new Worker(new URL('./isolated-worker.ts', import.meta.url), { type: 'module' }));
}
