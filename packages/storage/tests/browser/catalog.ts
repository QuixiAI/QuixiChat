import initialize from "../../sqlite/dist/sqlite3.mjs";
import wasmUrl from "../../sqlite/dist/sqlite3.wasm?url";
import { BlobCatalog } from "../../src/worker/blob-catalog.ts";
import { OpfsBlobStore } from "../../src/worker/blobs.ts";
import { CanonicalRepository } from "../../src/worker/canonical/repository.ts";
import type { CanonicalSqlite } from "../../src/worker/canonical/repository.ts";
import type { MutationBatch } from "@quixi/core/contracts";

interface Database extends CanonicalSqlite { close(): void }
interface Pool { OpfsSAHPoolDb: new (file: string) => Database; pauseVfs(): void }
interface SQLite { installOpfsSAHPoolVfs(options: { name: string; directory: string; initialCapacity: number }): Promise<Pool> }
function assert(value: unknown, message: string): void { if (!value) throw new Error(message); }
const hash = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");

let sqliteModule: Promise<SQLite> | undefined;
/** The shipped module consumes one initialization state per worker. */
export function initializeTestSqlite(): Promise<SQLite> {
  if (!sqliteModule) {
    (globalThis as typeof globalThis & { sqlite3ApiConfig: unknown }).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
    sqliteModule = initialize({ locateFile: (file: string) => file.endsWith(".wasm") ? wasmUrl : file }) as Promise<SQLite>;
  }
  return sqliteModule;
}

