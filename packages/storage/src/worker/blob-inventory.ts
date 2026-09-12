import {
  assertBlobInventoryArgs, BLOB_INVENTORY_KINDS,
  type BlobInventoryFinding, type BlobInventoryFindingKind, type BlobInventoryPage,
  type BlobInventoryStatus, type PageBudget,
} from '@quixi/core/contracts';
import { BlobStorageError, type OpfsBlobStore } from './blobs.ts';

type Value = string | number | null;
interface InventorySqlite {
  exec(options: string | { sql: string; bind?: Value[]; rowMode?: 'object'; returnValue?: 'resultRows' }): unknown;
}
type Row = Record<string, Value>;
const REFS = 'quixi_blob_inventory_refs';
const FINDINGS = 'quixi_blob_inventory_findings';
const EPOCH = 'quixi_blob_inventory_epoch';
const SOURCES = [
  'quixi_records', 'quixi_blob_catalog', 'quixi_blob_transfers',
  'quixi_import_jobs', 'quixi_import_records', 'quixi_import_blob_transfers',
  'quixi_import_runs', 'quixi_import_work_groups', 'quixi_import_work',
] as const;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const length = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const path = (sha: string) => `blobs/${sha.slice(0, 2)}/${sha}`;
const encoder = new TextEncoder();

/** Read-only diagnosis of canonical/file relationships. Scratch SQL is TEMP,
 * file-backed with a bounded cache; it never enters a portable archive. Each
 * advance examines at most its work budget, including nonmatching SQL records,
 * directory prefixes, unknown entries, and scratch cleanup. No blob is hashed.
 * A scan belongs solely to this owner and is never resumed after owner loss. */
export class BlobInventoryRepository {
  private current: BlobInventoryStatus | null = null;
  private initialized = false;
  private closed = false;
  private revision = 0;
  private fileRevision = 0;
  private dataVersion = 0;
  private cursor = 0;
  private source = 0;
  private cleanup = 0;
  private finalCursor = '';
  private sequence = 0;
  private files: ReturnType<OpfsBlobStore['inspectInventory']> | null = null;
  private finishedFiles = false;

  constructor(private readonly db: InventorySqlite, private readonly bytes: OpfsBlobStore) {}

