/** Product §100 storage diagnostics and the §101 Doctor's read-only checks.
 * Every check classifies what it saw as one of the fixed outcomes so that
 * detected corruption, an unsupported capability, missing data and a
 * rebuildable derived index are never conflated (plan 23). The report holds
 * operational metadata only: counts, versions, states and managed digests;
 * SQL here extracts fixed scalar fields and never returns record content. */
import type { DiagnosticCheck, DiagnosticMeasure, DiagnosticOutcome, DiagnosticsReport, SearchIndexStatus, SemanticIndexStatus } from "@quixi/core/contracts";
import { assertDiagnosticsReportContent } from "@quixi/core/contracts";

export interface DiagnosticSqlite {
  exec(options: string | { sql: string; bind?: (string | number | null)[]; rowMode?: "object"; returnValue?: "resultRows" }): unknown;
  selectValue(sql: string, bind?: (string | number | null)[]): unknown;
}
export interface StorageCapabilities { fts5: boolean; vec: string | null }
export interface DiagnoseInput {
  db: DiagnosticSqlite;
  ownerId: string;
  schemaVersion: number;
  expectedSchemaVersion: number;
  capabilities: StorageCapabilities;
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
  search: {
    /** The tokenizer this build ships; without it derived chunking is refused, not broken. */
    tokenizerFailure: unknown;
    /** A derived-index initialization or maintenance failure retained by the owner. */
    failure: unknown;
    status: SearchIndexStatus | null;
    semantic: SemanticIndexStatus | null;
  };
  blobs: { publishedByteLength(sha256: string): Promise<number | null> };
  bounds?: { referenceRecords?: number; referenceFiles?: number };
}
export const DIAGNOSTIC_BOUNDS = Object.freeze({ referenceRecords: 4096, referenceFiles: 64, integrityErrors: 32 });
const REQUIRED_TABLES = ["quixi_records", "quixi_sync_ops", "quixi_blob_catalog", "quixi_blob_transfers", "quixi_blob_operations"] as const;
const rows = (db: DiagnosticSqlite, sql: string, bind: (string | number | null)[] = []) =>
  db.exec({ sql, bind, rowMode: "object", returnValue: "resultRows" }) as Record<string, unknown>[];
const check = (id: DiagnosticCheck["id"], outcome: DiagnosticOutcome, summary: string, measured: Record<string, DiagnosticMeasure> = {}): DiagnosticCheck => ({ id, outcome, summary, measured });
const reason = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};
/** Probes the running SQLite build. Both are compile-time facts of the bundled
 * WASM, so a negative answer means an unsupported host build, not damage. */
export function probeCapabilities(db: DiagnosticSqlite): StorageCapabilities {
  let fts5 = false, vec: string | null = null;
  try {
    db.exec("CREATE VIRTUAL TABLE temp.quixi_diagnostic_fts USING fts5(text)");
    db.exec("DROP TABLE temp.quixi_diagnostic_fts");
    fts5 = true;
  } catch { fts5 = false; }
  try { vec = String(db.selectValue("SELECT vec_version()")); } catch { vec = null; }
  return { fts5, vec };
}
/** The reference SQL mirrors the blob inventory's extraction of fixed scalar
 * fields (blob-inventory.ts): only digests and byte lengths leave the payload. */
