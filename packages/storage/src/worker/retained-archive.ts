import { assertStorageRequest, canonicalJson, jsonByteLength, STORAGE_BOUNDARIES } from '@quixi/core/contracts';
import type { StorageRequest, StorageOperations, BoundaryError } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ARCHIVE_PROTOCOL_VERSION, archiveError } from '../archive-protocol.ts';
import { CANONICAL_MIGRATIONS } from '../../migrations/index.ts';
import { CanonicalRepository } from './canonical/repository.ts';
import { ViewRepository } from './views.ts';
import { readOperationClaim } from './operation-claims.ts';
import { loadStorageSqlite } from './sqlite-module.ts';
import type { StorageSqliteModule, StorageSqlitePool } from './sqlite-module.ts';
import type { ArchiveDatabaseFile } from './archives/snapshot.ts';
import { sqlRows } from './archives/snapshot.ts';
import { restrictRestoreConnection } from './archives/schema-validation.ts';
import type { RetainedArchiveOperation } from '../client/retained-archive.ts';

type Request = Extract<StorageRequest, { operation: RetainedArchiveOperation }>;
const scope = globalThis as unknown as { onmessage: (event: MessageEvent<unknown>) => void; postMessage(value: unknown): void };
function fail(code: BoundaryError['code'], message: string): never { throw Object.assign(new Error(message), { code }); }
const allowed = (operation: unknown): operation is RetainedArchiveOperation => typeof operation === 'string' && ['readEntity', 'readEntities', 'readMessageParts', 'readSyncOperations', 'operationStatus', 'getExtractionOperation', 'listLibrary', 'readThreadView', 'readConversationWindow', 'readMessageChildren'].includes(operation);
const maxSlots = 128;

/** Pinned SAH-pool metadata preflight. VFS initialization may repair malformed
 * slots or truncate unused data, so inspect without installing that VFS first.
 * Header layout/digest is from our pinned sqlite3.mjs, not archive-provided SQL. */
export async function inspectPool(directory: FileSystemDirectoryHandle, sqlite: StorageSqliteModule): Promise<void> {
  const opaque = await directory.getDirectoryHandle('.opaque');
  const capi = sqlite.capi as typeof sqlite.capi & { SQLITE_OPEN_MEMORY: number; SQLITE_OPEN_MAIN_DB: number; SQLITE_OPEN_DELETEONCLOSE: number };
  let slots = 0, archive = false;
  const paths = new Set<string>();
  for await (const entry of (opaque as FileSystemDirectoryHandle & { values(): AsyncIterableIterator<FileSystemHandle> }).values()) {
    if (++slots > maxSlots) fail('OVERLOADED', 'Retained archive pool exceeds the bounded reader slot limit');
    if (entry.kind !== 'file') fail('IO_ERROR', 'Retained pool has unsupported metadata; preserve it for recovery');
    const file = await (entry as FileSystemFileHandle).getFile();
    if (file.size < 4096) fail('IO_ERROR', 'Retained pool has a truncated metadata slot');
    const header = new Uint8Array(await file.slice(0, 524).arrayBuffer()), view = new DataView(header.buffer);
    const flags = view.getUint32(512), end = header.subarray(0, 512).indexOf(0);
    if (end < 0) fail('IO_ERROR', 'Retained pool path is malformed');
    let h1 = 0, h2 = 0;
    if (flags & capi.SQLITE_OPEN_MEMORY) {
      h1 = 0xdeadbeef; h2 = 0x41c6ce57;
      for (const byte of header.subarray(0, 516)) { h1 = Math.imul(h1 ^ byte, 2654435761); h2 = Math.imul(h2 ^ byte, 104729); }
    }
    if (view.getUint32(516, true) !== (h1 >>> 0) || view.getUint32(520, true) !== (h2 >>> 0)) fail('IO_ERROR', 'Retained pool metadata digest differs; automatic repair is forbidden');
    if (end === 0) {
      if (file.size !== 4096 || flags !== 0) fail('IO_ERROR', 'Retained pool has an unreconciled empty slot');
      continue;
    }
    const path = new TextDecoder('utf-8', { fatal: true }).decode(header.subarray(0, end));
    if (!(flags & capi.SQLITE_OPEN_MAIN_DB) || flags & capi.SQLITE_OPEN_DELETEONCLOSE || /(?:-journal|-wal|-shm)$/.test(path)) fail('IO_ERROR', 'Retained archive has journal or transient state; recovery requires its compatible writable owner');
    if (paths.has(path)) fail('IO_ERROR', 'Retained pool has duplicate database paths');
    paths.add(path);
    if (path === '/archive.sqlite3') archive = true;
  }
  if (!slots || !archive) fail('NOT_FOUND', 'Retained archive database is absent; no empty database will be created');
}

