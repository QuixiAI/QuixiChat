import { canonicalJson } from '@quixi/core/contracts';
import type { BoundaryError } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ARCHIVE_PROTOCOL_VERSION, archiveError } from '../archive-protocol.ts';
import { CANONICAL_MIGRATIONS } from '../../migrations/index.ts';
import { loadStorageSqlite } from './sqlite-module.ts';
import type { StorageSqliteModule, StorageSqlitePool } from './sqlite-module.ts';
import { inspectPool } from './retained-archive.ts';
import { encodeTarEntry, tarEnd } from './archives/tar.ts';
import { ARCHIVE_EXCLUDED, ARCHIVE_FORMAT, ARCHIVE_FORMAT_VERSION, archiveMetadata } from './archives/format.ts';
import type { ArchiveChecksum } from './archives/format.ts';
import { RESCUE_KIND, RESCUE_LIMITS } from './archives/rescue-format.ts';
import type { RescueLedgerRow, RescueManifest } from './archives/rescue-format.ts';
import { restrictRestoreConnection } from './archives/schema-validation.ts';
import { sqlRows } from './archives/snapshot.ts';
import type { ArchiveDatabaseFile } from './archives/snapshot.ts';

/** Byte-level rescue export of an archive this build may be unable to open.
 * One request per worker. The worker holds the archive owner lock only if it
 * is free, copies the exact pool database bytes and blob files into the
 * standard TAR layout, reads the migration ledger read-only when it can, and
 * never migrates, repairs or writes the archive. Each TAR chunk is posted and
 * acknowledged before the next is read, so memory stays at one chunk. */
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<unknown>) => void; postMessage(value: unknown, transfer?: Transferable[]): void };
const POOL_HEADER = 4096;
const SQLITE_MAGIC = 'SQLite format 3\0';
function fail(code: BoundaryError['code'], message: string): never { throw Object.assign(new Error(message), { code }); }

interface Slot { handle: FileSystemFileHandle; size: number }
async function locateDatabaseSlot(directory: FileSystemDirectoryHandle): Promise<Slot> {
  const opaque = await directory.getDirectoryHandle('.opaque');
  let database: Slot | undefined;
  for await (const entry of (opaque as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
    if (entry.kind !== 'file') continue;
    const file = await (entry as FileSystemFileHandle).getFile();
    if (file.size < POOL_HEADER) continue;
    const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
    const end = header.indexOf(0);
    if (end <= 0) continue;
    const path = new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(0, end));
    if (/(?:-journal|-wal|-shm)$/.test(path)) fail('IO_ERROR', 'Archive has journal or transient state; recovery requires its compatible writable owner before a rescue export');
    if (path === '/archive.sqlite3') database = { handle: entry as FileSystemFileHandle, size: file.size };
  }
  if (!database) fail('NOT_FOUND', 'Archive database is missing; nothing to rescue and no empty database will be created');
  return database;
}