const REFERENCE_SQL = `SELECT sha256, byte_length FROM (
  SELECT CASE WHEN collection='attachments' AND json_extract(payload,'$.availability')='available' THEN json_extract(payload,'$.blobSha256')
    WHEN collection='rawObjects' AND json_extract(payload,'$.availability')='available' THEN json_extract(payload,'$.sha256')
    WHEN collection='parts' THEN json_extract(payload,'$.data.textBlob.sha256') END AS sha256,
  CASE WHEN collection='attachments' THEN json_extract(payload,'$.sizeBytes')
    WHEN collection='rawObjects' THEN json_extract(payload,'$.byteLength')
    WHEN collection='parts' THEN json_extract(payload,'$.data.textBlob.byteLength') END AS byte_length
  FROM (SELECT collection,payload FROM quixi_records WHERE collection IN ('attachments','rawObjects','parts') ORDER BY rowid DESC LIMIT ?)
) WHERE sha256 IS NOT NULL`;
export async function diagnose(input: DiagnoseInput): Promise<DiagnosticsReport> {
  const { db } = input;
  const bounds = { referenceRecords: input.bounds?.referenceRecords ?? DIAGNOSTIC_BOUNDS.referenceRecords, referenceFiles: input.bounds?.referenceFiles ?? DIAGNOSTIC_BOUNDS.referenceFiles };
  const checks: DiagnosticCheck[] = [];
  // 1. SQLite integrity: the only check that can name corruption of the file itself.
  try {
    const found = rows(db, `PRAGMA integrity_check(${DIAGNOSTIC_BOUNDS.integrityErrors})`).map(row => String(Object.values(row)[0]));
    if (found.length === 1 && found[0] === "ok") checks.push(check("sqlite_integrity", "ok", "SQLite reports no damage in the database file.", { errors: 0 }));
    else checks.push(check("sqlite_integrity", "corruption", `SQLite found ${found.length}${found.length >= DIAGNOSTIC_BOUNDS.integrityErrors ? " or more" : ""} problems in the database file. Keep the file; export a backup before any repair.`, { errors: found.length, first: found[0]?.slice(0, 120) ?? null }));
  } catch (error) {
    checks.push(check("sqlite_integrity", "corruption", "SQLite could not complete its integrity check.", { errors: null, first: reason(error) }));
  }
  // 2. Canonical schema: required tables at this build's version.
  try {
    const present = new Set(rows(db, "SELECT name FROM sqlite_schema WHERE type='table'").map(row => String(row.name)));
    const missing = REQUIRED_TABLES.filter(table => !present.has(table));
    if (missing.length) checks.push(check("schema", "corruption", "Canonical tables are missing from the database.", { schemaVersion: input.schemaVersion, expectedSchemaVersion: input.expectedSchemaVersion, missingTables: missing.join(",") }));
    else if (input.schemaVersion !== input.expectedSchemaVersion) checks.push(check("schema", "attention", "The archive's schema version differs from this build's.", { schemaVersion: input.schemaVersion, expectedSchemaVersion: input.expectedSchemaVersion, missingTables: "" }));
    else checks.push(check("schema", "ok", "The canonical schema is at this build's version with every required table present.", { schemaVersion: input.schemaVersion, expectedSchemaVersion: input.expectedSchemaVersion, missingTables: "" }));
  } catch (error) {
    checks.push(check("schema", "corruption", "The database schema could not be read.", { schemaVersion: input.schemaVersion, expectedSchemaVersion: input.expectedSchemaVersion, missingTables: reason(error) }));
  }
  // 3. OPFS persistence: a browser grant, not a property of the data.
  const storageMeasure = { persisted: input.persisted, usage: input.usage, quota: input.quota };
  if (input.persisted === true) checks.push(check("persistence", "ok", "Persistent storage is granted; the browser will not evict this data under storage pressure.", storageMeasure));
  else if (input.persisted === false) checks.push(check("persistence", "attention", "Persistent storage is not granted; the browser may remove local data under storage pressure. Request it from Storage health.", storageMeasure));
  else checks.push(check("persistence", "unknown", "This host does not report whether storage is persistent.", storageMeasure));
  // 4/5. Capabilities: compile-time facts of the bundled SQLite.
  checks.push(input.capabilities.fts5
    ? check("fts5", "ok", "FTS5 is available for exact search.", { available: true })
    : check("fts5", "unsupported", "This build's SQLite has no FTS5, so exact search cannot be indexed here. Nothing is damaged.", { available: false }));
  checks.push(input.capabilities.vec
    ? check("sqlite_vec", "ok", "sqlite-vec is available for semantic search.", { available: true, version: input.capabilities.vec })
    : check("sqlite_vec", "unsupported", "This build's SQLite has no sqlite-vec, so semantic search cannot be indexed here. Nothing is damaged.", { available: false, version: null }));
  // 6. Attachment references: bounded, newest records first; the full walk is the storage scan.
  try {
    const total = Number(db.selectValue("SELECT count(*) FROM quixi_records WHERE collection IN ('attachments','rawObjects','parts')"));
    const references = rows(db, REFERENCE_SQL, [bounds.referenceRecords]) as { sha256: string; byte_length: number | null }[];
    let missingCatalog = 0, catalogMismatch = 0, malformed = 0;
    const digests = new Map<string, number | null>();
    for (const row of references) {
      if (typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) { malformed++; continue; }
      const catalog = rows(db, "SELECT byte_length FROM quixi_blob_catalog WHERE sha256=?", [row.sha256])[0];
      if (!catalog) missingCatalog++;
      else if (row.byte_length !== null && Number(catalog.byte_length) !== Number(row.byte_length)) catalogMismatch++;
      if (!digests.has(row.sha256)) digests.set(row.sha256, row.byte_length === null ? null : Number(row.byte_length));
    }
    let checkedFiles = 0, missingFiles = 0, sizeMismatch = 0;
    for (const [sha256, expected] of digests) {
      if (checkedFiles >= bounds.referenceFiles) break;
      checkedFiles++;
      const size = await input.blobs.publishedByteLength(sha256);
      if (size === null) missingFiles++;
      else if (expected !== null && size !== expected) sizeMismatch++;
    }
    const measured = { records: total, examinedRecords: Math.min(total, bounds.referenceRecords), references: references.length, distinctDigests: digests.size, checkedFiles, missingCatalog, catalogMismatch, missingFiles, sizeMismatch, malformed, complete: total <= bounds.referenceRecords && digests.size <= bounds.referenceFiles };
    if (malformed) checks.push(check("attachment_references", "corruption", "A saved record carries a malformed file reference.", measured));
    else if (missingCatalog || missingFiles) checks.push(check("attachment_references", "missing_data", "Saved records refer to file bytes this device does not hold. History stays readable; the bytes are only in an earlier backup.", measured));
    else if (catalogMismatch || sizeMismatch) checks.push(check("attachment_references", "attention", "A stored file's size differs from what its record expects. Preserve the file and compare with a backup.", measured));
    else checks.push(check("attachment_references", "ok", measured.complete ? "Every attachment, raw-source and text reference has its stored file." : "Every checked reference has its stored file; the storage scan covers the rest.", measured));
  } catch (error) {
    checks.push(check("attachment_references", "corruption", "Attachment references could not be read.", { first: reason(error) }));
  }
  // 7. Ownership: this report was answered by the single owner of the archive.
  checks.push(check("ownership", "ok", "One storage owner holds this archive and answered this report; other tabs forward to it.", { ownerId: input.ownerId }));
  // 8. Lexical (FTS) index: derived and rebuildable; its failure never touches canonical rows.
  const { search } = input;
  if (search.tokenizerFailure) checks.push(check("lexical_index", "unsupported", "This host build has no chunk tokenizer, so the search index cannot be built here. Nothing is damaged.", { reason: reason(search.tokenizerFailure) }));
  else if (!input.capabilities.fts5) checks.push(check("lexical_index", "unsupported", "The search index needs FTS5, which this build lacks.", { reason: "fts5" }));
  else if (search.failure) checks.push(check("lexical_index", "rebuildable", "The derived search index failed and is disabled until rebuilt. Canonical history is intact; Rebuild search index recreates it.", { reason: reason(search.failure), state: "failed" }));
  else if (!search.status) checks.push(check("lexical_index", "unknown", "The search index did not report its status.", {}));
  else {
    const status = search.status;
    const measured = { state: status.state, version: status.version, indexedChunks: status.indexedChunks, pendingSources: status.pendingSources, failedSources: status.failedSources, activeEpoch: status.activeEpoch, rebuildingEpoch: status.rebuildingEpoch, lastFailure: status.lastFailure ? `${status.lastFailure.code}: ${status.lastFailure.reason}`.slice(0, 200) : null };
    if (status.state === "failed") checks.push(check("lexical_index", "rebuildable", "The search index reports a failure. Rebuild search index recreates it from canonical history.", measured));
    else if (status.failedSources > 0) checks.push(check("lexical_index", "attention", "Some sources could not be indexed; their messages are still stored. Rebuild search index retries them.", measured));
    else checks.push(check("lexical_index", "ok", status.state === "ready" ? "The search index is complete and current." : `The search index is ${status.state}; queued work continues in the background.`, measured));
  }
  // 9. Semantic index: optional and derived; never enrolled is healthy.
  if (!input.capabilities.vec) checks.push(check("semantic_index", "unsupported", "Semantic search needs sqlite-vec, which this build lacks.", { reason: "sqlite-vec" }));
  else if (search.failure) checks.push(check("semantic_index", "rebuildable", "Semantic data shares the failed derived index; rebuilding search recreates its namespace and Rebuild semantic index re-embeds.", { reason: reason(search.failure) }));
  else if (!search.semantic) checks.push(check("semantic_index", "unknown", "The semantic index did not report its status.", {}));
  else {
    const semantic = search.semantic;
    const measured = { state: semantic.state, generation: semantic.generation, indexedChunks: semantic.indexedChunks, pendingChunks: semantic.pendingChunks, vectors: semantic.vectors, projectionComplete: semantic.projection.complete, coarseRetrieval: semantic.projection.coarseRetrieval };
    if (semantic.state === "disabled") checks.push(check("semantic_index", "ok", semantic.vectors ? "Semantic search is not enabled; stored vectors are unused until it is." : "Semantic search is not enabled on this archive.", measured));
    else checks.push(check("semantic_index", "ok", semantic.pendingChunks ? `Semantic search is ${semantic.state} with ${semantic.pendingChunks} chunks still to embed.` : `Semantic search is ${semantic.state} and every visible chunk has a vector.`, measured));
  }
  const report: DiagnosticsReport = {
    version: 1, producedAt: Date.now(), backend: "sqlite-wasm-opfs-sahpool",
    sqliteVersion: String(db.selectValue("SELECT sqlite_version()")), schemaVersion: input.schemaVersion, ownerId: input.ownerId,
    bounds, checks, contentPolicy: "operational-metadata-only",
  };
  assertDiagnosticsReportContent(report);
  return report;
}