function ledger(db: ArchiveDatabaseFile): void {
  if (db.selectValue("SELECT type FROM sqlite_schema WHERE name='quixi_schema_migrations'") !== 'table') fail('MIGRATION_FAILED', 'Retained archive migration ledger is missing');
  const rows = sqlRows(db, `SELECT version,name,checksum FROM quixi_schema_migrations ORDER BY version LIMIT ${CANONICAL_MIGRATIONS.length + 1}`);
  if (rows.length < 8 || rows.length > CANONICAL_MIGRATIONS.length) fail('MIGRATION_FAILED', 'Retained archive schema is incompatible with this read-only build');
  for (let i = 0; i < rows.length; i++) {
    const migration = CANONICAL_MIGRATIONS[i]!, row = rows[i]!;
    const checksum = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(migration.sql))));
    if (row.version !== migration.version || row.name !== migration.name || row.checksum !== checksum) fail('MIGRATION_FAILED', 'Retained archive migration ledger differs; no migration or reset was attempted');
  }
}

function extractionReceipt(db: ArchiveDatabaseFile, operationId: string): StorageOperations['getExtractionOperation']['result'] {
  const schema = Number(db.selectValue('SELECT max(version) FROM quixi_schema_migrations'));
  const hasReceipts = db.selectValue("SELECT type FROM sqlite_schema WHERE name='quixi_extract_operations'") === 'table';
  // Read only bounded metadata before materializing any untrusted JSON result.
  const receipt = hasReceipts ? sqlRows(db, 'SELECT digest,length(CAST(result AS BLOB)) AS result_bytes FROM quixi_extract_operations WHERE id=?', [operationId])[0] : undefined;
  const claim = schema >= 10 ? readOperationClaim(db, operationId) : null;
  if (!claim) {
    if (receipt) fail('UNKNOWN_OUTCOME', 'Extraction receipt has no stable matching operation claim; preserve the original operation for recovery');
    const canonical = new CanonicalRepository(db, { assertBlobAvailable: () => fail('UNSUPPORTED', 'Retained receipts cannot verify blobs') });
    if (canonical.operationStatus(operationId).status === 'committed' || db.selectValue('SELECT EXISTS(SELECT 1 FROM quixi_import_record_identities WHERE operation_id=?)', [operationId]) ||
        (db.selectValue("SELECT type FROM sqlite_schema WHERE name='quixi_archive_operations'") === 'table' && db.selectValue('SELECT EXISTS(SELECT 1 FROM quixi_archive_operations WHERE id=?)', [operationId])))
      fail('CONFLICT', 'Operation identity belongs to a different retained journal');
    return { status: 'not_found' };
  }
  if (claim.domain !== 'extraction') fail('CONFLICT', 'Retained operation identity belongs to a different local domain');
  if (!receipt || receipt.digest !== claim.requestDigest || !Number.isSafeInteger(receipt.result_bytes) || Number(receipt.result_bytes) < 1 || Number(receipt.result_bytes) > 16384)
    fail('UNKNOWN_OUTCOME', 'Stable extraction claim has no matching bounded receipt; preserve the original operation for recovery');
  try {
    const result = JSON.parse(String(db.selectValue('SELECT result FROM quixi_extract_operations WHERE id=?', [operationId])));
    jsonByteLength(result, 16384);
    return { status: 'committed', requestDigest: claim.requestDigest, result };
  } catch { return fail('UNKNOWN_OUTCOME', 'Retained extraction receipt is invalid; preserve its stable claim for recovery'); }
}

function read(db: ArchiveDatabaseFile, request: Request): unknown {
  const canonical = new CanonicalRepository(db, { assertBlobAvailable: () => fail('UNSUPPORTED', 'Retained reads cannot verify or publish blobs') });
  const views = new ViewRepository(db, canonical);
  switch (request.operation) {
    case 'readEntity': return canonical.get(request.args.collection, request.args.id);
    case 'readEntities': return canonical.readEntities(request.args);
    case 'readMessageParts': return canonical.readMessageParts(request.args);
    case 'readSyncOperations': return canonical.readSyncOperations(request.args);
    case 'getExtractionOperation': return extractionReceipt(db, request.args.operationId);
    case 'operationStatus': {
      const status = canonical.operationStatus(request.args.operationId);
      if (status.status === 'committed') return status;
      if (db.selectValue("SELECT type FROM sqlite_schema WHERE name='quixi_archive_operations'") === 'table') {
        const row = sqlRows(db, 'SELECT result FROM quixi_archive_operations WHERE id=?', [request.args.operationId])[0];
        if (row) return { status: 'committed', result: JSON.parse(String(row.result)) } satisfies StorageOperations['operationStatus']['result'];
      }
      const schema = Number(db.selectValue('SELECT max(version) FROM quixi_schema_migrations'));
      if (schema < 10) return status;
      const claim = readOperationClaim(db, request.args.operationId);
      if (!claim) return status;
      if (claim.domain === 'extraction') {
        const receipt = extractionReceipt(db, request.args.operationId);
        if (receipt.status === 'committed') return { status: 'committed', result: receipt.result };
      }
      fail('UNKNOWN_OUTCOME', 'The retained archive has a durable operation claim but its original receipt is unavailable. Preserve this operation ID for recovery.');
    }
    case 'listLibrary': return views.library(request.args);
    case 'readThreadView': return views.thread(request.args);
    case 'readConversationWindow': return views.window(request.args);
    case 'readMessageChildren': return views.children(request.args);
  }
}

