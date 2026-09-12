import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalJson, jsonByteLength } from '@quixi/core/contracts';
import type { ArchiveActivationReview } from '@quixi/core/contracts';
import { isQuixiId } from '@quixi/core/model';
import type { JsonValue } from '@quixi/core/model';
import type { ArchiveDatabaseFile } from '../worker/archives/snapshot.ts';
import type { StorageSqliteModule, StorageSqlitePool } from '../worker/sqlite-module.ts';

export interface ManagedArchiveSelection { archiveId: string; selectionRevision: number }
export interface ManagedActivationArgs {
  operationId: string;
  expectedSelection: ManagedArchiveSelection;
  review: ArchiveActivationReview;
}
export interface ManagedActivationReceipt {
  operationId: string;
  payloadSha256: string;
  previous: ManagedArchiveSelection;
  selected: ManagedArchiveSelection;
  review: ArchiveActivationReview;
}
export type ManagedActivationStatus =
  | { status: 'not_found' }
  | { status: 'prepared' | 'interrupted' | 'failed'; payloadSha256: string; reason: string | null }
  | { status: 'committed'; payloadSha256: string; receipt: ManagedActivationReceipt };
export interface ManagedReviewedActivation {
  signal?: AbortSignal;
  /** Caller owns the source queue and acquires/validates the candidate once. */
  withReviewedCandidate(commitSelection: () => ManagedActivationReceipt): Promise<unknown>;
}
export interface ManagedSelectionOptions {
  testDirectory?: `test-${string}`;
  /** Fresh catalog only. Create/validate the concrete default archive before
   * this callback returns. Already under the selection gate: acquire its owner
   * lock with ifAvailable, NEVER wait for it or reenter this catalog.
   */
  initializeDefault?: () => Promise<void>;
}
export class ManagedSelectionError extends Error {
  constructor(
    readonly code: 'CONFLICT' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'INVALID_REQUEST' | 'UNKNOWN_OUTCOME' | 'OVERLOADED' | 'CANCELLED',
    message: string,
    options?: { cause?: unknown },
  ) { super(message, options); this.name = 'ManagedSelectionError'; }
}

const filename = '/selection.sqlite3';
const applicationId = 0x51585343;
const metadataLimit = 16_384;
const ddl = [
  'CREATE TABLE selection (id INTEGER PRIMARY KEY CHECK(id=1), archive_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), operation_id TEXT) STRICT',
  "CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(length(payload)<=16384), digest TEXT NOT NULL CHECK(length(digest)=64), state TEXT NOT NULL CHECK(state IN('prepared','interrupted','failed','committed')), reason TEXT CHECK(reason IS NULL OR length(reason)<=512), receipt TEXT CHECK(receipt IS NULL OR length(receipt)<=16384)) STRICT",
  'CREATE INDEX operations_state ON operations(state)',
  'CREATE TABLE retained (archive_id TEXT PRIMARY KEY, first_revision INTEGER NOT NULL CHECK(first_revision>=0)) STRICT',
];
const approvedSchema = [...ddl].sort((a, b) => a.split(' ')[2]!.localeCompare(b.split(' ')[2]!));
const validArchive = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fail(code: ManagedSelectionError['code'], message: string): never { throw new ManagedSelectionError(code, message); }
const encode = (value: unknown): string => canonicalJson(value as JsonValue);
const hash = (value: string): string => bytesToHex(sha256(new TextEncoder().encode(value)));
function keys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail('INVALID_REQUEST', 'Selection metadata has unexpected or missing fields.');
}
function selection(value: unknown): asserts value is ManagedArchiveSelection {
  keys(value, ['archiveId', 'selectionRevision']);
  if (!validArchive(value.archiveId) || !count(value.selectionRevision)) fail('INVALID_REQUEST', 'Invalid archive selection fence.');
}
/** Validate before cloning; retain every field of the complete reviewed candidate. */
function activation(value: ManagedActivationArgs): string {
  try { jsonByteLength(value, metadataLimit); }
  catch { fail('INVALID_REQUEST', 'Activation metadata exceeds the bounded control limit.'); }
  keys(value, ['operationId', 'expectedSelection', 'review']);
  if (!isQuixiId(value.operationId)) fail('INVALID_REQUEST', 'Invalid activation operation identity.');
  selection(value.expectedSelection);
  keys(value.review, ['token', 'jobId', 'candidate', 'expectedActiveArchiveId', 'expectedRevision']);
  const review = value.review;
  if (!isQuixiId(review.token) || !isQuixiId(review.jobId) || !count(review.expectedRevision) ||
      review.expectedActiveArchiveId !== value.expectedSelection.archiveId) fail('INVALID_REQUEST', 'Activation review does not identify its expected source archive.');
  keys(review.candidate, ['archiveId', 'schemaVersion', 'canonicalRecords', 'syncOperations', 'blobCount', 'blobBytes', 'streamingGenerations', 'defaultWorkspaceId', 'manifestSha256']);
  const candidate = review.candidate;
  if (!isQuixiId(candidate.archiveId) || candidate.archiveId === value.expectedSelection.archiveId ||
      !digest(candidate.manifestSha256) || !(candidate.defaultWorkspaceId === null || isQuixiId(candidate.defaultWorkspaceId))) fail('INVALID_REQUEST', 'Invalid isolated restore candidate identity.');
  for (const name of ['schemaVersion', 'canonicalRecords', 'syncOperations', 'blobCount', 'blobBytes', 'streamingGenerations'] as const) {
    if (!count(candidate[name])) fail('INVALID_REQUEST', 'Invalid candidate summary count.');
  }
  if (candidate.schemaVersion < 1) fail('INVALID_REQUEST', 'Invalid candidate schema version.');
  return encode(value);
}
const rows = (db: ArchiveDatabaseFile, sql: string, bind: (string | number | null)[] = []) =>
  db.exec({ sql, ...(bind.length ? { bind } : {}), rowMode: 'object', returnValue: 'resultRows' }) as Record<string, unknown>[];
