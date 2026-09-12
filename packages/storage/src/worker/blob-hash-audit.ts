import {
  assertBlobHashAuditArgs, BLOB_HASH_AUDIT_KINDS,
  type BlobHashAuditFinding, type BlobHashAuditFindingKind, type BlobHashAuditPage, type BlobHashAuditStatus, type PageBudget,
} from '@quixi/core/contracts';
import { BlobStorageError } from './blobs.ts';

type Value = string | number | null;
interface AuditSqlite { exec(options: string | { sql: string; bind?: Value[]; rowMode?: 'object'; returnValue?: 'resultRows' }): unknown }
type Row = Record<string, Value>;
/** The production verified read: bytes are hashed as they are read and a
 * digest mismatch surfaces as an IO_ERROR at the last block (blobs.ts). */
export interface HashAuditBlobs {
  readonly inventoryEpoch: number;
  beginVerifiedRead(transferId: string, digest: string, signal?: AbortSignal): Promise<{ transferId: string; byteLength: number; verifiedBytes: number; complete: boolean }>;
  advanceVerifiedRead(transferId: string, maxBytes: number, signal?: AbortSignal): Promise<{ transferId: string; byteLength: number; verifiedBytes: number; complete: boolean }>;
  discard(transferId: string): Promise<boolean>;
}
const FINDINGS = 'quixi_blob_hash_audit_findings';
const EPOCH = 'quixi_blob_hash_audit_epoch';
/** One work unit reads at most this many bytes, so a large file spans advances. */
export const BLOB_HASH_AUDIT_STEP_BYTES = 131072;
const encoder = new TextEncoder();
const path = (sha: string) => `blobs/${sha.slice(0, 2)}/${sha}`;

/** Read-only verification of every catalogued blob's content against its
 * SHA-256, through the same verified-read path that serves attachments. One
 * advance reads at most its work budget in bounded blocks; a scan belongs
 * to this owner, turns stale when the catalog or files change, and never
 * writes. The blob inventory answers references and orphans; this answers
 * whether the bytes that are present are the bytes that were saved. */
