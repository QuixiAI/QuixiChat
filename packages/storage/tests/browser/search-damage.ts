// Test-only offline damage fixture. This worker is not a production entry point
// and exposes no arbitrary SQL. It takes the archive ownership lock before
// removing one known derived table, then closes all SQLite/OPFS handles.
import { ArchiveDatabase } from '../../src/worker/archive-database.ts';
import { validArchiveId } from '../../src/archive-protocol.ts';
import type { CanonicalSqlite } from '../../src/worker/canonical/index.ts';
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<string>) => void; postMessage(value: unknown): void };
scope.onmessage = ({ data: archiveId }) => {
  if (!validArchiveId(archiveId)) { scope.postMessage({ ok: false, error: 'Invalid test archive' }); return; }
  void navigator.locks.request(`quixi:archive:${archiveId}:owner`, async () => {
    const database = await ArchiveDatabase.open(archiveId);
    try {
      const db = (database as unknown as { db: CanonicalSqlite }).db;
      const records = Number(db.selectValue('SELECT count(*) FROM quixi_records'));
      const operations = Number(db.selectValue('SELECT count(*) FROM quixi_sync_ops'));
      db.exec('DROP TABLE quixi_search_queue');
      return { records, operations };
    } finally { await database.close(); }
  }).then(value => scope.postMessage({ ok: true, ...value }), error => scope.postMessage({ ok: false, error: String(error) }));
};