async function execute(archiveId: string, request: Request): Promise<unknown> {
  return navigator.locks.request(`quixi:archive:${archiveId}:owner`, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) fail('CONFLICT', 'Retained archive currently has an owner; close its session before reading');
    let pool: StorageSqlitePool | undefined, db: ArchiveDatabaseFile | undefined;
    try {
      const root = await navigator.storage.getDirectory();
      const name = archiveId === 'default' ? 'quixi' : `quixi-${archiveId}`;
      const directory = await (await root.getDirectoryHandle(name)).getDirectoryHandle('database');
      const sqlite = await loadStorageSqlite();
      await inspectPool(directory, sqlite);
      pool = await sqlite.installOpfsSAHPoolVfs({ name: 'quixi-retained-reader', directory: `/${name}/database`, initialCapacity: 1 });
      const files = pool.getFileNames();
      if (!files.includes('/archive.sqlite3')) fail('NOT_FOUND', 'Retained database is missing');
      if (files.some(file => /(?:-journal|-wal|-shm)$/.test(file))) fail('IO_ERROR', 'Retained archive requires recovery before reading');
      db = new pool.OpfsSAHPoolDb('/archive.sqlite3', 'r');
      restrictRestoreConnection(sqlite, db);
      const capi = sqlite.capi as typeof sqlite.capi & { sqlite3_db_readonly(db: number, name: string): number };
      if (capi.sqlite3_db_readonly(db.pointer, 'main') !== 1 || db.selectValue('PRAGMA query_only') !== 1) fail('UNSUPPORTED', 'Pinned SQLite did not establish a read-only connection');
      ledger(db);
      const result = read(db, request);
      jsonByteLength(result, STORAGE_BOUNDARIES.maxResponseBytes - 1024);
      return result;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') fail('NOT_FOUND', 'Retained namespace or database is missing; no creation fallback is allowed');
      throw error;
    } finally { try { db?.close(); } finally { pool?.pauseVfs(); } }
  });
}

let consumed = false;
scope.onmessage = ({ data }) => {
  const value = data as { version?: unknown; type?: unknown; archiveId?: unknown; request?: StorageRequest } | null;
  // Invalid raw messages cannot make an unbounded error by echoing their IDs.
  const requestId = isQuixiId(value?.request?.requestId) ? value.request.requestId : '';
  const archiveId = value?.archiveId === 'default' || isQuixiId(value?.archiveId) ? value.archiveId : '';
  const reply = (payload: object) => {
    const envelope = { version: ARCHIVE_PROTOCOL_VERSION, type: 'retained-reply', archiveId, requestId, ...payload };
    jsonByteLength(envelope, STORAGE_BOUNDARIES.maxResponseBytes);
    scope.postMessage(envelope);
  };
  void (async () => {
    let validated = false;
    try {
      if (consumed) fail('OVERLOADED', 'Retained worker accepts one bounded call'); consumed = true;
      jsonByteLength(data, 262_144);
      if (!value || value.version !== ARCHIVE_PROTOCOL_VERSION || value.type !== 'retained-read' || Object.keys(value).sort().join(',') !== 'archiveId,request,type,version') fail('UNSUPPORTED', 'Unsupported retained read envelope');
      if (!(archiveId === 'default' || isQuixiId(archiveId)) || !value.request || !allowed(value.request.operation)) fail('INVALID_REQUEST', 'Unsupported retained archive or operation');
      assertStorageRequest(value.request);
      validated = true;
      if (!isSecureContext || !navigator.locks || !navigator.storage?.getDirectory) fail('UNSUPPORTED', 'Retained reads require secure-context OPFS and Web Locks');
      const result = await execute(archiveId, value.request as Request);
      reply({ ok: true, result });
    } catch (error) { reply({ ok: false, error: archiveError(error, requestId, null, validated ? 'IO_ERROR' : 'INVALID_REQUEST') }); }
  })();
};