function transaction<T>(db: ArchiveDatabaseFile, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch { /* Preserve uncertain commit outcome for receipt reconciliation. */ } throw error; }
}
function expectedReceipt(args: ManagedActivationArgs, payloadSha256: string): ManagedActivationReceipt {
  return { operationId: args.operationId, payloadSha256, previous: args.expectedSelection,
    selected: { archiveId: args.review.candidate.archiveId, selectionRevision: args.expectedSelection.selectionRevision + 1 }, review: args.review };
}

/** Origin-local selection authority. Only restore review can replace the active archive.
 * Each call owns the global gate and opens/pauses its pool within that gate.
 * The injected module MUST be the same initialized module used by this worker's archive.
 */
export class ManagedSelectionCatalog {
  private pool: StorageSqlitePool | undefined;
  private pending = 0;
  private unavailable: unknown;
  private readonly namespace: string;
  readonly gate: string;
  readonly directory: string;
  constructor(private readonly sqlite: StorageSqliteModule, private readonly options: ManagedSelectionOptions = {}) {
    if (Object.keys(options).some(key => key !== 'testDirectory' && key !== 'initializeDefault') ||
        options.testDirectory !== undefined && !/^test-[A-Za-z0-9_-]{1,58}$/.test(options.testDirectory) ||
        options.initializeDefault !== undefined && typeof options.initializeDefault !== 'function') {
      fail('INVALID_REQUEST', 'Only an explicit isolated test-* catalog directory can override the production location.');
    }
    this.namespace = options.testDirectory ?? 'quixi-selection';
    this.directory = `/${this.namespace}/catalog`;
    this.gate = options.testDirectory ? `quixi:${this.namespace}:selection:owner` : 'quixi:selection:owner';
  }
  /** A session that cannot provide origin-private storage at all is an
   * unsupported session, distinct from a damaged or missing catalog. */
  private async storageRoot(): Promise<FileSystemDirectoryHandle> {
    try { return await navigator.storage.getDirectory(); }
    catch (error) {
      throw new ManagedSelectionError('UNSUPPORTED', `Local archive storage (OPFS) is unavailable in this session. Use a regular browser profile with site storage enabled; private or restricted sessions may prevent access. No archive was opened. ${String(error).slice(0, 256)}`, { cause: error });
    }
  }
  private async assertArchivePresent(selected: ManagedArchiveSelection): Promise<void> {
    const root = await this.storageRoot();
    try {
      const archive = await root.getDirectoryHandle(selected.archiveId === 'default' ? 'quixi' : `quixi-${selected.archiveId}`);
      await archive.getDirectoryHandle('database');
    } catch (error) {
      throw new ManagedSelectionError('UNAVAILABLE', `Selected or candidate archive namespace is missing; restore its existing data rather than creating an empty archive. ${String(error).slice(0,256)}`);
    }
  }
  private async open(): Promise<ArchiveDatabaseFile> {
    if (this.unavailable) fail('UNAVAILABLE', 'Selection catalog requires recovery after a prior close failure.');
    let db: ArchiveDatabaseFile | undefined;
    try {
      const root = await this.storageRoot();
      let directory: FileSystemDirectoryHandle;
      let fresh = false;
      try { directory = await root.getDirectoryHandle(this.namespace); }
      catch (error) {
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
        if (this.pool) fail('UNAVAILABLE', 'Previously opened selection directory disappeared.');
        if (!this.options.initializeDefault) fail('UNAVAILABLE', 'The first selection catalog requires concrete default archive initialization.');
        await this.options.initializeDefault();
        await this.assertArchivePresent({ archiveId: 'default', selectionRevision: 0 });
        fresh = true;
        directory = await root.getDirectoryHandle(this.namespace, { create: true });
      }
      // A partially initialized/deleted existing catalog must never adopt default again.
      await directory.getDirectoryHandle('catalog', fresh ? { create: true } : {});
      this.pool ??= await this.sqlite.installOpfsSAHPoolVfs({
        name: `quixi-managed-selection-${crypto.randomUUID()}`, directory: this.directory, initialCapacity: 4,
      });
      await this.pool.unpauseVfs();
      if (!fresh && !this.pool.getFileNames().includes(filename)) fail('UNAVAILABLE', 'Existing selection database is absent or unreadable.');
      db = new this.pool.OpfsSAHPoolDb(filename, fresh ? 'c' : 'w');
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;');
      if (fresh) transaction(db, () => {
        for (const sql of ddl) db!.exec(sql);
        db!.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;`);
        db!.exec("INSERT INTO selection VALUES(1,'default',0,NULL); INSERT INTO retained VALUES('default',0);");
      });
      if (Number(db.selectValue('PRAGMA application_id')) !== applicationId || Number(db.selectValue('PRAGMA user_version')) !== 1) fail('UNAVAILABLE', 'Selection database identity or version is invalid.');
      const schema = rows(db, "SELECT substr(sql,1,2049) AS sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 5").map(row => String(row.sql));
      if (encode(schema) !== encode(approvedSchema)) fail('UNAVAILABLE', 'Selection database schema differs from the supported catalog.');
      this.current(db);
      db.exec("UPDATE operations SET state='interrupted',reason='Previous owner ended before a confirmed selection commit.' WHERE state='prepared'");
      return db;
    } catch (error) {
      try { db?.close(); } catch (cleanup) { this.unavailable = cleanup; }
      try { this.pool?.pauseVfs(); } catch (cleanup) { this.unavailable = cleanup; }
      if (error instanceof ManagedSelectionError && error.code === 'UNSUPPORTED') throw error;
      // Keep the browser's own failure as the cause so the storage boundary can
      // distinguish a denied storage session from a damaged catalog.
      throw new ManagedSelectionError('UNAVAILABLE', `Selection catalog could not be opened; existing archives remain retained. ${String(error).slice(0,512)}`, { cause: error });
    }
  }
  private operation(db: ArchiveDatabaseFile, id: string, payload?: string): ManagedActivationStatus {
    const row = rows(db, 'SELECT substr(payload,1,16385) AS payload,substr(digest,1,65) AS digest,substr(state,1,12) AS state,substr(reason,1,513) AS reason,substr(receipt,1,16385) AS receipt FROM operations WHERE id=?', [id])[0];
    if (!row) return { status: 'not_found' };
    if (payload !== undefined && row.payload !== payload) fail('CONFLICT', 'Operation identity already belongs to a different full activation review.');
    if (typeof row.payload !== 'string' || row.payload.length > metadataLimit || hash(row.payload) !== row.digest) fail('UNAVAILABLE', 'Selection operation payload digest is invalid.');
    let original: ManagedActivationArgs;
    try { original = JSON.parse(row.payload) as ManagedActivationArgs; if (activation(original) !== row.payload || original.operationId !== id) throw new Error('Invalid persisted identity'); }
    catch { fail('UNAVAILABLE', 'Persisted selection operation metadata is invalid.'); }
    if (row.state === 'committed') {
      if (typeof row.receipt !== 'string' || row.receipt.length > metadataLimit || encode(expectedReceipt(original, String(row.digest))) !== row.receipt) fail('UNAVAILABLE', 'Selection receipt does not match its full reviewed payload.');
      return { status: 'committed', payloadSha256: String(row.digest), receipt: JSON.parse(row.receipt) as ManagedActivationReceipt };
    }
    if (!['prepared', 'interrupted', 'failed'].includes(String(row.state)) || row.receipt !== null || !(row.reason === null || typeof row.reason === 'string' && row.reason.length <= 512)) fail('UNAVAILABLE', 'Selection operation status is invalid.');
    return { status: row.state as 'prepared' | 'interrupted' | 'failed', payloadSha256: String(row.digest), reason: row.reason as string | null };
  }
  private current(db: ArchiveDatabaseFile): ManagedArchiveSelection {
    const row = rows(db, 'SELECT substr(archive_id,1,65) AS archive_id,revision,substr(operation_id,1,37) AS operation_id FROM selection WHERE id=1')[0];
    if (!row) fail('UNAVAILABLE', 'Selection head is missing.');
    const current = { archiveId: row.archive_id, selectionRevision: row.revision };
    try { selection(current); } catch { fail('UNAVAILABLE', 'Selection head is invalid.'); }
    if (row.operation_id === null) {
      if (current.archiveId !== 'default' || current.selectionRevision !== 0) fail('UNAVAILABLE', 'Initial selection has no valid receipt.');
    } else {
      if (!isQuixiId(row.operation_id)) fail('UNAVAILABLE', 'Selection head has no valid operation identity.');
      const prior = this.operation(db, row.operation_id);
      if (prior.status !== 'committed' || encode(prior.receipt.selected) !== encode(current)) fail('UNAVAILABLE', 'Selection head has no matching committed receipt.');
    }
    const retained = rows(db, 'SELECT first_revision FROM retained WHERE archive_id=?', [current.archiveId])[0];
    if (!retained || !count(retained.first_revision) || retained.first_revision > current.selectionRevision) fail('UNAVAILABLE', 'Selected archive retention evidence is missing.');
    return current;
  }
  private assertCurrent(db: ArchiveDatabaseFile, expected: ManagedArchiveSelection): void {
    if (encode(this.current(db)) !== encode(expected)) fail('CONFLICT', 'The active archive changed; this context cannot write under its old selection.');
  }
  private async gated<T>(work: (db: ArchiveDatabaseFile) => Promise<T> | T): Promise<T> {
    if (this.pending >= 16) fail('OVERLOADED', 'Selection catalog queue is full.');
    this.pending++;
    try {
      return await navigator.locks.request(this.gate, { mode: 'exclusive' }, async () => {
        const db = await this.open();
        try { return await work(db); }
        finally {
          try { db.close(); } catch (error) { this.unavailable = error; throw error; }
          finally { try { this.pool!.pauseVfs(); } catch (error) { this.unavailable = error; throw error; } }
        }
      });
    } finally { this.pending--; }
  }
  read(): Promise<ManagedArchiveSelection> {
    return this.gated(async db => { const selected = this.current(db); await this.assertArchivePresent(selected); return selected; });
  }
  status(operationId: string, fullArgs?: ManagedActivationArgs): Promise<ManagedActivationStatus> {
    if (!isQuixiId(operationId)) fail('INVALID_REQUEST', 'Invalid activation operation identity.');
    const payload = fullArgs === undefined ? undefined : activation(fullArgs);
    if (fullArgs && fullArgs.operationId !== operationId) fail('CONFLICT', 'Status and activation operation identities differ.');
    return this.gated(db => this.operation(db, operationId, payload));
  }
  guard<T>(expected: ManagedArchiveSelection, effect: () => Promise<T> | T): Promise<T> {
    selection(expected); const snapshot = { ...expected };
    return this.gated(async db => { this.assertCurrent(db, snapshot); await this.assertArchivePresent(snapshot); return effect(); });
  }
  activateReviewed(fullArgs: ManagedActivationArgs, hooks: ManagedReviewedActivation): Promise<ManagedActivationReceipt> {
    const payload = activation(fullArgs), payloadSha256 = hash(payload), args = JSON.parse(payload) as ManagedActivationArgs;
    let knownReceipt: ManagedActivationReceipt | undefined;
    const stopped = () => { if (hooks.signal?.aborted) fail('CANCELLED', 'Archive activation was cancelled before selection publication.'); };
    return this.gated(async db => {
      const prior = this.operation(db, args.operationId, payload);
      if (prior.status === 'committed') { knownReceipt = prior.receipt; return structuredClone(knownReceipt); }
      stopped(); this.assertCurrent(db, args.expectedSelection);
      await this.assertArchivePresent(args.expectedSelection);
      if (args.expectedSelection.selectionRevision === Number.MAX_SAFE_INTEGER) fail('CONFLICT', 'Selection revision is exhausted.');
      if (db.selectValue('SELECT 1 FROM retained WHERE archive_id=?', [args.review.candidate.archiveId])) fail('CONFLICT', 'This candidate was already selected; restore activation cannot switch among retained archives.');
      await this.assertArchivePresent({ archiveId: args.review.candidate.archiveId, selectionRevision: args.expectedSelection.selectionRevision + 1 });
      transaction(db, () => db.exec({ sql: "INSERT INTO operations VALUES(?,?,?,'prepared',NULL,NULL) ON CONFLICT(id) DO UPDATE SET state='prepared',reason=NULL", bind: [args.operationId, payload, payloadSha256] }));
      let valid = false, used = false, publicationAttempted = false;
      const commit = (): ManagedActivationReceipt => {
        if (!valid || used) fail('CONFLICT', 'Selection publication callback expired or was already used.');
        used = true; stopped(); this.assertCurrent(db, args.expectedSelection);
        const receipt = expectedReceipt(args, payloadSha256);
        publicationAttempted = true;
        transaction(db, () => {
          db.exec({ sql: 'UPDATE selection SET archive_id=?,revision=?,operation_id=? WHERE id=1', bind: [receipt.selected.archiveId, receipt.selected.selectionRevision, args.operationId] });
          db.exec({ sql: "UPDATE operations SET state='committed',reason=NULL,receipt=? WHERE id=?", bind: [encode(receipt), args.operationId] });
          db.exec({ sql: 'INSERT INTO retained VALUES(?,?)', bind: [receipt.selected.archiveId, receipt.selected.selectionRevision] });
        });
        knownReceipt = receipt; return structuredClone(receipt);
      };
      try {
        stopped(); valid = true;
        try { await hooks.withReviewedCandidate(commit); } finally { valid = false; }
        if (!knownReceipt) fail('CONFLICT', 'Reviewed candidate validation returned without publishing selection.');
        return structuredClone(knownReceipt);
      } catch (error) {
        valid = false;
        if (knownReceipt) return structuredClone(knownReceipt);
        // COMMIT may have succeeded even if the driver lost its confirmation.
        let absenceConfirmed = false;
        try { const durable = this.operation(db, args.operationId, payload); if (durable.status === 'committed') { knownReceipt = durable.receipt; return structuredClone(knownReceipt); } absenceConfirmed = durable.status !== 'not_found'; }
        catch { /* The next owner can inspect the stable operation identity. */ }
        const failure = publicationAttempted && !absenceConfirmed
          ? new ManagedSelectionError('UNKNOWN_OUTCOME', 'Selection publication outcome is unknown. Inspect the same operation identity before retrying.')
          : hooks.signal?.aborted ? new ManagedSelectionError('CANCELLED', 'Archive activation was cancelled before selection publication.') : error;
        try { db.exec({ sql: "UPDATE operations SET state='failed',reason=? WHERE id=? AND state='prepared'", bind: [String(failure).slice(0,512), args.operationId] }); }
        catch { /* A surviving prepared intent becomes interrupted at the next open. */ }
        throw failure;
      }
    }).catch(error => { if (knownReceipt) return structuredClone(knownReceipt); throw error; });
  }
}
