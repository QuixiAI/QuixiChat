import {
  assertDoctorAuditArgs, DOCTOR_AUDIT_KINDS,
  type DoctorAuditFinding, type DoctorAuditFindingKind, type DoctorAuditPage, type DoctorAuditStatus, type PageBudget,
} from '@quixi/core/contracts';
import { BlobStorageError } from './blobs.ts';

type Value = string | number | null;
interface AuditSqlite { exec(options: string | { sql: string; bind?: Value[]; rowMode?: 'object'; returnValue?: 'resultRows' }): unknown }
type Row = Record<string, Value>;
const FINDINGS = 'quixi_doctor_audit_findings';
const EPOCH = 'quixi_doctor_audit_epoch';
const encoder = new TextEncoder();
/** Each source is one bounded rowid walk; the phase names what it audits. */
const SOURCES: { phase: DoctorAuditStatus['phase']; table: 'quixi_records' | 'quixi_sync_ops'; collection: string | null }[] = [
  { phase: 'branches', table: 'quixi_records', collection: 'messages' },
  { phase: 'branches', table: 'quixi_records', collection: 'threadStates' },
  { phase: 'branches', table: 'quixi_records', collection: 'threads' },
  { phase: 'branches', table: 'quixi_records', collection: 'contexts' },
  { phase: 'provenance', table: 'quixi_records', collection: 'provenance' },
  { phase: 'provenance', table: 'quixi_records', collection: 'sourceIdentities' },
  { phase: 'provenance', table: 'quixi_records', collection: 'documents' },
  { phase: 'sync', table: 'quixi_sync_ops', collection: null },
];
/** Sync-op affects name entity kinds; records live in collections. */
const COLLECTIONS: Record<string, string> = { summaryProposal: 'summaryProposals', thread: 'threads', threadState: 'threadStates', context: 'contexts', message: 'messages', generation: 'generations', part: 'parts', event: 'events', attachment: 'attachments', document: 'documents', rawObject: 'rawObjects', importSource: 'importSources', sourceIdentity: 'sourceIdentities', provenance: 'provenance', tombstone: 'tombstones' };
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128;

/** Read-only Quixi Doctor audit of canonical invariants that the commit path
 * enforces at write time (branches, provenance, sync coverage), so damage
 * that arrived by other means is found and named. Scratch is TEMP; one
 * advance examines at most its work budget; a scan belongs to this owner. */
