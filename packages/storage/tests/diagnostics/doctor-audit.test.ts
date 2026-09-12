/** Plan 23: the Doctor audit finds branch, provenance and sync-coverage
 * damage planted directly in SQL (states the commit path refuses), in a
 * bounded, cancellable, stale-aware scan on real SQLite WASM. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import initialize from "../../sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../src/worker/canonical/index.ts";
import type { CanonicalSqlite } from "../../src/worker/canonical/index.ts";
import { DoctorAuditRepository } from "../../src/worker/doctor-audit.ts";
import { DOCTOR_AUDIT_KINDS } from "@quixi/core/contracts";
import type { CanonicalMutation, DoctorAuditFinding, DoctorAuditStatus } from "@quixi/core/contracts";

const wasm = await readFile(new URL("../../sqlite/dist/sqlite3.wasm", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../../sqlite/artifacts.json", import.meta.url), "utf8"));
assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.artifacts["sqlite3.wasm"].sha256);
(globalThis as any).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const initOptions = {
  instantiateWasm: async (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => { const result = await WebAssembly.instantiate(wasm, imports); success(result.instance, result.module); },
  print: () => {}, printErr: () => {},
};
const sqlite = (await initialize(initOptions)) as { oo1: { DB: new (name: string, flags: string) => CanonicalSqlite & { close(): void } } };
const id = () => randomUUID(), at = 1700000000000;
const mutation = (kind: CanonicalMutation["kind"], payload: unknown): CanonicalMutation => ({ version: 1, operationId: id(), kind, recordedAt: at, payload }) as CanonicalMutation;
function open() {
  const db = new sqlite.oo1.DB(`/doctor-${id()}.sqlite3`, "c");
  const canonical = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  canonical.migrate();
  const threadId = id(), contextId = id(), messageId = id(), partId = id();
  canonical.commit({ transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: [
    mutation("CreateThread", { thread: { id: threadId, workspaceId: id(), createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null }, context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: at }, state: { threadId, title: "Synthetic audit notebook", tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 } }),
    mutation("CreateMessage", { message: { id: messageId, threadId, parentId: null, role: "user", createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true }, parts: [{ id: partId, messageId, order: 0, kind: "Text", data: { text: "Synthetic audit text that must never appear in a finding." } }] }),
  ] });
  return { db, canonical, threadId, contextId, messageId, partId, audit: new DoctorAuditRepository(db) };
}
function run(audit: DoctorAuditRepository, scanId = id(), maxItems = 64): { status: DoctorAuditStatus; findings: DoctorAuditFinding[]; advances: number } {
  let status = audit.begin(scanId), advances = 0;
  while (status.state === "running") { status = audit.advance(scanId, maxItems); advances++; if (advances > 10_000) throw new Error("audit did not finish"); }
  const findings: DoctorAuditFinding[] = [];
  let cursor: string | null = null;
  do { const page = audit.findings(scanId, { maxItems: 8, maxBytes: 8192, cursor }); findings.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return { status, findings, advances };
}
const insert = (db: CanonicalSqlite, collection: string, record: Record<string, unknown>) => db.exec({ sql: "INSERT INTO quixi_records(collection,id,payload) VALUES(?,?,?)", bind: [collection, String(record.id ?? record.threadId), JSON.stringify(record)] });
const counts = (status: DoctorAuditStatus) => Object.fromEntries(Object.entries(status.counts).filter(([, value]) => value > 0));

test("a committed archive audits clean: every phase walked, no findings, bounded advances", () => {
  const { db, audit } = open();
  const { status, findings, advances } = run(audit, id(), 4);
  assert.equal(status.state, "complete"); assert.equal(status.phase, "finished");
  assert.deepEqual(counts(status), {}); assert.equal(findings.length, 0);
  assert.equal(status.scannedRecords, 4, "messages, threadStates, threads, contexts");
  assert.equal(status.scannedOperations, 2);
  assert.ok(advances >= 3, `advances ${advances}`);
  assert.deepEqual(Object.keys(status.counts), [...DOCTOR_AUDIT_KINDS]);
  db.close();
});

test("branch damage planted in SQL is found by kind with managed ids only", () => {
  const { db, audit, threadId, contextId, messageId } = open();
  const orphan = id(), foreignThread = id(), foreignMessage = id(), selfRef = id(), edited = id(), generated = id(), badContext = id(), stateless = id();
  insert(db, "messages", { id: orphan, threadId, parentId: id(), role: "user", createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 0, sealed: true });
  insert(db, "threads", { id: foreignThread, workspaceId: id(), createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null });
  insert(db, "messages", { id: foreignMessage, threadId: foreignThread, parentId: messageId, role: "user", createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 0, sealed: true });
  insert(db, "messages", { id: selfRef, threadId, parentId: selfRef, role: "user", createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 0, sealed: true });
  insert(db, "messages", { id: edited, threadId, parentId: null, role: "user", createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: id(), partCount: 0, sealed: true });
  insert(db, "messages", { id: generated, threadId, parentId: messageId, role: "assistant", createdAt: at, recordedAt: at, generationId: id(), editedFromMessageId: null, partCount: 0, sealed: true });
  // Canonical rows are immutable by trigger, so damage is planted as fresh rows: a message claiming three parts it does not have, and a thread whose state points at a foreign leaf and a missing context.
  const overcounted = id(), brokenThread = id();
  insert(db, "messages", { id: overcounted, threadId, parentId: messageId, role: "user", createdAt: at, recordedAt: at, generationId: null, editedFromMessageId: null, partCount: 3, sealed: true });
  insert(db, "threads", { id: brokenThread, workspaceId: id(), createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null });
  insert(db, "threadStates", { threadId: brokenThread, title: "Synthetic broken state", tags: [], pinned: false, archived: false, activeLeafMessageId: foreignMessage, contextSnapshotId: id(), routingProfile: null, revision: 0 });
  insert(db, "contexts", { id: badContext, threadId, previousId: contextId, version: 5, systemPrompt: null, preferredRoute: null, recordedAt: at });
  insert(db, "threads", { id: stateless, workspaceId: id(), createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null });
  const { status, findings } = run(audit);
  assert.equal(status.state, "complete");
  assert.deepEqual(counts(status), { missing_parent: 1, cross_thread_parent: 1, self_reference: 1, part_count_mismatch: 1, generation_link_mismatch: 1, edited_from_missing: 1, dangling_active_leaf: 1, missing_context: 1, thread_without_state: 2, context_chain_break: 1 });
  const byKind = Object.fromEntries(findings.map(finding => [finding.kind, finding]));
  assert.equal(byKind.missing_parent!.id, orphan); assert.equal(byKind.cross_thread_parent!.relatedId, messageId);
  assert.deepEqual([byKind.part_count_mismatch!.expected, byKind.part_count_mismatch!.actual], [3, 0]); assert.equal(byKind.part_count_mismatch!.id, overcounted);
  assert.deepEqual([byKind.context_chain_break!.expected, byKind.context_chain_break!.actual], [4, 1]);
  assert.equal(byKind.dangling_active_leaf!.relatedId, foreignMessage);
  assert.ok(!JSON.stringify(findings).includes("Synthetic"), "no text or title leaves the scan");
  db.close();
});

test("provenance and sync-coverage damage is found; a stale audit is reported after a canonical change", () => {
  const { db, audit, threadId, messageId } = open();
  const importSourceId = id(), provenanceId = id(), identityId = id(), documentId = id();
  insert(db, "importSources", { id: importSourceId, provider: "synthetic", method: "export", sourceThreadId: null, sourceUrl: null, importerName: "test", importerVersion: "1", sourceFormatVersion: null, sourceFingerprint: null, importedAt: at });
  insert(db, "provenance", { id: provenanceId, entityKind: "message", entityId: id(), importSourceId: id(), rawObjectId: id(), locator: null, sourceCreatedAtText: null, compatibility: [] });
  insert(db, "provenance", { id: id(), entityKind: "message", entityId: messageId, importSourceId, rawObjectId: null, locator: null, sourceCreatedAtText: null, compatibility: [] });
  insert(db, "sourceIdentities", { id: identityId, provider: "synthetic", accountScope: "a", sourceThreadId: null, sourceContainerKey: "c", entityKind: "thread", nativeId: "n", quixiId: id() });
  insert(db, "documents", { id: documentId, workspaceId: id(), attachmentId: id(), title: "Synthetic document title", createdAt: at, recordedAt: at, importSourceId: id() });
  const importedThread = id();
  insert(db, "threads", { id: importedThread, workspaceId: id(), createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: id() });
  insert(db, "threadStates", { threadId: importedThread, title: "Synthetic imported", tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: id(), routingProfile: null, revision: 0 });
  db.exec({ sql: "INSERT INTO quixi_sync_ops(operation_id,kind,recorded_at,identity,payload,affects,result) VALUES(?,?,?,?,?,?,?)", bind: [id(), "SetTitle", at, "x", "{}", JSON.stringify([{ kind: "threadState", id: threadId }, { kind: "message", id: id() }]), "{}"] });
  db.exec({ sql: "INSERT INTO quixi_sync_ops(operation_id,kind,recorded_at,identity,payload,affects,result) VALUES(?,?,?,?,?,?,?)", bind: [id(), "SetTitle", at, "x", "{}", JSON.stringify({ not: "a list" }), "{}"] });
  const { status, findings } = run(audit);
  assert.deepEqual(counts(status), { missing_context: 1, missing_import_source: 3, missing_provenance_entity: 1, missing_raw_object: 1, dangling_source_identity: 1, sync_affects_missing: 1, sync_affects_malformed: 1 });
  assert.equal(findings.filter(f => f.kind === "missing_import_source").map(f => f.collection).sort().join(","), "documents,provenance,threads");
  assert.equal(findings.find(f => f.kind === "sync_affects_missing")!.collection, "sync_ops");
  assert.ok(!JSON.stringify(findings).includes("Synthetic document title"));
  // The completed audit turns stale on the next canonical row.
  const scanId = id();
  let stale = audit.begin(scanId);
  while (stale.state === "running") stale = audit.advance(scanId, 64);
  assert.equal(stale.state, "complete");
  insert(db, "threads", { id: id(), workspaceId: id(), createdAt: at, recordedAt: at, systemPrompt: null, preferredRoute: null, importSourceId: null });
  assert.equal(audit.status(scanId).state, "stale");
  db.close();
});

test("cancellation, foreign scan identities, page cursors and closing are refused or reported plainly", () => {
  const { db, audit } = open();
  const scanId = id();
  audit.begin(scanId);
  assert.equal(audit.cancel(scanId).state, "cancelled");
  assert.equal(audit.advance(scanId, 8).state, "cancelled");
  assert.throws(() => audit.status(id()), /another scan/);
  const next = id(); audit.begin(next);
  assert.throws(() => audit.findings(next, { maxItems: 8, maxBytes: 4096, cursor: "bogus" }), /page cursor/);
  audit.close();
  assert.throws(() => audit.begin(id()), /closed/);
  db.close();
});