async function* fileChunks(file: File, offset: number, length: number): AsyncGenerator<Uint8Array> {
  const chunk = 65536;
  for (let at = 0; at < length; at += chunk) {
    const bytes = new Uint8Array(await file.slice(offset + at, offset + Math.min(length, at + chunk)).arrayBuffer());
    if (bytes.length !== Math.min(chunk, length - at)) fail('IO_ERROR', 'Archive file changed length during rescue export');
    yield bytes;
  }
}
async function* one(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

interface BlobFile { sha256: string; handle: FileSystemFileHandle }
async function listBlobs(quixi: FileSystemDirectoryHandle): Promise<{ blobs: BlobFile[]; unrecognized: number }> {
  let blobs: FileSystemDirectoryHandle;
  try { blobs = await quixi.getDirectoryHandle('blobs'); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return { blobs: [], unrecognized: 0 };
    throw error;
  }
  const found: BlobFile[] = [];
  let unrecognized = 0;
  for await (const [prefix, bucket] of blobs.entries()) {
    if (bucket.kind !== 'directory' || !/^[a-f0-9]{2}$/.test(prefix)) { unrecognized++; continue; }
    for await (const [name, entry] of (bucket as FileSystemDirectoryHandle).entries()) {
      if (entry.kind !== 'file' || !/^[a-f0-9]{64}$/.test(name) || !name.startsWith(prefix)) { unrecognized++; continue; }
      found.push({ sha256: name, handle: entry as FileSystemFileHandle });
      if (found.length > RESCUE_LIMITS.maxBlobFiles) fail('OVERLOADED', 'Archive exceeds the rescue export blob-file bound');
    }
  }
  found.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  return { blobs: found, unrecognized };
}

function readLedger(sqlite: StorageSqliteModule, pool: StorageSqlitePool): { ledger: RescueLedgerRow[] | null; error: string | null } {
  let db: ArchiveDatabaseFile | undefined;
  try {
    db = new pool.OpfsSAHPoolDb('/archive.sqlite3', 'r') as unknown as ArchiveDatabaseFile;
    restrictRestoreConnection(sqlite as never, db);
    if (db.selectValue("SELECT type FROM sqlite_schema WHERE name='quixi_schema_migrations'") !== 'table') return { ledger: null, error: 'Migration ledger table is absent' };
    const rows = sqlRows(db, `SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version LIMIT ${RESCUE_LIMITS.maxLedgerRows + 1}`);
    if (rows.length > RESCUE_LIMITS.maxLedgerRows) return { ledger: null, error: 'Migration ledger exceeds the recorded bound' };
    const ledger = rows.map(row => ({ version: Number(row.version), name: String(row.name).slice(0, 256), checksum: String(row.checksum).slice(0, 128) }));
    return { ledger, error: null };
  } catch (error) { return { ledger: null, error: String(error).slice(0, 512) }; }
  finally { try { db?.close(); } catch { /* read-only handle; nothing to preserve */ } }
}
function ledgerCompatible(ledger: RescueLedgerRow[] | null): boolean {
  if (!ledger || ledger.length === 0 || ledger.length > CANONICAL_MIGRATIONS.length) return false;
  return ledger.every((row, index) => {
    const migration = CANONICAL_MIGRATIONS[index]!;
    return row.version === migration.version && row.name === migration.name && row.checksum === bytesToHex(sha256(new TextEncoder().encode(canonicalJson(migration.sql))));
  });
}

let consumed = false;
scope.onmessage = ({ data }) => {
  const value = data as { version?: unknown; type?: unknown; archiveId?: unknown; requestId?: unknown } | null;
  const requestId = isQuixiId(value?.requestId) ? value.requestId : '';
  const archiveId = value?.archiveId === 'default' || isQuixiId(value?.archiveId) ? value.archiveId : '';
  const post = (payload: object, transfer?: Transferable[]) => scope.postMessage({ version: ARCHIVE_PROTOCOL_VERSION, archiveId, requestId, ...payload }, transfer);
  void (async () => {
    try {
      if (consumed) fail('OVERLOADED', 'Rescue worker accepts one export'); consumed = true;
      if (!value || value.version !== ARCHIVE_PROTOCOL_VERSION || value.type !== 'rescue-export' || Object.keys(value).sort().join(',') !== 'archiveId,requestId,type,version') fail('UNSUPPORTED', 'Unsupported rescue export envelope');
      if (!archiveId || !requestId) fail('INVALID_REQUEST', 'Unsupported rescue archive identity');
      await navigator.locks.request(`quixi:archive:${archiveId}:owner`, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) fail('CONFLICT', 'Archive currently has an owner; close its session before a rescue export');
        const root = await navigator.storage.getDirectory();
        const name = archiveId === 'default' ? 'quixi' : `quixi-${archiveId}`;
        let quixi: FileSystemDirectoryHandle, directory: FileSystemDirectoryHandle;
        try { quixi = await root.getDirectoryHandle(name); directory = await quixi.getDirectoryHandle('database'); }
        catch (error) {
          if (error instanceof DOMException && error.name === 'NotFoundError') fail('NOT_FOUND', 'Archive namespace or database is missing; no creation fallback is allowed');
          throw error;
        }
        const sqlite = await loadStorageSqlite();
        await inspectPool(directory, sqlite);
        const slot = await locateDatabaseSlot(directory);
        const databaseBytes = slot.size - POOL_HEADER;
        const { blobs, unrecognized } = await listBlobs(quixi);
        // Acknowledged chunk stream: read the next input only after the client
        // has consumed the previous output.
        let sequence = 0, totalBytes = 0;
        const total = sha256.create();
        let pending = new Uint8Array(0);
        const waitAck = (expected: number) => new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Object.assign(new Error('Rescue export consumer stalled'), { code: 'IO_ERROR' })), 600_000);
          scope.onmessage = ({ data: ack }) => {
            const message = ack as { type?: unknown; requestId?: unknown; sequence?: unknown } | null;
            if (!message || message.type !== 'rescue-ack' || message.requestId !== requestId || message.sequence !== expected) return;
            clearTimeout(timer); resolve();
          };
        });
        const flush = async (force: boolean) => {
          while (pending.length >= RESCUE_LIMITS.chunkBytes || (force && pending.length > 0)) {
            const bytes = pending.slice(0, Math.min(pending.length, RESCUE_LIMITS.chunkBytes));
            pending = pending.slice(bytes.length);
            total.update(bytes); totalBytes += bytes.length;
            const acknowledged = waitAck(sequence);
            post({ type: 'rescue-chunk', sequence, bytes: bytes.buffer }, [bytes.buffer]);
            sequence++;
            await acknowledged;
          }
        };
        const emit = async (bytes: Uint8Array) => {
          const merged = new Uint8Array(pending.length + bytes.length);
          merged.set(pending); merged.set(bytes, pending.length); pending = merged;
          await flush(false);
        };
        const checksums: ArchiveChecksum[] = [];
        let blobHashMismatches = 0;
        const entry = async (path: string, byteLength: number, source: AsyncIterable<Uint8Array>, inventory = true): Promise<string> => {
          const hash = sha256.create();
          let observed = 0;
          const counted = async function* () { for await (const bytes of source) { hash.update(bytes); observed += bytes.length; yield bytes; } };
          for await (const bytes of encodeTarEntry({ path, byteLength }, counted())) await emit(bytes);
          const digest = bytesToHex(hash.digest());
          if (inventory) checksums.push({ path, byteLength: observed, sha256: digest });
          return digest;
        };
        const declaration = archiveMetadata({ format: ARCHIVE_FORMAT, version: ARCHIVE_FORMAT_VERSION, kind: RESCUE_KIND });
        await entry('format.json', declaration.length, one(declaration));
        const file = await slot.handle.getFile();
        if (file.size !== slot.size) fail('IO_ERROR', 'Archive database changed size before the rescue copy');
        const headerBytes = new Uint8Array(await file.slice(POOL_HEADER, POOL_HEADER + 100).arrayBuffer());
        const view = new DataView(headerBytes.buffer);
        const header = headerBytes.length === 100 && new TextDecoder().decode(headerBytes.subarray(0, 16)) === SQLITE_MAGIC
          ? { pageSize: view.getUint16(16) === 1 ? 65536 : view.getUint16(16), pageCount: view.getUint32(28) } : null;
        const databaseSha256 = await entry('quixi.sqlite', databaseBytes, fileChunks(file, POOL_HEADER, databaseBytes));
        for (const blob of blobs) {
          const content = await blob.handle.getFile();
          const digest = await entry(`blobs/${blob.sha256}`, content.size, fileChunks(content, 0, content.size));
          if (digest !== blob.sha256) blobHashMismatches++;
        }
        // Read the ledger only after the exact bytes are copied; the pinned pool
        // initialization has already been validated by the preflight above.
        const pool = await sqlite.installOpfsSAHPoolVfs({ name: 'quixi-rescue-reader', directory: `/${name}/database`, initialCapacity: 1 });
        let ledgerResult: { ledger: RescueLedgerRow[] | null; error: string | null };
        try { ledgerResult = pool.getFileNames().includes('/archive.sqlite3') ? readLedger(sqlite, pool) : { ledger: null, error: 'Pool does not present the archive database' }; }
        finally { pool.pauseVfs(); }
        const inventoryLines = checksums.map(item => archiveMetadata(item));
        const inventoryBytes = new Uint8Array(inventoryLines.reduce((n, line) => n + line.length, 0));
        let at = 0; for (const line of inventoryLines) { inventoryBytes.set(line, at); at += line.length; }
        const inventorySha256 = await entry('checksums.jsonl', inventoryBytes.length, one(inventoryBytes), false);
        const manifest: RescueManifest = {
          format: ARCHIVE_FORMAT, version: ARCHIVE_FORMAT_VERSION, kind: RESCUE_KIND,
          recovery: {
            databaseBytes, databaseSha256, header, ledger: ledgerResult.ledger, ledgerError: ledgerResult.error,
            ledgerCompatible: ledgerCompatible(ledgerResult.ledger), buildMigrations: CANONICAL_MIGRATIONS.length,
            blobFiles: blobs.length, blobHashMismatches, unrecognizedFiles: unrecognized,
          },
          inventory: { path: 'checksums.jsonl', byteLength: inventoryBytes.length, sha256: inventorySha256, entries: checksums.length },
          excluded: ARCHIVE_EXCLUDED,
        };
        const manifestBytes = archiveMetadata(manifest);
        await entry('manifest.json', manifestBytes.length, one(manifestBytes), false);
        await emit(tarEnd());
        await flush(true);
        post({ type: 'rescue-done', byteLength: totalBytes, sha256: bytesToHex(total.digest()), entries: checksums.length + 2, manifest });
      });
    } catch (error) {
      post({ type: 'rescue-reply', ok: false, error: archiveError(error, requestId, null, 'IO_ERROR') });
    }
  })();
};
