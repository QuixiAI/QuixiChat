import { loadStorageSqlite } from '../../src/worker/sqlite-module.ts';
import { CanonicalRepository } from '../../src/worker/canonical/repository.ts';
import { operationClaimIdentity } from '../../src/worker/operation-claims.ts';
import { isQuixiId } from '@quixi/core/model';

// Only explicitly created synthetic UUID namespaces may be changed. Production
// default is seeded solely through its public managed storage client.
self.onmessage = ({ data }) => void (async () => {
  const { archiveId, operationId, command } = data;
  try {
    if (!isQuixiId(archiveId) || !isQuixiId(operationId)) throw new Error('Invalid synthetic fixture identity');
    const result = await navigator.locks.request(`quixi:archive:${archiveId}:owner`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('Synthetic fixture has an owner');
      const sqlite = await loadStorageSqlite();
      const pool = await sqlite.installOpfsSAHPoolVfs({ name: 'retained-extraction-fixture', directory: `/quixi-${archiveId}/database`, initialCapacity: 2 });
      let db;
      try {
        db = new pool.OpfsSAHPoolDb('/archive.sqlite3', command.startsWith('legacy') ? 'c' : 'w');
        if (command === 'legacy8' || command === 'legacy9') new CanonicalRepository(db, { assertBlobAvailable() {} }).migrate(Number(command.slice(-1)));
        else if (command === 'delete-receipt') db.exec({ sql: 'DELETE FROM quixi_extract_operations WHERE id=?', bind: [operationId] });
        else if (command === 'drop-receipts') db.exec('DROP TABLE quixi_extract_operations');
        else if (command === 'bad-digest') db.exec({ sql: 'UPDATE quixi_extract_operations SET digest=? WHERE id=?', bind: ['f'.repeat(64), operationId] });
        else if (command === 'bad-result') db.exec({ sql: 'UPDATE quixi_extract_operations SET result=? WHERE id=?', bind: ['not json', operationId] });
        else if (command === 'large-result') db.exec({ sql: 'UPDATE quixi_extract_operations SET result=? WHERE id=?', bind: [JSON.stringify('x'.repeat(16384)), operationId] });
        else if (command === 'orphan-receipt') { db.exec('DROP TRIGGER quixi_local_claims_no_delete'); db.exec({ sql: 'DELETE FROM quixi_local_operation_claims WHERE operation_id=?', bind: [operationId] }); }
        else if (command === 'other-domain') {
          const requestDigest = db.selectValue('SELECT request_digest FROM quixi_local_operation_claims WHERE operation_id=?', [operationId]);
          db.exec('DROP TRIGGER quixi_local_claims_no_update');
          db.exec({ sql: 'UPDATE quixi_local_operation_claims SET domain=?,identity_digest=? WHERE operation_id=?', bind: ['other', operationClaimIdentity({ operationId, domain: 'other', requestDigest }), operationId] });
        } else if (command === 'pre10-receipt') db.exec('DELETE FROM quixi_schema_migrations WHERE version>=10');
        else throw new Error('Unknown private receipt fixture command');
        return { integrity: db.selectValue('PRAGMA integrity_check'), schema: db.selectValue('SELECT max(version) FROM quixi_schema_migrations') };
      } finally { db?.close(); pool.pauseVfs(); }
    });
    self.postMessage({ ok: true, result });
  } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
})();