  private rows(sql: string, bind: Value[] = []): Row[] {
    return this.db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as Row[];
  }
  private write(sql: string, bind: Value[] = []): void { this.db.exec({ sql, bind }); }
  private initialize(): void {
    if (this.initialized) return;
    // Changing temp_store here would destroy the owner's pre-existing fences.
    if (Number(this.rows('PRAGMA temp_store')[0]?.temp_store) !== 1)
      throw new BlobStorageError('IO_ERROR', 'Blob inventory requires file-backed temporary storage configured at owner startup.');
    this.write(`CREATE TEMP TABLE IF NOT EXISTS ${REFS}(
      sha256 TEXT PRIMARY KEY, refs INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0, expected_min INTEGER, expected_max INTEGER,
      catalog_bytes INTEGER, actual_bytes INTEGER, seen INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TEMP TABLE IF NOT EXISTS ${FINDINGS}(
      sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, sha256 TEXT, path TEXT,
      expected_bytes INTEGER, actual_bytes INTEGER, refs INTEGER NOT NULL
    ) STRICT;
    CREATE TEMP TABLE IF NOT EXISTS ${EPOCH}(revision INTEGER NOT NULL) STRICT;`);
    if (!this.rows(`SELECT revision FROM ${EPOCH} LIMIT 1`).length)
      this.write(`INSERT INTO ${EPOCH} VALUES(0)`);
    for (const table of SOURCES) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
        this.write(`CREATE TEMP TRIGGER IF NOT EXISTS ${EPOCH}_${table}_${operation}
          AFTER ${operation} ON main.${table} BEGIN UPDATE ${EPOCH} SET revision=revision+1; END;`);
    }
    this.initialized = true;
  }
  private epoch(): number { return Number(this.rows(`SELECT revision FROM ${EPOCH} LIMIT 1`)[0]!.revision); }
  private externalVersion(): number { return Number(this.rows('PRAGMA data_version')[0]!.data_version); }
  private require(scanId: string): BlobInventoryStatus {
    if (this.closed || !this.current || this.current.scanId !== scanId)
      throw new BlobStorageError('NOT_FOUND', 'Blob inventory belongs to another scan or storage owner; start a new scan.');
    return this.current;
  }
  private snapshot(): BlobInventoryStatus { return { ...this.current!, counts: { ...this.current!.counts } }; }
  private async releaseIterator(): Promise<void> {
    const files = this.files; this.files = null;
    if (files) await files.return(undefined);
  }
  private async refresh(scanId: string): Promise<BlobInventoryStatus> {
    const state = this.require(scanId);
    if ((state.state === 'running' || state.state === 'complete') &&
        (this.epoch() !== this.revision || this.bytes.inventoryEpoch !== this.fileRevision || this.externalVersion() !== this.dataVersion)) {
      state.state = 'stale'; state.updatedAt = Date.now();
      state.message = 'Archive or managed blob state changed; start a new scan.';
      await this.releaseIterator();
    }
    return state;
  }
  async begin(scanId: string): Promise<BlobInventoryStatus> {
    assertBlobInventoryArgs('beginBlobInventory', { scanId });
    if (this.closed) throw new BlobStorageError('CONFLICT', 'Blob inventory owner is closed.');
    if (this.current?.scanId === scanId) return this.status(scanId);
    if (this.current && (await this.refresh(this.current.scanId)).state === 'running')
      throw new BlobStorageError('CONFLICT', 'Stop the current blob inventory before starting another scan.');
    await this.releaseIterator();
    this.initialize();
    this.cursor = 0; this.source = 0; this.cleanup = 0; this.finalCursor = '';
    this.sequence = 0; this.finishedFiles = false;
    this.revision = this.epoch(); this.fileRevision = this.bytes.inventoryEpoch; this.dataVersion = this.externalVersion();
    const now = Date.now();
    this.current = { scanId, state: 'running', phase: 'preparing', startedAt: now, updatedAt: now,
      scannedRecords: 0, scannedTransfers: 0, scannedCatalogEntries: 0, scannedFiles: 0,
      counts: Object.fromEntries(BLOB_INVENTORY_KINDS.map(kind => [kind, 0])) as BlobInventoryStatus['counts'], message: null };
    return this.snapshot();
  }
  async status(scanId: string): Promise<BlobInventoryStatus> {
    assertBlobInventoryArgs('blobInventoryStatus', { scanId });
    await this.refresh(scanId); return this.snapshot();
  }
  private reference(sha: string, expected: number | null, protectedOnly: boolean): void {
    this.write(`INSERT INTO ${REFS}(sha256,refs,protected,expected_min,expected_max) VALUES(?,?,?,?,?)
      ON CONFLICT(sha256) DO UPDATE SET refs=refs+excluded.refs,protected=protected+excluded.protected,
      expected_min=CASE WHEN expected_min IS NULL THEN excluded.expected_min WHEN excluded.expected_min IS NULL THEN expected_min ELSE min(expected_min,excluded.expected_min) END,
      expected_max=CASE WHEN expected_max IS NULL THEN excluded.expected_max WHEN excluded.expected_max IS NULL THEN expected_max ELSE max(expected_max,excluded.expected_max) END`,
    [sha, protectedOnly ? 0 : 1, protectedOnly ? 1 : 0, expected, expected]);
  }
  private finding(kind: BlobInventoryFindingKind, sha256: string | null, filePath: string | null,
    expectedBytes: number | null, actualBytes: number | null, references: number): void {
    this.write(`INSERT INTO ${FINDINGS} VALUES(?,?,?,?,?,?,?)`, [++this.sequence, kind, sha256, filePath, expectedBytes, actualBytes, references]);
    this.current!.counts[kind]++;
  }
  /** One bounded SQL row or directory entry; transitions also consume work. */
  private async step(): Promise<void> {
    const state = this.current!;
    if (state.phase === 'preparing') {
      const table = [FINDINGS, REFS][this.cleanup];
      if (!table) { state.phase = 'references'; return; }
      const row = this.rows(`SELECT rowid AS position FROM ${table} ORDER BY rowid LIMIT 1`)[0];
      if (row) this.write(`DELETE FROM ${table} WHERE rowid=?`, [row.position!]);
      else this.cleanup++;
      return;
    }
    if (state.phase === 'references') {
      const table = ['quixi_records', 'quixi_import_records'][this.source];
      if (!table) { state.phase = 'transfers'; this.cursor = 0; return; }
      // SQL extracts fixed scalar fields rather than returning arbitrary content.
      const row = this.rows(`SELECT rowid AS position,
        (collection IN('attachments','rawObjects') AND json_extract(payload,'$.availability')='available')
          OR (collection='parts' AND json_type(payload,'$.data.textBlob') IS NOT NULL) AS needs_ref,
        CASE WHEN collection='attachments' AND json_extract(payload,'$.availability')='available' THEN json_extract(payload,'$.blobSha256')
          WHEN collection='rawObjects' AND json_extract(payload,'$.availability')='available' THEN json_extract(payload,'$.sha256')
          WHEN collection='parts' THEN json_extract(payload,'$.data.textBlob.sha256') END AS sha256,
        CASE WHEN collection='attachments' THEN json_extract(payload,'$.sizeBytes')
          WHEN collection='rawObjects' THEN json_extract(payload,'$.byteLength')
          WHEN collection='parts' THEN json_extract(payload,'$.data.textBlob.byteLength') END AS byte_length
        FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1`, [this.cursor])[0];
      if (!row) { this.source++; this.cursor = 0; return; }
      this.cursor = Number(row.position); state.scannedRecords++;
      if (row.needs_ref === 1) {
        if (!digest(row.sha256) || length(row.byte_length) === null) throw new Error('Invalid blob reference metadata');
        this.reference(row.sha256, length(row.byte_length), this.source === 1);
      }
      return;
    }
    if (state.phase === 'transfers') {
      const row = this.rows(`SELECT rowid AS position,sha256,byte_length,state,
        EXISTS(SELECT 1 FROM quixi_import_blob_transfers i WHERE i.transfer_id=t.id LIMIT 1) AS import_protected
        FROM quixi_blob_transfers t WHERE rowid>? ORDER BY rowid LIMIT 1`, [this.cursor])[0];
      if (!row) { state.phase = 'catalog'; this.cursor = 0; return; }
      this.cursor = Number(row.position); state.scannedTransfers++;
      if ((['verified', 'published', 'consumed'].includes(String(row.state)) || row.sha256 !== null) &&
          (!digest(row.sha256) || length(row.byte_length) === null)) throw new Error('Invalid transfer blob metadata');
      if (digest(row.sha256) && (row.state !== 'consumed' && row.state !== 'discarded' || row.import_protected === 1))
        this.reference(row.sha256, length(row.byte_length), true);
      return;
    }
    if (state.phase === 'catalog') {
      const row = this.rows('SELECT rowid AS position,sha256,byte_length FROM quixi_blob_catalog WHERE rowid>? ORDER BY rowid LIMIT 1', [this.cursor])[0];
      if (!row) { state.phase = 'files'; this.files = this.bytes.inspectInventory(); return; }
      this.cursor = Number(row.position); state.scannedCatalogEntries++;
      if (!digest(row.sha256) || length(row.byte_length) === null) throw new Error('Invalid catalog metadata');
      this.write(`INSERT INTO ${REFS}(sha256,catalog_bytes) VALUES(?,?) ON CONFLICT(sha256) DO UPDATE SET catalog_bytes=excluded.catalog_bytes`, [row.sha256, row.byte_length!]);
      return;
    }
    if (!this.finishedFiles) {
      const next = await this.files!.next();
      if (next.done) { await this.releaseIterator(); this.finishedFiles = true; return; }
      state.scannedFiles++;
      const file = next.value;
      if (file.kind === 'prefix') return;
      if (file.kind === 'unknown') { this.finding('unrecognized_entry', null, null, null, null, 0); return; }
      if (length(file.byteLength) === null) throw new Error('Invalid managed file size');
      if (file.kind === 'staged') { this.finding('staged_file', null, file.path, null, file.byteLength, 0); return; }
      const row = this.rows(`SELECT refs,protected FROM ${REFS} WHERE sha256=?`, [file.sha256])[0];
      if (!row || Number(row.refs) === 0 && Number(row.protected) === 0)
        this.finding('orphan_blob', file.sha256, file.path, null, file.byteLength, 0);
      if (row) this.write(`UPDATE ${REFS} SET actual_bytes=?,seen=1 WHERE sha256=?`, [file.byteLength, file.sha256]);
      return;
    }
    const row = this.rows(`SELECT * FROM ${REFS} WHERE sha256>? ORDER BY sha256 LIMIT 1`, [this.finalCursor])[0];
    if (!row) { state.state = 'complete'; state.phase = 'finished'; return; }
    const sha = String(row.sha256), references = Number(row.refs), actual = length(row.actual_bytes);
    this.finalCursor = sha;
    const expected = length(row.expected_min) ?? length(row.catalog_bytes);
    if (Number(row.protected) > 0) this.finding('protected_blob', sha, path(sha), expected, actual, references);
    if (references > 0 && row.catalog_bytes === null) this.finding('missing_catalog', sha, path(sha), expected, actual, references);
    if (!row.seen && (references > 0 || row.catalog_bytes !== null)) this.finding('missing_blob', sha, path(sha), expected, null, references);
    if (row.seen && [row.expected_min, row.expected_max, row.catalog_bytes].some(value => value !== null && value !== actual)) {
      const differing = [row.expected_min, row.expected_max, row.catalog_bytes].find(value => value !== null && value !== actual)!;
      this.finding('size_mismatch', sha, path(sha), Number(differing), actual, references);
    }
  }
  async advance(scanId: string, maxItems: number, signal?: AbortSignal): Promise<BlobInventoryStatus> {
    assertBlobInventoryArgs('advanceBlobInventory', { scanId, maxItems });
    const state = await this.refresh(scanId);
    if (state.state !== 'running') return this.snapshot();
    try {
      for (let count = 0; count < maxItems && state.state === 'running'; count++) {
        if (signal?.aborted) { await this.cancel(scanId); break; }
        await this.step();
        await this.refresh(scanId);
      }
      if (signal?.aborted) await this.cancel(scanId);
    } catch {
      state.state = signal?.aborted ? 'cancelled' : 'failed';
      state.message = signal?.aborted ? 'Blob inventory was cancelled.' : 'Blob inventory could not finish; start a new scan.';
      await this.releaseIterator();
    }
    state.updatedAt = Date.now();
    return this.snapshot();
  }
  async findings(scanId: string, page: PageBudget): Promise<BlobInventoryPage> {
    assertBlobInventoryArgs('readBlobInventoryFindings', { scanId, page });
    await this.refresh(scanId);
    const prefix = `${scanId}:`;
    let after = 0;
    if (page.cursor !== null) {
      const value = page.cursor.startsWith(prefix) ? page.cursor.slice(prefix.length) : '';
      if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new BlobStorageError('INVALID_REQUEST', 'Invalid blob inventory page cursor.');
      after = Number(value);
    }
    // A new identity cannot read the previous scan's rows while its bounded
    // preparing phase is still reclaiming them.
    if (this.current!.phase === 'preparing') return { items: [], nextCursor: null, bytes: 2 };
    const items: BlobInventoryFinding[] = [];
    let bytes = 2;
    while (items.length < page.maxItems) {
      const row = this.rows(`SELECT * FROM ${FINDINGS} WHERE sequence>? ORDER BY sequence LIMIT 1`, [after])[0];
      if (!row) break;
      const item: BlobInventoryFinding = { sequence: Number(row.sequence), kind: row.kind as BlobInventoryFindingKind,
        sha256: row.sha256 as string | null, path: row.path as string | null,
        expectedBytes: length(row.expected_bytes), actualBytes: length(row.actual_bytes), references: Number(row.refs) };
      const size = encoder.encode(JSON.stringify(item)).byteLength + (items.length ? 1 : 0);
      if (bytes + size > page.maxBytes) break;
      items.push(item); bytes += size; after = item.sequence;
    }
    const more = !!this.rows(`SELECT sequence FROM ${FINDINGS} WHERE sequence>? ORDER BY sequence LIMIT 1`, [after])[0];
    return { items, nextCursor: more ? `${prefix}${after}` : null, bytes };
  }
  async cancel(scanId: string): Promise<BlobInventoryStatus> {
    assertBlobInventoryArgs('cancelBlobInventory', { scanId });
    const state = await this.refresh(scanId);
    if (state.state === 'running' || state.state === 'complete') {
      state.state = 'cancelled'; state.updatedAt = Date.now(); state.message = 'Blob inventory was cancelled.';
    }
    await this.releaseIterator(); return this.snapshot();
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.releaseIterator();
    this.current = null;
    // Closing the owning database releases TEMP scratch and mutation triggers.
  }
}
