import { archiveError, ARCHIVE_PROTOCOL_VERSION, hasArchiveProtocolVersion } from '../archive-protocol.ts';
import { isQuixiId } from '@quixi/core/model';
import { ManagedSelectionCatalog } from '../selection/managed-catalog.ts';
import { loadStorageSqlite } from './sqlite-module.ts';
import { ArchiveDatabase } from './archive-database.ts';

const scope = globalThis as unknown as { onmessage(event: MessageEvent): void; postMessage(value: unknown): void };
let pending = 0;
let catalog: Promise<ManagedSelectionCatalog> | undefined;
async function initializeDefault(): Promise<void> {
  // Never wait for an archive owner while holding the selection gate.
  await navigator.locks.request('quixi:archive:default:owner', { ifAvailable: true }, async lock => {
    if (!lock) throw Object.assign(new Error('Close other Quixi tabs before initializing archive selection, then reopen Quixi.'), { code: 'CONFLICT' });
    // A namespace directory left by an interrupted earlier first run holds no
    // database or blobs; it is created, while any namespace with data is
    // opened as is or refused.
    const archive = await ArchiveDatabase.open('default', undefined, { create: 'if-empty', requireUnclaimedSelectionBootstrap: true });
    try { archive.claimSelectionBootstrap(); }
    finally { await archive.close(); }
  });
}
scope.onmessage = ({ data }) => {
  const id = isQuixiId(data?.id) ? data.id : crypto.randomUUID();
  const respond = (value: object) => scope.postMessage({ version: ARCHIVE_PROTOCOL_VERSION, type: "reply", id, ...value });
  if (!hasArchiveProtocolVersion(data as unknown) || !isQuixiId(data?.id) || !['read', 'status'].includes(data.type)) {
    respond({ ok: false, error: archiveError(new Error('Invalid selection request'), id, null, 'INVALID_REQUEST') }); return;
  }
  if (pending >= 16) { respond({ ok: false, error: archiveError(new Error('Selection request queue is full'), id, null, 'OVERLOADED') }); return; }
  pending++;
  void (async () => {
    catalog ??= loadStorageSqlite().then(sqlite => new ManagedSelectionCatalog(sqlite, { initializeDefault }));
    const instance = await catalog;
    return data.type === 'read' ? instance.read() : instance.status(data.operationId, data.fullArgs);
  })().then(result => respond({ ok: true, result }), error => respond({ ok: false, error: archiveError(error, id) })).finally(() => pending--);
};