export class DoctorAuditRepository {
  private current: DoctorAuditStatus | null = null;
  private initialized = false;
  private closed = false;
  private revision = 0;
  private dataVersion = 0;
  private source = 0;
  private cursor = 0;
  private sequence = 0;
  private cleanup = false;
  constructor(private readonly db: AuditSqlite) {}
  private rows(sql: string, bind: Value[] = []): Row[] { return this.db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) as Row[]; }
  private write(sql: string, bind: Value[] = []): void { this.db.exec({ sql, bind }); }
  private initialize(): void {
    if (this.initialized) return;
    this.write(`CREATE TEMP TABLE IF NOT EXISTS ${FINDINGS}(
      sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL,
      related_collection TEXT, related_id TEXT, expected INTEGER, actual INTEGER
    ) STRICT;
    CREATE TEMP TABLE IF NOT EXISTS ${EPOCH}(revision INTEGER NOT NULL) STRICT;`);
    if (!this.rows(`SELECT revision FROM ${EPOCH} LIMIT 1`).length) this.write(`INSERT INTO ${EPOCH} VALUES(0)`);
    for (const table of ['quixi_records', 'quixi_sync_ops'])
      for (const operation of ['INSERT', 'UPDATE', 'DELETE'])
        this.write(`CREATE TEMP TRIGGER IF NOT EXISTS ${EPOCH}_${table}_${operation} AFTER ${operation} ON main.${table} BEGIN UPDATE ${EPOCH} SET revision=revision+1; END;`);
    this.initialized = true;
  }
  private epoch(): number { return Number(this.rows(`SELECT revision FROM ${EPOCH} LIMIT 1`)[0]!.revision); }
  private externalVersion(): number { return Number(this.rows('PRAGMA data_version')[0]!.data_version); }
  private require(scanId: string): DoctorAuditStatus {
    if (this.closed || !this.current || this.current.scanId !== scanId) throw new BlobStorageError('NOT_FOUND', 'Doctor audit belongs to another scan or storage owner; start a new audit.');
    return this.current;
  }
  private snapshot(): DoctorAuditStatus { return { ...this.current!, counts: { ...this.current!.counts } }; }
  private refresh(scanId: string): DoctorAuditStatus {
    const state = this.require(scanId);
    if ((state.state === 'running' || state.state === 'complete') && (this.epoch() !== this.revision || this.externalVersion() !== this.dataVersion)) {
      state.state = 'stale'; state.updatedAt = Date.now(); state.message = 'Saved history changed; start a new audit.';
    }
    return state;
  }
  begin(scanId: string): DoctorAuditStatus {
    assertDoctorAuditArgs('beginDoctorAudit', { scanId });
    if (this.closed) throw new BlobStorageError('CONFLICT', 'Doctor audit owner is closed.');
    if (this.current?.scanId === scanId) return this.status(scanId);
    if (this.current && this.refresh(this.current.scanId).state === 'running') throw new BlobStorageError('CONFLICT', 'Stop the current Doctor audit before starting another.');
    this.initialize();
    this.source = 0; this.cursor = 0; this.sequence = 0; this.cleanup = true;
    this.revision = this.epoch(); this.dataVersion = this.externalVersion();
    const now = Date.now();
    this.current = { scanId, state: 'running', phase: 'preparing', startedAt: now, updatedAt: now, scannedRecords: 0, scannedOperations: 0,
      counts: Object.fromEntries(DOCTOR_AUDIT_KINDS.map(kind => [kind, 0])) as DoctorAuditStatus['counts'], message: null };
    return this.snapshot();
  }
  status(scanId: string): DoctorAuditStatus { assertDoctorAuditArgs('doctorAuditStatus', { scanId }); this.refresh(scanId); return this.snapshot(); }
  private finding(kind: DoctorAuditFindingKind, collection: string, recordId: string, related: { collection: string; id: string } | null = null, expected: number | null = null, actual: number | null = null): void {
    this.write(`INSERT INTO ${FINDINGS} VALUES(?,?,?,?,?,?,?,?)`, [++this.sequence, kind, collection, recordId, related?.collection ?? null, related?.id ?? null, expected, actual]);
    this.current!.counts[kind]++;
  }
  private exists(collection: string, recordId: unknown): boolean {
    return id(recordId) && !!this.rows('SELECT 1 FROM quixi_records WHERE collection=? AND id=? LIMIT 1', [collection, recordId]).length;
  }
  private field(collection: string, recordId: string, path: string): Value | undefined {
    const row = this.rows(`SELECT json_extract(payload,?) AS value FROM quixi_records WHERE collection=? AND id=?`, [path, collection, recordId])[0];
    return row ? row.value : undefined;
  }
  private auditMessage(messageId: string, r: Row): void {
    const threadId = r.thread_id as string | null, parentId = r.parent_id as string | null;
    if (parentId === messageId || r.edited_from === messageId) this.finding('self_reference', 'messages', messageId);
    else if (parentId !== null) {
      const parentThread = this.field('messages', parentId, '$.threadId');
      if (parentThread === undefined) this.finding('missing_parent', 'messages', messageId, { collection: 'messages', id: parentId });
      else if (parentThread !== threadId) this.finding('cross_thread_parent', 'messages', messageId, { collection: 'messages', id: parentId });
    }
    const editedFrom = r.edited_from as string | null;
    if (editedFrom !== null && editedFrom !== messageId && !this.exists('messages', editedFrom)) this.finding('edited_from_missing', 'messages', messageId, { collection: 'messages', id: editedFrom });
    const generationId = r.generation_id as string | null;
    if (generationId !== null) {
      const output = this.field('generations', generationId, '$.outputMessageId');
      if (output !== messageId) this.finding('generation_link_mismatch', 'messages', messageId, { collection: 'generations', id: generationId });
    }
    const declared = Number(r.part_count);
    const parts = this.rows("SELECT count(*) AS n, min(json_extract(payload,'$.order')) AS first, max(json_extract(payload,'$.order')) AS last FROM quixi_records WHERE collection='parts' AND message_id=?", [messageId])[0]!;
    const actual = Number(parts.n);
    if (actual !== declared || (declared > 0 && (Number(parts.first) !== 0 || Number(parts.last) !== declared - 1))) this.finding('part_count_mismatch', 'messages', messageId, null, declared, actual);
  }
  private auditThreadState(threadId: string, r: Row): void {
    const leaf = r.active_leaf as string | null;
    if (leaf !== null && this.field('messages', leaf, '$.threadId') !== threadId) this.finding('dangling_active_leaf', 'threadStates', threadId, { collection: 'messages', id: leaf });
    const context = r.context_id as string | null;
    if (!id(context) || this.field('contexts', context, '$.threadId') !== threadId) this.finding('missing_context', 'threadStates', threadId, context && id(context) ? { collection: 'contexts', id: context } : null);
  }
  private auditContext(contextId: string, r: Row): void {
    const previous = r.previous_id as string | null, version = Number(r.version);
    if (previous === null) { if (version !== 1) this.finding('context_chain_break', 'contexts', contextId, null, 1, version); return; }
    const previousVersion = this.field('contexts', previous, '$.version');
    if (previousVersion === undefined || Number(previousVersion) !== version - 1) this.finding('context_chain_break', 'contexts', contextId, { collection: 'contexts', id: previous }, version - 1, previousVersion === undefined ? null : Number(previousVersion));
  }
  private auditProvenance(provenanceId: string, r: Row): void {
    const importSourceId = r.import_source as string | null;
    if (!this.exists('importSources', importSourceId)) this.finding('missing_import_source', 'provenance', provenanceId, id(importSourceId) ? { collection: 'importSources', id: importSourceId } : null);
    const kind = String(r.entity_kind ?? ''), collection = COLLECTIONS[kind], entityId = r.entity_id as string | null;
    if (!collection || !this.exists(collection, entityId)) this.finding('missing_provenance_entity', 'provenance', provenanceId, collection && id(entityId) ? { collection, id: entityId } : null);
    const rawObjectId = r.raw_object as string | null;
    if (rawObjectId !== null && !this.exists('rawObjects', rawObjectId)) this.finding('missing_raw_object', 'provenance', provenanceId, id(rawObjectId) ? { collection: 'rawObjects', id: rawObjectId } : null);
  }
  private auditSyncOperation(operationId: string, affects: Value): void {
    let parsed: unknown;
    try { parsed = JSON.parse(String(affects)); } catch { parsed = undefined; }
    if (!Array.isArray(parsed)) { this.finding('sync_affects_malformed', 'sync_ops', operationId); return; }
    for (const entry of parsed.slice(0, 256)) {
      const reference = entry as { kind?: unknown; id?: unknown } | null;
      const collection = reference && typeof reference.kind === 'string' ? COLLECTIONS[reference.kind] : undefined;
      if (!collection || !id(reference?.id)) { this.finding('sync_affects_malformed', 'sync_ops', operationId); return; }
      if (!this.exists(collection, reference!.id)) this.finding('sync_affects_missing', 'sync_ops', operationId, { collection, id: reference!.id as string });
    }
  }
  /** One bounded row; phase and source transitions also consume work. */
  private step(): void {
    const state = this.current!;
    if (state.phase === 'preparing') {
      if (this.cleanup) { const row = this.rows(`SELECT rowid AS position FROM ${FINDINGS} ORDER BY rowid LIMIT 1`)[0]; if (row) { this.write(`DELETE FROM ${FINDINGS} WHERE rowid=?`, [row.position!]); return; } this.cleanup = false; }
      state.phase = 'branches'; return;
    }
    const source = SOURCES[this.source];
    if (!source) { state.state = 'complete'; state.phase = 'finished'; return; }
    state.phase = source.phase;
    if (source.table === 'quixi_sync_ops') {
      const row = this.rows('SELECT sequence AS position, operation_id, affects FROM quixi_sync_ops WHERE sequence>? ORDER BY sequence LIMIT 1', [this.cursor])[0];
      if (!row) { this.source++; this.cursor = 0; return; }
      this.cursor = Number(row.position); state.scannedOperations++;
      this.auditSyncOperation(String(row.operation_id), row.affects ?? null);
      return;
    }
    // Fixed scalar fields only; the payload itself never leaves SQL.
    const row = this.rows(`SELECT rowid AS position, id, thread_id, parent_id, generation_id,
        json_extract(payload,'$.editedFromMessageId') AS edited_from, json_extract(payload,'$.partCount') AS part_count,
        json_extract(payload,'$.activeLeafMessageId') AS active_leaf, json_extract(payload,'$.contextSnapshotId') AS context_id,
        json_extract(payload,'$.previousId') AS previous_id, json_extract(payload,'$.version') AS version,
        json_extract(payload,'$.importSourceId') AS import_source, json_extract(payload,'$.entityKind') AS entity_kind,
        json_extract(payload,'$.entityId') AS entity_id, json_extract(payload,'$.rawObjectId') AS raw_object, json_extract(payload,'$.quixiId') AS quixi_id
      FROM quixi_records WHERE collection=? AND rowid>? ORDER BY rowid LIMIT 1`, [source.collection, this.cursor])[0];
    if (!row) { this.source++; this.cursor = 0; return; }
    this.cursor = Number(row.position); state.scannedRecords++;
    const recordId = String(row.id);
    switch (source.collection) {
      case 'messages': this.auditMessage(recordId, row); break;
      case 'threadStates': this.auditThreadState(recordId, row); break;
      case 'threads':
        if (!this.exists('threadStates', recordId)) this.finding('thread_without_state', 'threads', recordId);
        if (row.import_source !== null && !this.exists('importSources', row.import_source)) this.finding('missing_import_source', 'threads', recordId, id(row.import_source) ? { collection: 'importSources', id: row.import_source } : null);
        break;
      case 'contexts': this.auditContext(recordId, row); break;
      case 'provenance': this.auditProvenance(recordId, row); break;
      case 'sourceIdentities': {
        const collection = COLLECTIONS[String(row.entity_kind ?? '')];
        if (!collection || !this.exists(collection, row.quixi_id)) this.finding('dangling_source_identity', 'sourceIdentities', recordId, collection && id(row.quixi_id) ? { collection, id: row.quixi_id } : null);
        break;
      }
      case 'documents':
        if (row.import_source !== null && !this.exists('importSources', row.import_source)) this.finding('missing_import_source', 'documents', recordId, id(row.import_source) ? { collection: 'importSources', id: row.import_source } : null);
        break;
    }
  }
  advance(scanId: string, maxItems: number, signal?: AbortSignal): DoctorAuditStatus {
    assertDoctorAuditArgs('advanceDoctorAudit', { scanId, maxItems });
    const state = this.refresh(scanId);
    if (state.state !== 'running') return this.snapshot();
    try {
      for (let count = 0; count < maxItems && state.state === 'running'; count++) {
        if (signal?.aborted) { this.cancel(scanId); break; }
        this.step();
        this.refresh(scanId);
      }
      if (signal?.aborted) this.cancel(scanId);
    } catch {
      state.state = signal?.aborted ? 'cancelled' : 'failed';
      state.message = signal?.aborted ? 'Doctor audit was cancelled.' : 'Doctor audit could not finish; start a new audit.';
    }
    state.updatedAt = Date.now();
    return this.snapshot();
  }
  findings(scanId: string, page: PageBudget): DoctorAuditPage {
    assertDoctorAuditArgs('readDoctorAuditFindings', { scanId, page });
    this.refresh(scanId);
    const prefix = `${scanId}:`;
    let after = 0;
    if (page.cursor !== null) {
      const value = page.cursor.startsWith(prefix) ? page.cursor.slice(prefix.length) : '';
      if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new BlobStorageError('INVALID_REQUEST', 'Invalid Doctor audit page cursor.');
      after = Number(value);
    }
    if (this.current!.phase === 'preparing') return { items: [], nextCursor: null, bytes: 2 };
    const items: DoctorAuditFinding[] = [];
    let bytes = 2;
    while (items.length < page.maxItems) {
      const row = this.rows(`SELECT * FROM ${FINDINGS} WHERE sequence>? ORDER BY sequence LIMIT 1`, [after])[0];
      if (!row) break;
      const item: DoctorAuditFinding = { sequence: Number(row.sequence), kind: row.kind as DoctorAuditFindingKind, collection: String(row.collection), id: String(row.id),
        relatedCollection: row.related_collection as string | null, relatedId: row.related_id as string | null,
        expected: row.expected === null ? null : Number(row.expected), actual: row.actual === null ? null : Number(row.actual) };
      const size = encoder.encode(JSON.stringify(item)).byteLength + (items.length ? 1 : 0);
      if (bytes + size > page.maxBytes) break;
      items.push(item); bytes += size; after = item.sequence;
    }
    const more = !!this.rows(`SELECT sequence FROM ${FINDINGS} WHERE sequence>? ORDER BY sequence LIMIT 1`, [after])[0];
    return { items, nextCursor: more ? `${prefix}${after}` : null, bytes };
  }
  cancel(scanId: string): DoctorAuditStatus {
    assertDoctorAuditArgs('cancelDoctorAudit', { scanId });
    const state = this.refresh(scanId);
    if (state.state === 'running' || state.state === 'complete') { state.state = 'cancelled'; state.updatedAt = Date.now(); state.message = 'Doctor audit was cancelled.'; }
    return this.snapshot();
  }
  close(): void { this.closed = true; this.current = null; }
}
