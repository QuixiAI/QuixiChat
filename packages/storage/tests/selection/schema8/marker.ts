// Test-only future-version marker. This is NOT a production migration or activation.
import { loadSelectionSqlite } from '../../../src/selection/catalog.ts';
import type { SqlDb } from '../../../src/selection/catalog.ts';
let release: (() => void) | undefined;
interface Pool { OpfsSAHPoolDb: new (name: string) => SqlDb; getFileNames(): string[]; pauseVfs(): void; unpauseVfs(): Promise<unknown> }
const pools = new Map<string, Pool>();
const rows = (db: SqlDb, sql: string) => db.exec({ sql, rowMode: 'object', returnValue: 'resultRows' });
function snapshot(db: SqlDb) {
  // Synthetic fixture is deliberately bounded to at most four threads.
  if (Number(db.selectValue('SELECT count(*) FROM quixi_records')) > 12) throw new Error('Fixture exceeded bounded snapshot size');
  return {
    version: Number(db.selectValue('SELECT max(version) FROM quixi_schema_migrations')),
    integrity: String(db.selectValue('PRAGMA integrity_check')),
    records: rows(db, 'SELECT * FROM quixi_records ORDER BY collection,id'),
    operations: rows(db, 'SELECT * FROM quixi_sync_ops ORDER BY sequence'),
    transactions: rows(db, 'SELECT * FROM quixi_transactions ORDER BY transaction_id'),
  };
}
async function database<T>(archiveId: string, work: (db: SqlDb) => Promise<T> | T): Promise<T> {
  if (!/^schema8-proof-[a-z0-9-]+$/.test(archiveId)) throw new Error('Only disposable proof namespaces are allowed');
  const root = await navigator.storage.getDirectory();
  await root.getDirectoryHandle(`quixi-${archiveId}`); // Never create a missing archive.
  let pool = pools.get(archiveId);
  if (!pool) {
    pool = await (await loadSelectionSqlite()).installOpfsSAHPoolVfs({ name: `schema-marker-${crypto.randomUUID()}`, directory: `/quixi-${archiveId}/database`, initialCapacity: 10 }) as Pool;
    pools.set(archiveId, pool);
  } else await pool.unpauseVfs();
  let db: SqlDb | undefined;
  try {
    if (!pool.getFileNames().includes('/archive.sqlite3')) throw new Error('Existing production archive file is missing');
    db = new pool.OpfsSAHPoolDb('/archive.sqlite3');
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
    return await work(db);
  } finally { try { db?.close(); } finally { pool.pauseVfs(); } }
}
async function execute(command: string, args: { archiveId: string; mode?: string }) {
  const lockName = `quixi:archive:${args.archiveId}:owner`;
  if (command === 'probe') return navigator.locks.request(lockName, { mode: 'exclusive', ifAvailable: true }, lock => ({ acquired: !!lock }));
  return navigator.locks.request(lockName, { mode: 'exclusive' }, () => database(args.archiveId, async db => {
    const before = snapshot(db);
    if (command === 'inspect') return before;
    if (command !== 'upgrade' || before.version !== 8) throw new Error('Expected the frozen worker schema 8');
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO quixi_schema_migrations(version,name,checksum) VALUES(9,'TEST ONLY future writer barrier','not-a-production-migration')");
    if (args.mode === 'interrupt') {
      postMessage({ event: 'marker-transaction-open', before });
      for (;;) { /* Terminate this real Worker to exercise rollback-journal recovery. */ }
    }
    db.exec(args.mode === 'rollback' ? 'ROLLBACK' : 'COMMIT');
    const after = snapshot(db);
    if (args.mode === 'hold') {
      const held = new Promise<void>(resolve => { release = resolve; });
      postMessage({ event: 'marker-committed-held', before, after });
      await held; release = undefined;
    }
    return { before, after };
  }));
}
onmessage = ({ data }) => {
  if (data.command === 'release') { release?.(); postMessage({ id: data.id, ok: true, result: null }); return; }
  void execute(data.command, data.args).then(result => postMessage({ id: data.id, ok: true, result }), error => postMessage({ id: data.id, ok: false, error: { message: String(error), code: 'PROOF_ERROR' } }));
};
