import { canonicalJson } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { CanonicalSqlite, SqlValue } from './canonical/repository.ts';

export interface OperationClaim { operationId: string; domain: string; requestDigest: string }
export class OperationClaimError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'MIGRATION_FAILED' | 'CONFLICT' | 'UNKNOWN_OUTCOME' | 'INTERNAL', message: string) { super(message); this.name = 'OperationClaimError'; }
}
type Database = CanonicalSqlite & { pointer: number };
type Sqlite = { capi: object };
const stableTriggers = [
  'quixi_local_claims_no_update', 'quixi_local_claims_no_delete', 'quixi_local_claims_no_replace', 'quixi_local_claims_existing_journal',
  'quixi_sync_ops_local_claim', 'quixi_import_operations_local_claim', 'quixi_import_record_identities_local_claim', 'quixi_blob_operations_local_claim', 'quixi_import_work_operations_local_claim',
] as const;
const archiveTriggers = ['quixi_archive_operations_local_claim', 'quixi_local_claims_archive_journal'] as const;
function fail(code: OperationClaimError['code'], message: string): never { throw new OperationClaimError(code, message); }
function validate(value: OperationClaim): void {
  if (!value || Object.keys(value).sort().join(',') !== 'domain,operationId,requestDigest' || !isQuixiId(value.operationId) || typeof value.domain !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(value.domain) || typeof value.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.requestDigest))
    fail('INVALID_REQUEST', 'Invalid bounded local operation claim');
}
/** Includes the domain, complete request digest and operation identity, with an
 * explicit hash format version. Request digests must cover operation kind/args. */
export function operationClaimIdentity(value: OperationClaim): string {
  validate(value);
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson({ version: 1, operationId: value.operationId, domain: value.domain, requestDigest: value.requestDigest }))));
}
function hasTable(db: CanonicalSqlite, name: string): boolean { return db.selectValue("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?)", [name]) === 1; }
function checkTriggers(db: CanonicalSqlite, names: readonly string[]): void {
  const count = db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name IN(${names.map(() => '?').join(',')})`, [...names]);
  if (count !== names.length) fail('MIGRATION_FAILED', 'Stable operation claim guards are missing; do not expose unfenced local routes');
}
function assertRegistry(db: CanonicalSqlite): void {
  if (!hasTable(db, 'quixi_local_operation_claims')) fail('MIGRATION_FAILED', 'Stable operation claim registry is missing; apply its canonical migration before local writes');
  checkTriggers(db, stableTriggers);
}

/** Read-only lookup with stored identity verification. No transaction, writable
 * registry guard or schema installation is performed. Callers supporting older
 * archives must establish that their pre-10 ledger permits an absent registry. */
export function readOperationClaim(db: CanonicalSqlite, operationId: string): OperationClaim | null {
  if (!isQuixiId(operationId)) fail('INVALID_REQUEST', 'Invalid local operation identity');
  if (!hasTable(db, 'quixi_local_operation_claims')) fail('MIGRATION_FAILED', 'Required stable operation claim registry is missing');
  const rows = db.exec({ sql: 'SELECT domain,request_digest,identity_digest FROM quixi_local_operation_claims WHERE operation_id=?', bind: [operationId], rowMode: 'object', returnValue: 'resultRows' }) as Record<string, SqlValue>[];
  const previous = rows[0];
  if (!previous) return null;
  const stored = { operationId, domain: String(previous.domain), requestDigest: String(previous.request_digest) };
  try { validate(stored); }
  catch { return fail('MIGRATION_FAILED', 'Stable operation claim fields are corrupt; preserve them for recovery'); }
  if (operationClaimIdentity(stored) !== previous.identity_digest) fail('MIGRATION_FAILED', 'Stable operation claim identity is corrupt; preserve it for recovery');
  return stored;
}

/** This journal is deliberately constructed outside the canonical migration.
 * Call only during owner setup after ArchiveRepository has installed its table,
 * alongside installArchiveOperationFences. Request execution never installs it. */
export function installArchiveOperationClaimFences(db: CanonicalSqlite): void {
  assertRegistry(db);
  if (!hasTable(db, 'quixi_archive_operations')) fail('MIGRATION_FAILED', 'Archive operation journal must exist before its local claim guards');
  db.exec('SAVEPOINT quixi_install_archive_claim_fences');
  try {
    db.exec(`
CREATE TRIGGER IF NOT EXISTS quixi_archive_operations_local_claim BEFORE INSERT ON quixi_archive_operations
 WHEN EXISTS(SELECT 1 FROM quixi_local_operation_claims WHERE operation_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'archive operation identity reserved by durable local claim'); END;
CREATE TRIGGER IF NOT EXISTS quixi_local_claims_archive_journal BEFORE INSERT ON quixi_local_operation_claims
 WHEN EXISTS(SELECT 1 FROM quixi_archive_operations WHERE id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'local operation identity already belongs to archive journal'); END;
`);
    db.exec('RELEASE quixi_install_archive_claim_fences');
  } catch (error) {
    try { db.exec('ROLLBACK TO quixi_install_archive_claim_fences; RELEASE quixi_install_archive_claim_fences'); } catch { /* SQLite FULL can already end the transaction. */ }
    throw error;
  }
}

/** Synchronous claim in the caller's actual SQLite transaction. The extraction
 * repository must return an existing matching derived receipt before calling
 * this method. Finding a prior claim here is recovery, never permission to redo. */
export class OperationClaimRegistry {
  constructor(private readonly db: Database, private readonly sqlite: Sqlite) {}
  lookup(operationId: string): OperationClaim | null { return readOperationClaim(this.db, operationId); }
  claim(value: OperationClaim): void {
    const identity = operationClaimIdentity(value);
    assertRegistry(this.db);
    if (hasTable(this.db, 'quixi_archive_operations')) checkTriggers(this.db, archiveTriggers);
    const getAutocommit = (this.sqlite.capi as { sqlite3_get_autocommit?: (pointer: number) => number }).sqlite3_get_autocommit;
    if (typeof getAutocommit !== 'function' || !Number.isSafeInteger(this.db.pointer) || this.db.pointer <= 0 || getAutocommit(this.db.pointer) !== 0)
      fail('INTERNAL', 'Local operation claim requires the same active SQLite transaction as its receipt and effect');
    const previous = this.lookup(value.operationId);
    if (previous) {
      if (previous.domain !== value.domain || previous.requestDigest !== value.requestDigest) fail('CONFLICT', 'Operation ID belongs to a different domain or request payload');
      fail('UNKNOWN_OUTCOME', 'This operation was already claimed but its derived receipt is unavailable; recover or reconcile without silently executing it again');
    }
    try {
      this.db.exec({ sql: 'INSERT INTO quixi_local_operation_claims VALUES(?,?,?,?)', bind: [value.operationId, value.domain, value.requestDigest, identity] });
    } catch (error) {
      if (((error as { resultCode?: number }).resultCode ?? 0) % 256 === 19) fail('CONFLICT', 'Operation ID is already reserved by another durable journal');
      throw error;
    }
  }
}
