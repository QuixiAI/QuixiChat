import { ManagedSelectionCatalog, ManagedSelectionError } from '../../../src/selection/managed-catalog.ts';
import type { ManagedActivationArgs, ManagedActivationReceipt } from '../../../src/selection/managed-catalog.ts';
import { loadStorageSqlite } from '../../../src/worker/sqlite-module.ts';
import type { StorageSqliteModule, StorageSqlitePool } from '../../../src/worker/sqlite-module.ts';
import { CanonicalRepository } from '../../../src/worker/canonical/repository.ts';
import type { ArchiveDatabaseFile } from '../../../src/worker/archives/snapshot.ts';

let catalog: ManagedSelectionCatalog, namespace: `test-${string}`;
let fault = 'none', abort: AbortController | undefined, expired: (() => ManagedActivationReceipt) | undefined;
let release: (() => void) | undefined, initializations = 0;
let observedCatalogPool: StorageSqlitePool | undefined;
const event = (name: string) => postMessage({ event: name });
const archivePools = new Map<string, StorageSqlitePool>();
async function archive<T>(id: string, effect: (db: ArchiveDatabaseFile) => T): Promise<T> {
  const sqlite = await loadStorageSqlite();
  let pool = archivePools.get(id);
  if (!pool) { pool = await sqlite.installOpfsSAHPoolVfs({ name: `managed-fixture-${crypto.randomUUID()}`, directory: `/${id === 'default' ? 'quixi' : `quixi-${id}`}/database`, initialCapacity: 10 }); archivePools.set(id, pool); }
  await pool.unpauseVfs();
  const db = new pool.OpfsSAHPoolDb('/archive.sqlite3');
  try { return effect(db); } finally { try { db.close(); } finally { pool.pauseVfs(); } }
}
async function initialize(id: string): Promise<void> {
  await navigator.locks.request(`quixi:archive:${id}:owner`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new ManagedSelectionError('CONFLICT', 'Default owner is busy; retry initialization.');
    await archive(id, db => {
      new CanonicalRepository(db, { assertBlobAvailable() { throw new Error('Empty fixture has no blobs'); } }).migrate();
      db.exec('CREATE TABLE IF NOT EXISTS fixture_writes(sequence INTEGER PRIMARY KEY,text TEXT NOT NULL) STRICT');
    });
  });
}
/** Faults wrap the actual injected OO API; production catalog has no test hooks. */
function wrapped(sqlite: StorageSqliteModule): StorageSqliteModule {
  return new Proxy(sqlite, { get(target, key) {
    if (key !== 'installOpfsSAHPoolVfs') return Reflect.get(target, key);
    return async (options: Parameters<StorageSqliteModule['installOpfsSAHPoolVfs']>[0]) => {
      const pool = await target.installOpfsSAHPoolVfs(options);
      observedCatalogPool = pool;
      return new Proxy(pool, { get(poolTarget, poolKey) {
        if (poolKey === 'pauseVfs') return () => { poolTarget.pauseVfs(); if (fault === 'close-after-commit') { fault = 'none'; throw new Error('Injected close confirmation failure'); } };
        if (poolKey !== 'OpfsSAHPoolDb') { const value = Reflect.get(poolTarget, poolKey); return typeof value === 'function' ? value.bind(poolTarget) : value; }
        return class {
          constructor(name: string, flags?: string) {
            const db = new pool.OpfsSAHPoolDb(name, flags); let headWrite = false, unreadable = false;
            return new Proxy(db, { get(dbTarget, dbKey) {
              if (dbKey === 'exec') return (options: Parameters<ArchiveDatabaseFile['exec']>[0]) => {
                const sql = typeof options === 'string' ? options : options.sql;
                if (unreadable && sql !== 'ROLLBACK') throw new Error('Injected unusable connection after uncertain commit');
                if (sql === 'BEGIN IMMEDIATE') headWrite = false;
                if (sql.startsWith('UPDATE selection SET')) {
                  headWrite = true;
                  if (fault === 'full' || fault === 'quota') {
                    const mode = fault; fault = 'none';
                    if (mode === 'full') dbTarget.exec(`PRAGMA max_page_count=${Number(dbTarget.selectValue('PRAGMA page_count'))}`);
                    dbTarget.exec(`CREATE TABLE pressure(bytes BLOB); INSERT INTO pressure VALUES(zeroblob(${mode === 'quota' ? 8_388_608 : 1_048_576}));`);
                  }
                }
                if (sql === 'COMMIT' && headWrite && fault === 'terminate-in-transaction') {
                  event('transaction-open'); for (;;) { /* actual worker termination */ }
                }
                const result = dbTarget.exec(options);
                if (sql === 'COMMIT' && headWrite && ['lost-commit', 'unknown-commit'].includes(fault)) {
                  unreadable = fault === 'unknown-commit'; fault = 'none'; abort?.abort();
                  throw new Error('Injected lost commit confirmation');
                }
                return result;
              };
              if (dbKey === 'selectValue') return (...args: Parameters<ArchiveDatabaseFile['selectValue']>) => { if (unreadable) throw new Error('Injected unreadable connection'); return dbTarget.selectValue(...args); };
              const value = Reflect.get(dbTarget, dbKey); return typeof value === 'function' ? value.bind(dbTarget) : value;
            } });
          }
        };
      } });
    };
  } });
}
async function damage(directory: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const entry of (directory as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
    if (entry.kind === 'directory') { if (await damage(entry as FileSystemDirectoryHandle)) return true; }
    else {
      const access = await (entry as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ getSize(): number; read(bytes: Uint8Array, options: { at: number }): number; write(bytes: Uint8Array, options: { at: number }): number; flush(): void; close(): void }> }).createSyncAccessHandle();
      try {
        const bytes = new Uint8Array(Math.min(8192, access.getSize())); access.read(bytes, { at: 0 });
        const prefix = new TextEncoder().encode('SQLite format 3');
        for (let i = 0; i + prefix.length < bytes.length; i++) if (prefix.every((byte, n) => byte === bytes[i + n])) {
          access.write(new Uint8Array(16).fill(90), { at: i }); access.flush(); return true;
        }
      } finally { access.close(); }
    }
  }
  return false;
}
async function execute(command: string, args: Record<string, any>): Promise<unknown> {
  switch (command) {
    case 'open': {
      namespace = args.namespace;
      const sqlite = await loadStorageSqlite();
      if (sqlite !== await loadStorageSqlite()) throw new Error('Module loader initialized twice');
      catalog = new ManagedSelectionCatalog(wrapped(sqlite), { testDirectory: namespace, ...(args.noInitializer ? {} : { initializeDefault: async () => { initializations++; if (args.failInitialize) throw new Error('Injected initializer failure'); await initialize('default'); } }) });
      return catalog.read();
    }
    case 'read': return catalog.read();
    case 'status': return catalog.status(args.operationId, args.payload);
    case 'candidate': await initialize(args.archiveId); return null;
    case 'initializations': return initializations;
    case 'exists': { try { await (await navigator.storage.getDirectory()).getDirectoryHandle(args.namespace); return true; } catch (error) { if ((error as DOMException).name === 'NotFoundError') return false; throw error; } }
    case 'guard': return catalog.guard(args.expected, () => archive(args.expected.archiveId, db => { db.exec({ sql: 'INSERT INTO fixture_writes(text) VALUES(?)', bind: [args.text ?? 'checkpoint'] }); return Number(db.selectValue('SELECT count(*) FROM fixture_writes')); }));
    case 'fixtureCount': return archive(args.archiveId, db => Number(db.selectValue('SELECT count(*) FROM fixture_writes')));
    case 'holdDefault': return navigator.locks.request('quixi:archive:default:owner', async () => { event('default-held'); await new Promise<void>(resolve => { release = resolve; }); return null; });
    case 'admission': {
      const expected = await catalog.read(); let entered!: () => void, finish!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { finish = resolve; });
      const first = catalog.guard(expected, async () => { entered(); await held; }); await ready;
      const readers = Array.from({ length: 15 }, () => catalog.read());
      let rejected = false; try { await catalog.read(); } catch (error) { rejected = (error as ManagedSelectionError).code === 'OVERLOADED'; }
      finish(); await first; await Promise.all(readers); return rejected;
    }
    case 'activate': {
      fault = args.fault ?? 'none'; abort = new AbortController();
      return catalog.activateReviewed(args.activation as ManagedActivationArgs, { signal: abort.signal, withReviewedCandidate: commit => navigator.locks.request(`quixi:archive:${args.activation.review.candidate.archiveId}:owner`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw new ManagedSelectionError('CONFLICT', 'Candidate is already owned');
        expired = commit;
        if (args.mode === 'hold-before') { event('intent-prepared'); await new Promise<void>(resolve => { release = resolve; }); }
        if (args.mode === 'cancel-throw') { abort!.abort(); throw new Error('Unrelated validation error after cancellation'); }
        if (args.mode === 'throw') throw new Error('Validation failed');
        if (args.mode === 'return') return;
        if (args.mode === 'cancel-before') abort!.abort();
        const receipt = commit();
        if (args.mode === 'double') { let failed = false; try { commit(); } catch (error) { failed = (error as ManagedSelectionError).code === 'CONFLICT'; } if (!failed) throw new Error('Second commit callback succeeded'); }
        if (args.mode === 'hold-after') { event('selection-committed'); await new Promise<void>(resolve => { release = resolve; }); }
        if (args.mode === 'throw-after') throw new Error('Validation cleanup failed after publication');
        if (args.mode === 'cancel-after') abort!.abort();
        return receipt;
      }) });
    }
    case 'expired': try { expired?.(); return false; } catch (error) { return (error as ManagedSelectionError).code === 'CONFLICT'; }
    case 'deleteCatalogDirectory': return navigator.locks.request(catalog.gate, async () => { const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace); await dir.removeEntry('catalog', { recursive: true }); return null; });
    case 'deleteCatalogFile': return navigator.locks.request(catalog.gate, async () => { await observedCatalogPool!.unpauseVfs(); try { return observedCatalogPool!.unlink('/selection.sqlite3'); } finally { observedCatalogPool!.pauseVfs(); } });
    case 'deleteArchive': return navigator.locks.request(catalog.gate, async () => { await (await navigator.storage.getDirectory()).removeEntry(`quixi-${args.archiveId}`, { recursive: true }); return null; });
    case 'damage': return navigator.locks.request(catalog.gate, async () => damage(await (await navigator.storage.getDirectory()).getDirectoryHandle(namespace)));
    default: throw new Error('Unknown managed proof command');
  }
}
onmessage = ({ data }) => {
  if (data.command === 'release') { release?.(); release = undefined; postMessage({ id: data.id, ok: true, result: null }); return; }
  void execute(data.command, data.args).then(result => postMessage({ id: data.id, ok: true, result }), error => postMessage({ id: data.id, ok: false, error: { code: (error as ManagedSelectionError).code ?? 'PROOF_ERROR', message: String(error) } }));
};
