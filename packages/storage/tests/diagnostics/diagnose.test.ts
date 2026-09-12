/** Plan 23: the diagnostics report classifies what it sees. Each outcome is
 * produced from a real state of a real SQLite WASM database (the bundled
 * build with FTS5 and sqlite-vec) except the unsupported-capability cases,
 * which are stated inputs because this build has both extensions. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import initialize from "../../sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../src/worker/canonical/index.ts";
import type { CanonicalSqlite } from "../../src/worker/canonical/index.ts";
import { CANONICAL_MIGRATIONS } from "../../migrations/index.ts";
import { DIAGNOSTIC_BOUNDS, diagnose, probeCapabilities } from "../../src/worker/diagnostics.ts";
import type { DiagnoseInput } from "../../src/worker/diagnostics.ts";
import { DIAGNOSTIC_CHECKS, assertDiagnosticsReportContent } from "@quixi/core/contracts";
import type { CanonicalMutation, DiagnosticsReport, SearchIndexStatus, SemanticIndexStatus } from "@quixi/core/contracts";

const wasm = await readFile(new URL("../../sqlite/dist/sqlite3.wasm", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../../sqlite/artifacts.json", import.meta.url), "utf8"));
assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.artifacts["sqlite3.wasm"].sha256);
(globalThis as any).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const initOptions = {
  instantiateWasm: async (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
    const result = await WebAssembly.instantiate(wasm, imports);
    success(result.instance, result.module);
  },
  print: () => {}, printErr: () => {},
};
const sqlite = (await initialize(initOptions)) as { oo1: { DB: new (name: string, flags: string) => CanonicalSqlite & { close(): void } } };
const id = () => randomUUID();
const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
type Db = CanonicalSqlite & { close(): void };
function open(name = `/diagnostics-${id()}.sqlite3`) {
  const db = new sqlite.oo1.DB(name, "c");
  const canonical = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  const schemaVersion = canonical.migrate();
  return { db, canonical, schemaVersion, name };
}
function attach(canonical: CanonicalRepository, sha256: string, sizeBytes: number) {
  const mutation = { version: 1, operationId: id(), kind: "RegisterAttachment", recordedAt: 1700000000000,
    payload: { attachment: { id: id(), availability: "available", filename: "synthetic.txt", mimeType: "text/plain", sizeBytes, blobSha256: sha256, rawObjectId: null } } } as CanonicalMutation;
  canonical.commit({ transactionId: id(), mutations: [mutation], expectedThreadRevisions: [], stagedBlobIds: [] });
}
const catalog = (db: Db, sha256: string, byteLength: number) =>
  db.exec({ sql: "INSERT INTO quixi_blob_catalog(sha256,byte_length,utf8_verified,availability,verification_epoch) VALUES(?,?,0,'verified',0)", bind: [sha256, byteLength] });
const readyStatus: SearchIndexStatus = { state: "ready", version: "test", indexedChunks: 12, pendingSources: 0, failedSources: 0, activeEpoch: 1, rebuildingEpoch: null, revision: 3, semantic: { state: "ready", reason: null }, activeSource: null, lastFailure: null };
const disabledSemantic: SemanticIndexStatus = { state: "disabled", model: null, generation: 0, indexedChunks: 0, pendingChunks: 0, vectors: 0, vectorBytes: 0, projection: { representation: "sign-bit-v1", bytesPerVector: 48, candidates: 5000, projected: 0, complete: true, coarseRetrieval: false, threshold: 100000, residentBytes: 0 } };
function input(db: Db, schemaVersion: number, files: Map<string, number>, overrides: Partial<DiagnoseInput> = {}): DiagnoseInput {
  return {
    db, ownerId: "owner-1", schemaVersion, expectedSchemaVersion: CANONICAL_MIGRATIONS.length,
    capabilities: probeCapabilities(db), persisted: true, usage: 1024, quota: 1 << 30,
    search: { tokenizerFailure: undefined, failure: undefined, status: readyStatus, semantic: disabledSemantic },
    blobs: { publishedByteLength: async sha256 => files.get(sha256) ?? null },
    ...overrides,
  };
}
const outcome = (report: DiagnosticsReport, check: DiagnosticsReport["checks"][number]["id"]) => report.checks.find(entry => entry.id === check)!;

test("the bundled SQLite build has FTS5 and sqlite-vec", () => {
  const { db } = open();
  const capabilities = probeCapabilities(db);
  assert.equal(capabilities.fts5, true);
  assert.match(String(capabilities.vec), /^v?\d+\.\d+\.\d+/);
  db.close();
});

test("a healthy archive reports every check ok, in product §100 order, with operational metadata only", async () => {
  const { db, canonical, schemaVersion } = open();
  const text = "Synthetic attachment bytes", sha256 = digestOf(text);
  catalog(db, sha256, text.length); attach(canonical, sha256, text.length);
  const report = await diagnose(input(db, schemaVersion, new Map([[sha256, text.length]])));
  assert.deepEqual(report.checks.map(check => check.id), [...DIAGNOSTIC_CHECKS]);
  assert.deepEqual(report.checks.map(check => check.outcome), DIAGNOSTIC_CHECKS.map(() => "ok"));
  assert.equal(report.contentPolicy, "operational-metadata-only");
  assert.equal(report.schemaVersion, CANONICAL_MIGRATIONS.length);
  assert.deepEqual(outcome(report, "attachment_references").measured, { records: 1, examinedRecords: 1, references: 1, distinctDigests: 1, checkedFiles: 1, missingCatalog: 0, catalogMismatch: 0, missingFiles: 0, sizeMismatch: 0, malformed: 0, complete: true });
  assert.doesNotThrow(() => assertDiagnosticsReportContent(report));
  assert.ok(!JSON.stringify(report).includes("synthetic.txt"), "no filename leaves the report");
  db.close();
});

test("missing data: a referenced file absent from the catalog or from storage is missing_data, not corruption", async () => {
  const { db, canonical, schemaVersion } = open();
  const held = digestOf("held"), uncatalogued = digestOf("uncatalogued"), unstored = digestOf("unstored");
  catalog(db, held, 4); catalog(db, unstored, 8);
  attach(canonical, held, 4); attach(canonical, uncatalogued, 12); attach(canonical, unstored, 8);
  const report = await diagnose(input(db, schemaVersion, new Map([[held, 4]])));
  const references = outcome(report, "attachment_references");
  assert.equal(references.outcome, "missing_data");
  assert.equal(references.measured.missingCatalog, 1);
  assert.equal(references.measured.missingFiles, 2);
  assert.equal(outcome(report, "sqlite_integrity").outcome, "ok");
  assert.equal(outcome(report, "lexical_index").outcome, "ok");
  db.close();
});

test("a stored file whose size differs from its record needs attention", async () => {
  const { db, canonical, schemaVersion } = open();
  const sha256 = digestOf("short");
  catalog(db, sha256, 5); attach(canonical, sha256, 5);
  const report = await diagnose(input(db, schemaVersion, new Map([[sha256, 3]])));
  assert.equal(outcome(report, "attachment_references").outcome, "attention");
  assert.equal(outcome(report, "attachment_references").measured.sizeMismatch, 1);
  db.close();
});

test("the reference check is bounded and says so", async () => {
  const { db, canonical, schemaVersion } = open();
  const files = new Map<string, number>();
  for (let index = 0; index < 6; index++) { const sha256 = digestOf(`bounded ${index}`); catalog(db, sha256, 1); attach(canonical, sha256, 1); files.set(sha256, 1); }
  const report = await diagnose(input(db, schemaVersion, files, { bounds: { referenceRecords: 4, referenceFiles: 2 } }));
  const references = outcome(report, "attachment_references");
  assert.equal(references.outcome, "ok");
  assert.equal(references.measured.examinedRecords, 4);
  assert.equal(references.measured.checkedFiles, 2);
  assert.equal(references.measured.complete, false);
  assert.match(references.summary, /storage scan covers the rest/);
  assert.deepEqual(report.bounds, { referenceRecords: 4, referenceFiles: 2 });
  assert.equal(DIAGNOSTIC_BOUNDS.referenceRecords, 4096);
  db.close();
});

test("rebuildable: a retained derived-index failure is rebuildable while integrity and schema stay ok", async () => {
  const { db, schemaVersion } = open();
  const failure = new Error("Derived search schema is unsupported or changed; rebuild the search index while preserving canonical history.");
  const report = await diagnose(input(db, schemaVersion, new Map(), { search: { tokenizerFailure: undefined, failure, status: null, semantic: null } }));
  assert.equal(outcome(report, "lexical_index").outcome, "rebuildable");
  assert.equal(outcome(report, "semantic_index").outcome, "rebuildable");
  assert.equal(outcome(report, "sqlite_integrity").outcome, "ok");
  assert.equal(outcome(report, "schema").outcome, "ok");
  assert.match(String(outcome(report, "lexical_index").measured.reason), /rebuild the search index/);
  db.close();
});

test("a failed index status or failed sources classify as rebuildable and attention", async () => {
  const { db, schemaVersion } = open();
  const failed = await diagnose(input(db, schemaVersion, new Map(), { search: { tokenizerFailure: undefined, failure: undefined, status: { ...readyStatus, state: "failed" }, semantic: disabledSemantic } }));
  assert.equal(outcome(failed, "lexical_index").outcome, "rebuildable");
  const partial = await diagnose(input(db, schemaVersion, new Map(), { search: { tokenizerFailure: undefined, failure: undefined, status: { ...readyStatus, failedSources: 2, lastFailure: { sourceId: id(), code: "IO_ERROR", reason: "read failed" } }, semantic: disabledSemantic } }));
  assert.equal(outcome(partial, "lexical_index").outcome, "attention");
  assert.equal(outcome(partial, "lexical_index").measured.lastFailure, "IO_ERROR: read failed");
  db.close();
});

test("unsupported: absent FTS5, sqlite-vec or the chunk tokenizer are unsupported capabilities, never damage", async () => {
  const { db, schemaVersion } = open();
  const report = await diagnose(input(db, schemaVersion, new Map(), { capabilities: { fts5: false, vec: null }, search: { tokenizerFailure: new Error("The chunk tokenizer is unavailable"), failure: undefined, status: null, semantic: null } }));
  for (const check of ["fts5", "sqlite_vec", "lexical_index", "semantic_index"] as const) assert.equal(outcome(report, check).outcome, "unsupported", check);
  assert.equal(outcome(report, "sqlite_integrity").outcome, "ok");
  db.close();
});

test("persistence: granted, refused and unreported are ok, attention and unknown", async () => {
  const { db, schemaVersion } = open();
  for (const [persisted, expected] of [[true, "ok"], [false, "attention"], [null, "unknown"]] as const)
    assert.equal(outcome(await diagnose(input(db, schemaVersion, new Map(), { persisted })), "persistence").outcome, expected);
  db.close();
});

test("corruption: unreferenced b-tree pages left by a schema edit are reported by integrity_check as corruption, and the schema check is separate", async () => {
  const first = open();
  // A real inconsistency: an index's pages remain allocated after its schema
  // row is removed, so integrity_check reports pages that are never used.
  first.db.exec("CREATE INDEX quixi_fixture_damage ON quixi_records(collection)");
  first.db.exec("PRAGMA writable_schema=ON");
  first.db.exec("DELETE FROM sqlite_master WHERE type='index' AND name='quixi_fixture_damage'");
  first.db.exec("PRAGMA writable_schema=OFF");
  first.db.close();
  const second = new sqlite.oo1.DB(first.name, "w");
  const report = await diagnose(input(second, first.schemaVersion, new Map()));
  const integrity = outcome(report, "sqlite_integrity");
  assert.equal(integrity.outcome, "corruption");
  assert.ok(Number(integrity.measured.errors) >= 1);
  assert.match(String(integrity.measured.first), /never used/);
  assert.equal(outcome(report, "schema").outcome, "ok");
  assert.equal(outcome(report, "lexical_index").outcome, "ok");
  second.close();
});

test("corruption: a missing canonical table is schema corruption", async () => {
  const { db, schemaVersion } = open();
  db.exec("DROP TABLE quixi_blob_operations");
  const report = await diagnose(input(db, schemaVersion, new Map()));
  assert.equal(outcome(report, "schema").outcome, "corruption");
  assert.equal(outcome(report, "schema").measured.missingTables, "quixi_blob_operations");
  db.close();
});

test("a malformed blob reference in a saved record is corruption of that record", async () => {
  const { db, schemaVersion } = open();
  const attachmentId = id();
  db.exec({ sql: "INSERT INTO quixi_records(collection,id,payload) VALUES('attachments',?,?)", bind: [attachmentId, JSON.stringify({ id: attachmentId, availability: "available", filename: "x", mimeType: "text/plain", sizeBytes: 1, blobSha256: "not-a-digest", rawObjectId: null })] });
  const report = await diagnose(input(db, schemaVersion, new Map()));
  assert.equal(outcome(report, "attachment_references").outcome, "corruption");
  assert.equal(outcome(report, "attachment_references").measured.malformed, 1);
  db.close();
});