export class BlobHashAuditRepository {
  private current: BlobHashAuditStatus | null = null;
  private initialized = false;
  private closed = false;
  private revision = 0;
  private fileRevision = 0;
  private dataVersion = 0;
  private cursor = '';
  private sequence = 0;
  private cleanup = false;
  private open: { transferId: string; sha256: string; expected: number; verified: number } | null = null;
  constructor(private readonly db: AuditSqlite, private readonly blobs: HashAuditBlobs) {}
  private rows(sql: string, bind: Value[] = []): Row[] { return this.db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as Row[]; }
  private write(sql: string, bind: Value[] = []): void { this.db.exec({ sql, bind }); }
  private initialize(): void {
    if (this.initialized) return;
    this.write(`CREATE TEMP TABLE IF NOT EXISTS ${FINDINGS}(sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT NOT NULL, expected INTEGER NOT NULL, actual INTEGER) STRICT;
    CREATE TEMP TABLE IF NOT EXISTS ${EPOCH}(revision INTEGER NOT NULL) STRICT;`);
    if (!this.rows(`SELECT revision FROM ${EPOCH} LIMIT 1`).length) this.write(`INSERT INTO ${EPOCH} VALUES(0)`);
    // Verification-only catalog updates (background indexing) change neither digest nor size.
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
      this.write(`CREATE TEMP TRIGGER IF NOT EXISTS ${EPOCH}_catalog_${operation} AFTER ${operation} ON main.quixi_blob_catalog${operation === 'UPDATE' ? ' WHEN NEW.sha256 IS NOT OLD.sha256 OR NEW.byte_length IS NOT OLD.byte_length' : ''} BEGIN UPDATE ${EPOCH} SET revision=revision+1; END;`);
    this.initialized = true;
  }
  private epoch(): number { return Number(this.rows(`SELECT revision FROM ${EPOCH} LIMIT 1`)[0]!.revision); }
  private externalVersion(): number { return Number(this.rows('PRAGMA data_version')[0]!.data_version); }
  private require(scanId: string): BlobHashAuditStatus {
    if (this.closed || !this.current || this.current.scanId !== scanId) throw new BlobStorageError('NOT_FOUND', 'Blob hash audit belongs to another scan or storage owner; start a new audit.');
    return this.current;
  }
  private snapshot(): BlobHashAuditStatus { return { ...this.current!, counts: { ...this.current!.counts } }; }
  private async release(): Promise<void> {
    const open = this.open; this.open = null;
    if (open) await this.blobs.discard(open.transferId).catch(() => {});
  }
  private async refresh(scanId: string): Promise<BlobHashAuditStatus> {
    const state = this.require(scanId);
    if ((state.state === 'running' || state.state === 'complete') && (this.epoch() !== this.revision || this.blobs.inventoryEpoch !== this.fileRevision || this.externalVersion() !== this.dataVersion)) {
      state.state = 'stale'; state.updatedAt = Date.now(); state.message = 'Stored files or their catalog changed; start a new audit.';
      await this.release();
    }
    return state;
  }
  async begin(scanId: string): Promise<BlobHashAuditStatus> {
    assertBlobHashAuditArgs('beginBlobHashAudit', { scanId });
    if (this.closed) throw new BlobStorageError('CONFLICT', 'Blob hash audit owner is closed.');
    if (this.current?.scanId === scanId) return this.status(scanId);
    if (this.current && (await this.refresh(this.current.scanId)).state === 'running') throw new BlobStorageError('CONFLICT', 'Stop the current blob hash audit before starting another.');
    await this.release();
    this.initialize();
    this.cursor = ''; this.sequence = 0; this.cleanup = true;
    this.revision = this.epoch(); this.fileRevision = this.blobs.inventoryEpoch; this.dataVersion = this.externalVersion();
    const totals = this.rows('SELECT count(*) AS files, coalesce(sum(byte_length),0) AS bytes FROM quixi_blob_catalog')[0]!;
    const now = Date.now();
    this.current = { scanId, state: 'running', phase: 'preparing', startedAt: now, updatedAt: now, totalFiles: Number(totals.files), scannedFiles: 0, totalBytes: Number(totals.bytes), verifiedBytes: 0,
      counts: Object.fromEntries(BLOB_HASH_AUDIT_KINDS.map(kind => [kind, 0])) as BlobHashAuditStatus['counts'], message: null };
    return this.snapshot();
  }
  async status(scanId: string): Promise<BlobHashAuditStatus> { assertBlobHashAuditArgs('blobHashAuditStatus', { scanId }); await this.refresh(scanId); return this.snapshot(); }
  private finding(kind: BlobHashAuditFindingKind, sha256: string, expected: number, actual: number | null): void {
    this.write(`INSERT INTO ${FINDINGS} VALUES(?,?,?,?,?)`, [++this.sequence, kind, sha256, expected, actual]);
    this.current!.counts[kind]++;
  }
  /** One bounded unit: a catalog row, or one block of an open file. */
  private async step(signal?: AbortSignal): Promise<void> {
    const state = this.current!;
    if (state.phase === 'preparing') {
      if (this.cleanup) { const row = this.rows(`SELECT rowid AS position FROM ${FINDINGS} ORDER BY rowid LIMIT 1`)[0]; if (row) { this.write(`DELETE FROM ${FINDINGS} WHERE rowid=?`, [row.position!]); return; } this.cleanup = false; }
      state.phase = 'hashing'; return;
    }
    if (!this.open) {
      const row = this.rows('SELECT sha256, byte_length FROM quixi_blob_catalog WHERE sha256>? ORDER BY sha256 LIMIT 1', [this.cursor])[0];
      if (!row) { state.state = 'complete'; state.phase = 'finished'; return; }
      const sha256 = String(row.sha256), expected = Number(row.byte_length);
      this.cursor = sha256; state.scannedFiles++;
      const transferId = crypto.randomUUID();
      try {
        const progress = await this.blobs.beginVerifiedRead(transferId, sha256, signal);
        if (progress.byteLength !== expected) {
          await this.blobs.discard(transferId).catch(() => {});
          this.finding('size_mismatch', sha256, expected, progress.byteLength);
          return;
        }
        this.open = { transferId, sha256, expected, verified: progress.verifiedBytes };
        if (progress.complete) { state.verifiedBytes += expected; await this.release(); }
      } catch (error) {
        if (error instanceof BlobStorageError && error.code === 'CANCELLED') throw error;
        this.finding(error instanceof BlobStorageError && error.code === 'NOT_FOUND' ? 'missing_blob' : 'read_error', sha256, expected, null);
      }
      return;
    }
    const open = this.open;
    try {
      const progress = await this.blobs.advanceVerifiedRead(open.transferId, BLOB_HASH_AUDIT_STEP_BYTES, signal);
      state.verifiedBytes += progress.verifiedBytes - open.verified;
      open.verified = progress.verifiedBytes;
      if (progress.complete) await this.release();
    } catch (error) {
      if (error instanceof BlobStorageError && error.code === 'CANCELLED') throw error;
      // A verified read fails at its last block when the digest differs; the
      // store has already invalidated the shared handle.
      this.open = null;
      await this.blobs.discard(open.transferId).catch(() => {});
      this.finding(error instanceof BlobStorageError && /SHA-256/.test(error.message) ? 'hash_mismatch' : 'read_error', open.sha256, open.expected, open.expected);
    }
  }
  async advance(scanId: string, maxItems: number, signal?: AbortSignal): Promise<BlobHashAuditStatus> {
    assertBlobHashAuditArgs('advanceBlobHashAudit', { scanId, maxItems });
    const state = await this.refresh(scanId);
    if (state.state !== 'running') return this.snapshot();
    try {
      for (let count = 0; count < maxItems && state.state === 'running'; count++) {
        if (signal?.aborted) { await this.cancel(scanId); break; }
        await this.step(signal);
        await this.refresh(scanId);
      }
      if (signal?.aborted) await this.cancel(scanId);
    } catch {
      state.state = signal?.aborted ? 'cancelled' : 'failed';
      state.message = signal?.aborted ? 'Blob hash audit was cancelled.' : 'Blob hash audit could not finish; start a new audit.';
      await this.release();
    }
    state.updatedAt = Date.now();
    return this.snapshot();
  }
  async findings(scanId: string, page: PageBudget): Promise<BlobHashAuditPage> {
    assertBlobHashAuditArgs('readBlobHashAuditFindings', { scanId, page });
    await this.refresh(scanId);
    const prefix = `${scanId}:`;
    let after = 0;
    if (page.cursor !== null) {
      const value = page.cursor.startsWith(prefix) ? page.cursor.slice(prefix.length) : '';
      if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new BlobStorageError('INVALID_REQUEST', 'Invalid blob hash audit page cursor.');
      after = Number(value);
    }
    if (this.current!.phase === 'preparing') return { items: [], nextCursor: null, bytes: 2 };
    const items: BlobHashAuditFinding[] = [];
    let bytes = 2;
    while (items.length < page.maxItems) {
      const row = this.rows(`SELECT * FROM ${FINDINGS} WHERE sequence>? ORDER BY sequence LIMIT 1`, [after])[0];
      if (!row) break;
      const sha256 = String(row.sha256);
      const item: BlobHashAuditFinding = { sequence: Number(row.sequence), kind: row.kind as BlobHashAuditFindingKind, sha256, path: path(sha256), expectedBytes: Number(row.expected), actualBytes: row.actual === null ? null : Number(row.actual) };
      const size = encoder.encode(JSON.stringify(item)).byteLength + (items.length ? 1 : 0);
      if (bytes + size > page.maxBytes) break;
      items.push(item); bytes += size; after = item.sequence;
    }
    const more = !!this.rows(`SELECT sequence FROM ${FINDINGS} WHERE sequence>? ORDER BY sequence LIMIT 1`, [after])[0];
    return { items, nextCursor: more ? `${prefix}${after}` : null, bytes };
  }
  async cancel(scanId: string): Promise<BlobHashAuditStatus> {
    assertBlobHashAuditArgs('cancelBlobHashAudit', { scanId });
    const state = await this.refresh(scanId);
    if (state.state === 'running' || state.state === 'complete') { state.state = 'cancelled'; state.updatedAt = Date.now(); state.message = 'Blob hash audit was cancelled.'; }
    await this.release(); return this.snapshot();
  }
  async close(): Promise<void> { this.closed = true; await this.release(); this.current = null; }
}