export async function catalogAcceptance(namespace: string, restart: boolean): Promise<unknown> {
  const root = await navigator.storage.getDirectory();
  const quixi = await root.getDirectoryHandle(namespace, { create: true });
  const sqlite = await initializeTestSqlite();
  const pool = await sqlite.installOpfsSAHPoolVfs({ name: "quixi-blob-catalog-test", directory: `/${namespace}/database`, initialCapacity: 6 });
  const db = new pool.OpfsSAHPoolDb("/archive.sqlite3");
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  const bytes = await OpfsBlobStore.open(quixi); const catalog = new BlobCatalog(db, bytes);
  const checks: string[] = [];
  let failCommit = false;
  const repository = new CanonicalRepository(db, {
    assertBlobAvailable: (...args) => catalog.assertAvailable(...args),
    beforeCommit: () => { if (failCommit) throw new Error("Controlled canonical transaction failure"); },
  });
  try {
    repository.migrate(); catalog.initialize(); catalog.reconcileOwnerStart();
    if (restart) {
      const stagedRows = db.exec({ sql: "SELECT id,sha256,byte_length FROM quixi_blob_transfers WHERE state='verified'", rowMode: "object", returnValue: "resultRows" }) as { id: string; sha256: string; byte_length: number }[];
      assert(stagedRows.length === 1, "Verified stage did not survive owner loss");
      const restored = stagedRows[0]!;
      await catalog.preparePublication([restored.id]);
      catalog.assertAvailable(restored.sha256, restored.byte_length, []);
      await catalog.discard(restored.id);
      checks.push("verified staging resumes after restart and repairs an uncatalogued partial publication");
      const attachments = repository.readEntities({ collection: "attachments", threadId: null, page: { maxItems: 10, maxBytes: 100_000, cursor: null } });
      assert(attachments.items.length === 1, "Committed attachment metadata did not survive restart");
      const attachment = attachments.items[0] as { blobSha256: string; sizeBytes: number };
      const read = await catalog.openRead(attachment.blobSha256, () => crypto.randomUUID());
      const chunk = catalog.readChunk(read.transferId); catalog.acknowledge({ transferId: read.transferId, sequence: chunk.sequence, committedOffset: chunk.bytes.length });
      assert(new TextDecoder().decode(chunk.bytes) === "canonical long-text fixture 🌍", "Committed blob bytes did not survive restart");
      assert(db.selectValue("SELECT count(*) FROM quixi_blob_transfers WHERE state='interrupted'") === 1, "Unfinished durable transfer was not marked interrupted");
      assert(db.selectValue("PRAGMA integrity_check") === "ok", "Canonical database integrity failed");
      checks.push("canonical attachment and blob bytes survive process restart", "unfinished durable transfer is fenced on owner restart", "SQLite integrity is ok");
      return { checks };
    }
    const content = new TextEncoder().encode("canonical long-text fixture 🌍"); const digest = await hash(content);
    const beginArgs = { operationId: crypto.randomUUID(), purpose: "canonical_text" as const, expectedBytes: content.length, expectedSha256: digest };
    const transfer = await catalog.begin(beginArgs, () => crypto.randomUUID());
    assert((await catalog.begin(beginArgs, () => { throw new Error("Replay allocated another transfer"); })).transferId === transfer.transferId, "Begin replay changed identity");
    catalog.append({ transferId: transfer.transferId, sequence: 0, offset: 0, bytes: content, final: true });
    const finishArgs = { operationId: crypto.randomUUID(), transferId: transfer.transferId, expectedBytes: content.length, expectedSha256: digest };
    await catalog.finish(finishArgs); await catalog.finish(finishArgs);
    let unpublished = false; try { catalog.assertAvailable(digest, content.length, [transfer.transferId], "utf-8"); } catch { unpublished = true; }
    assert(unpublished, "Verified staging authorized a canonical reference before publication");
    await catalog.preparePublication([transfer.transferId]); catalog.assertAvailable(digest, content.length, [], "utf-8");
    checks.push("begin and finish replay retain transfer identity", "verified UTF-8 bytes precede canonical availability");
    const threadId = crypto.randomUUID(), contextId = crypto.randomUUID(), messageId = crypto.randomUUID(), attachmentId = crypto.randomUUID();
    const now = Date.now();
    const batch: MutationBatch = { transactionId: crypto.randomUUID(), expectedThreadRevisions: [], stagedBlobIds: [transfer.transferId], mutations: [
      { version: 1, operationId: crypto.randomUUID(), kind: "CreateThread", recordedAt: now, payload: {
        thread: { id: threadId, workspaceId: crypto.randomUUID(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
        context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
        state: { threadId, title: "Blob transaction fixture", tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
      } },
      { version: 1, operationId: crypto.randomUUID(), kind: "RegisterAttachment", recordedAt: now, payload: { attachment: { id: attachmentId, availability: "available", filename: "text.txt", mimeType: "text/plain", sizeBytes: content.length, blobSha256: digest, rawObjectId: null } } },
      { version: 1, operationId: crypto.randomUUID(), kind: "CreateMessage", recordedAt: now, payload: {
        message: { id: messageId, threadId, parentId: null, role: "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
        parts: [{ id: crypto.randomUUID(), messageId, order: 0, kind: "Text", data: { textBlob: { sha256: digest, byteLength: content.length, encoding: "utf-8" } } }],
      } },
    ] };
    failCommit = true; let rolledBack = false;
    try { repository.commit(batch); } catch { rolledBack = true; }
    assert(rolledBack && db.selectValue("SELECT count(*) FROM quixi_records") === 0 && db.selectValue("SELECT count(*) FROM quixi_sync_ops") === 0, "Canonical failure left partial references or operations");
    catalog.assertAvailable(digest, content.length, [], "utf-8");
    checks.push("canonical transaction failure rolls back references and every sync operation while preserving recoverable bytes");
    failCommit = false; repository.commit(batch);
    const cleanup = await catalog.consumeAfterCommit(batch.stagedBlobIds); assert(!cleanup.pendingCleanup.length, "Committed staging cleanup failed");
    assert(await catalog.cleanupImportTransfer(transfer.transferId), "Import cleanup failed on a consumed published transfer");
    await catalog.preparePublication([transfer.transferId]);
    catalog.assertAvailable(digest, content.length, [], "utf-8");
    checks.push("terminal import cleanup preserves published transfer identity for canonical retries");
    const replay = repository.committedTransaction(batch); assert(replay !== null, "Committed transaction was not recognized before stale staging replay");
    repository.commit(batch);
    assert(db.selectValue("SELECT count(*) FROM quixi_sync_ops") === 3, "Canonical replay duplicated operation log");
    checks.push("canonical commit publishes references and sync operations atomically", "replay after staging cleanup adds no duplicate mutations");
    const failingDb = {
      exec: (options: Parameters<Database["exec"]>[0]): unknown => {
        if (typeof options !== "string" && options.sql.startsWith("SELECT * FROM quixi_blob_transfers")) throw new Error("Controlled cleanup metadata read failure");
        return db.exec(options);
      },
    };
    const pending = await new BlobCatalog(failingDb, bytes).consumeAfterCommit([transfer.transferId]);
    assert(pending.pendingCleanup[0] === transfer.transferId && repository.committedTransaction(batch) !== null, "Postcommit cleanup obscured the committed result");
    checks.push("postcommit cleanup lookup failure preserves committed result");

    // Simulate failure in the SQL state update after the real OPFS handle opens.
    let failWritingUpdate = true;
    const beginFailureDb = {
      exec: (options: Parameters<Database["exec"]>[0]): unknown => {
        if (failWritingUpdate && typeof options !== "string" && options.sql.includes("SET state='writing'")) { failWritingUpdate = false; throw new Error("Controlled begin metadata update failure"); }
        return db.exec(options);
      },
    };
    let failedBegin = false;
    try { await new BlobCatalog(beginFailureDb, bytes).begin({ operationId: crypto.randomUUID(), purpose: "attachment", expectedBytes: 0, expectedSha256: null }, () => crypto.randomUUID()); } catch { failedBegin = true; }
    assert(failedBegin, "Begin metadata failure was not exercised");
    const openSlots = [];
    for (let i = 0; i < 8; i++) { const slot = crypto.randomUUID(); await bytes.begin(slot, null, null); openSlots.push(slot); }
    for (const slot of openSlots) await bytes.discard(slot);
    checks.push("failed begin metadata update releases the real byte handle");

    const finalized = [];
    for (let i = 0; i < 12; i++) {
      const staged = await catalog.begin({ operationId: crypto.randomUUID(), purpose: "canonical_text", expectedBytes: content.length, expectedSha256: digest }, () => crypto.randomUUID());
      catalog.append({ transferId: staged.transferId, sequence: 0, offset: 0, bytes: content, final: true });
      await catalog.finish({ operationId: crypto.randomUUID(), transferId: staged.transferId, expectedBytes: content.length, expectedSha256: digest });
      finalized.push(staged.transferId);
    }
    for (const staged of finalized) assert(await catalog.cleanupImportTransfer(staged), "Unpublished import staging cleanup failed");
    checks.push("finished stages release handles and do not cap an import at eight blobs");

    // Quarantine must retain the catalog row: it distinguishes published content
    // from the safe-to-repair, uncatalogued interrupted-copy case below.
    const catalogDirectory = await quixi.getDirectoryHandle("blobs");
    const contentDirectory = await catalogDirectory.getDirectoryHandle(digest.slice(0, 2));
    const contentFile = await contentDirectory.getFileHandle(digest);
    const raw = await (contentFile as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ write(bytes: Uint8Array): number; truncate(size: number): void; flush(): void; close(): void }> }).createSyncAccessHandle();
    raw.truncate(1); raw.write(new Uint8Array([0])); raw.flush(); raw.close();
    let corrupt = false; try { await catalog.openRead(digest, () => crypto.randomUUID()); } catch { corrupt = true; }
    assert(corrupt && db.selectValue("SELECT availability FROM quixi_blob_catalog WHERE sha256=?", [digest]) === "unverified", "Corruption did not quarantine retained metadata");
    let denied = false; try { catalog.assertAvailable(digest, content.length, [], "utf-8"); } catch { denied = true; }
    assert(denied, "Quarantined bytes authorized a new canonical reference");
    // Controlled repair restores the exact synthetic original; production repair
    // needs an explicit reference-aware recovery operation in plan 23.
    const repaired = await (contentFile as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ write(bytes: Uint8Array): number; truncate(size: number): void; flush(): void; close(): void }> }).createSyncAccessHandle();
    repaired.write(content); repaired.truncate(content.length); repaired.flush(); repaired.close();
    await catalog.verifyExisting(digest, content.length, "utf-8");
    catalog.assertAvailable(digest, content.length, [], "utf-8");
    checks.push("corrupt published bytes quarantine authorization until fresh verification");

    const orphanContent = new TextEncoder().encode("resumable verified publication"); const orphanHash = await hash(orphanContent);
    const orphan = await catalog.begin({ operationId: crypto.randomUUID(), purpose: "attachment", expectedBytes: orphanContent.length, expectedSha256: orphanHash }, () => crypto.randomUUID());
    catalog.append({ transferId: orphan.transferId, sequence: 0, offset: 0, bytes: orphanContent, final: true });
    await catalog.finish({ operationId: crypto.randomUUID(), transferId: orphan.transferId, expectedBytes: orphanContent.length, expectedSha256: orphanHash });
    const orphanDirectory = await catalogDirectory.getDirectoryHandle(orphanHash.slice(0, 2), { create: true });
    const orphanFile = await orphanDirectory.getFileHandle(orphanHash, { create: true });
    const partial = await (orphanFile as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{ write(bytes: Uint8Array): number; flush(): void; close(): void }> }).createSyncAccessHandle();
    partial.write(orphanContent.subarray(0, 3)); partial.flush(); partial.close();
    checks.push("interrupted-copy disk state retained for next-process repair test");
    const interrupted = await catalog.begin({ operationId: crypto.randomUUID(), purpose: "attachment", expectedBytes: null, expectedSha256: null }, () => crypto.randomUUID());
    catalog.append({ transferId: interrupted.transferId, sequence: 0, offset: 0, bytes: new Uint8Array([1]), final: false });
    return { checks, sha256: digest, byteLength: content.length, sqliteVersion: db.selectValue("SELECT sqlite_version()") };
  } finally { bytes.close(); try { db.close(); } finally { pool.pauseVfs(); } }
}
