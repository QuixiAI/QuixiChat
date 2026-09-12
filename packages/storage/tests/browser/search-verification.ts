import { initializeTestSqlite } from "./catalog.ts";
import { BlobCatalog } from "../../src/worker/blob-catalog.ts";
import { OpfsBlobStore } from "../../src/worker/blobs.ts";
import { CanonicalRepository } from "../../src/worker/canonical/repository.ts";
import type { CanonicalSqlite } from "../../src/worker/canonical/repository.ts";
import { SearchRepository } from "../../src/worker/search/index.ts";
import type { SearchBlobAccess } from "../../src/worker/search/index.ts";
import type { MutationBatch } from "@quixi/core/contracts";

interface Database extends CanonicalSqlite { close(): void }
interface Pool { OpfsSAHPoolDb: new (file: string) => Database; pauseVfs(): void }
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const id = () => crypto.randomUUID();
const hash = async (value: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(n => n.toString(16).padStart(2, "0")).join("");
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const threadId = "e85450b9-6711-4f47-a9ec-c42ccf6a5591";
const contextId = "e85450b9-6711-4f47-a9ec-c42ccf6a5592";
const messageId = "e85450b9-6711-4f47-a9ec-c42ccf6a5593";
const partId = "e85450b9-6711-4f47-a9ec-c42ccf6a5594";
// Strong references deliberately keep the write-phase owner alive until the
// runner terminates its process. There is no graceful close before restart.
let retainedOwner: { db: Database; pool: Pool; bytes: OpfsBlobStore; search: SearchRepository } | null = null;

/** Real SQLite/OPFS proof. The adapter records budgets; all byte work is real. */
export async function searchVerificationAcceptance(namespace: string, restart: boolean): Promise<unknown> {
  assert(retainedOwner === null, "Previous verification owner is still alive");
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(namespace, { create: true });
  const sqlite = await initializeTestSqlite();
  const pool = await sqlite.installOpfsSAHPoolVfs({ name: "quixi-search-verification-test", directory: `/${namespace}/database`, initialCapacity: 6 });
  const db = new pool.OpfsSAHPoolDb("/archive.sqlite3");
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  const bytes = await OpfsBlobStore.open(directory);
  const catalog = new BlobCatalog(db, bytes);
  const canonical = new CanonicalRepository(db, { assertBlobAvailable: (...args) => catalog.assertAvailable(...args) });
  const checks: string[] = [];
  const begins: Array<{ transferId: string; verifiedBytes: number; complete: boolean }> = [];
  const verification: Array<{ admission: number; maxBytes: number; before: number; after: number; complete: boolean; foregroundCompleted: boolean }> = [];
  const cursors = new Map<string, number>();
  let admission = 0, foregroundReads = 0, foregroundCompleted = false;
  const access: SearchBlobAccess = {
    openRead: (...args) => catalog.openRead(...args),
    beginVerifiedRead: async (...args) => {
      const result = await catalog.beginVerifiedRead(...args);
      begins.push({ transferId: result.transferId, verifiedBytes: result.verifiedBytes, complete: result.complete });
      cursors.set(result.transferId, result.verifiedBytes);
      return result;
    },
    advanceVerifiedRead: async (transferId, maxBytes, signal) => {
      const before = cursors.get(transferId)!;
      const result = await catalog.advanceVerifiedRead(transferId, maxBytes, signal);
      verification.push({ admission, maxBytes, before, after: result.verifiedBytes, complete: result.complete, foregroundCompleted });
      cursors.set(transferId, result.verifiedBytes);
      return result;
    },
    sliceRead: (...args) => catalog.sliceRead(...args),
    readChunk: (...args) => catalog.readChunk(...args),
    acknowledge: (...args) => catalog.acknowledge(...args),
    discard: (...args) => catalog.discard(...args),
  };
  const search = new SearchRepository(db, access);
  const text = "padding ".repeat(262144) + "\n\ntailneedle verified original canonical text 🌍";
  const content = new TextEncoder().encode(text), digest = await hash(content);
  const query = () => search.search({ query: "tailneedle", mode: "exact", filters: {}, page: { maxItems: 8, maxBytes: 100000, cursor: null } });
  const inventory = async () => {
    const records = db.exec({ sql: "SELECT collection,id,payload FROM quixi_records ORDER BY collection,id", rowMode: "object", returnValue: "resultRows" }) as unknown[];
    const operations = db.exec({ sql: "SELECT * FROM quixi_sync_ops ORDER BY operation_id", rowMode: "object", returnValue: "resultRows" }) as unknown[];
    return { records: records.length, operations: operations.length, recordsSha256: await hash(encode(records)), operationsSha256: await hash(encode(operations)) };
  };
  const foreground = () => {
    const page = canonical.readEntities({ collection: "messages", threadId, page: { maxItems: 8, maxBytes: 100000, cursor: null } });
    assert(page.items.length === 1 && page.nextCursor === null && (page.items[0] as { id: string }).id === messageId, "Foreground canonical read lost the original message");
    foregroundReads++;
  };
  const advance = async (signal?: AbortSignal) => {
    admission++;
    const start = verification.length;
    await search.advance({ maxChunks: 128 }, signal);
    const steps = verification.slice(start);
    assert(steps.reduce((sum, step) => sum + step.maxBytes, 0) <= 131072, "One indexing admission exceeded 128 KiB verification allowance");
    for (const step of steps) {
      assert(step.maxBytes > 0 && step.maxBytes <= 131072, "Unbounded hash request");
      if (!step.foregroundCompleted) assert(step.after >= step.before && step.after - step.before <= step.maxBytes, "Actual hash progress exceeded its admission");
    }
    foreground();
  };
  const pending = async () => {
    for (let turns = 0; turns < 50; turns++) {
      await advance();
      if (search.status().activeSource?.phase === "verifying") return search.status();
    }
    throw new Error("No pending real blob verifier was reached");
  };
  const drain = async () => {
    for (let turns = 0; turns < 2000; turns++) {
      const status = search.status();
      if (status.state === "ready") return status;
      assert(status.failedSources === 0, `Indexing source failed: ${JSON.stringify(status.lastFailure)}`);
      await advance();
    }
    throw new Error("Real blob indexing exceeded its bounded test turns");
  };
  const assertHit = () => {
    const result = query();
    assert(result.items.length === 1 && result.nextCursor === null, "Tail query did not identify exactly one result");
    const hit = result.items[0]!;
    assert(hit.threadId === threadId && hit.messageId === messageId && hit.position.partId === partId, "Tail query lost canonical location");
    assert(text.slice(hit.position.start, hit.position.end).includes("tailneedle"), "Tail hit has incorrect original-text offsets");
    assert(hit.excerpt.highlights.some(range => hit.excerpt.text.slice(range.start, range.end) === "tailneedle"), "Tail hit lacks an exact highlighted match");
    return { chunkId: hit.chunkId, threadId: hit.threadId, messageId: hit.messageId, position: hit.position };
  };
  let retain = false;
  try {
    canonical.migrate(); catalog.initialize(); catalog.reconcileOwnerStart();
    search.initialize();
    if (!restart) {
      const transfer = await catalog.begin({ operationId: id(), purpose: "canonical_text", expectedBytes: content.length, expectedSha256: digest }, id);
      for (let offset = 0, sequence = 0; offset < content.length; sequence++) {
        const chunk = content.slice(offset, offset + 65536);
        catalog.append({ transferId: transfer.transferId, sequence, offset, bytes: chunk, final: offset + chunk.length === content.length });
        offset += chunk.length;
      }
      await catalog.finish({ operationId: id(), transferId: transfer.transferId, expectedBytes: content.length, expectedSha256: digest });
      await catalog.preparePublication([transfer.transferId]);
      const now = 1700000000000;
      const batch: MutationBatch = { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [transfer.transferId], mutations: [
        { version: 1, operationId: id(), kind: "CreateThread", recordedAt: now, payload: {
          thread: { id: threadId, workspaceId: "e85450b9-6711-4f47-a9ec-c42ccf6a5595", createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
          context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
          state: { threadId, title: "Resumable verification", tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
        } },
        { version: 1, operationId: id(), kind: "CreateMessage", recordedAt: now, payload: {
          message: { id: messageId, threadId, parentId: null, role: "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
          parts: [{ id: partId, messageId, order: 0, kind: "Text", data: { textBlob: { sha256: digest, byteLength: content.length, encoding: "utf-8" } } }],
        } },
      ] };
      canonical.commit(batch);
      assert((await catalog.consumeAfterCommit(batch.stagedBlobIds)).pendingCleanup.length === 0, "Fixture staging cleanup failed");
    }
    const before = await inventory();
    assert(before.operations === 2, "Canonical operation inventory changed across owner startup");
    const initial = await pending();
    assert(initial.activeSource!.readBytes > 0 && initial.activeSource!.readBytes <= 131072, "First owner verification did not yield within 128 KiB");
    assert(begins[0]?.verifiedBytes === 0 && !begins[0]?.complete, "Owner reused unverified hash progress from a prior process");
    if (!restart) {
      assert(initial.indexedChunks === 0 && query().items.length === 0, "Unverified source was searchable");
      while (search.status().activeSource?.phase === "verifying") {
        assert(search.status().indexedChunks === 0 && db.selectValue("SELECT count(*) FROM quixi_search_chunks") === 0 && query().items.length === 0, "Partially verified bytes reached the chunker or became searchable");
        await advance();
      }
      assert(query().items.length === 0, "Verification alone published an incomplete source");
      await drain();
      assertHit();
      checks.push("2 MiB canonical Text verifies through bounded admissions, remains hidden until complete, and resolves its exact tail position");

      search.rebuild({ operationId: id() });
      const cancelled = await pending();
      const oldTransfer = begins.at(-1)!.transferId;
      const controller = new AbortController(); controller.abort();
      await advance(controller.signal);
      assert(search.status().activeSource === null && search.status().failedSources === 0, "Cancellation retained resources or marked canonical text failed");
      let released = false;
      try { await catalog.advanceVerifiedRead(oldTransfer, 1); } catch (error) { released = (error as { code?: string }).code === "NOT_FOUND"; }
      assert(released, "Cancelled search retained its verification transfer");
      const resumed = await pending();
      assert(begins.at(-1)!.transferId !== oldTransfer && resumed.activeSource!.readBytes <= cancelled.activeSource!.readBytes, "Cancelled verification did not restart with a fresh bounded cursor");
      checks.push("cancellation releases the pending real byte handle and retries the queued source without failing history");

      const read = await catalog.openRead(digest, id);
      foregroundCompleted = true;
      const tail = catalog.sliceRead(read.transferId, id, { offset: content.length - 64, byteLength: 64 });
      const chunk = catalog.readChunk(tail.transferId);
      assert(new TextDecoder().decode(chunk.bytes).includes("tailneedle"), "Foreground read could not share the pending source verifier");
      catalog.acknowledge({ transferId: tail.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
      await catalog.discard(read.transferId);
      await drain();
      const hit = assertHit();
      foregroundCompleted = false;
      const after = await inventory();
      assert(JSON.stringify(before) === JSON.stringify(after), "Verification, cancellation, or foreground read mutated canonical records/sync history");
      checks.push("same-digest foreground read completes shared verification safely and background indexing resumes without duplicate canonical history");

      search.rebuild({ operationId: id() });
      const interrupted = await pending();
      assert(interrupted.rebuildingEpoch !== null && interrupted.activeSource!.readBytes < content.length, "Process interruption was not positioned in a pending rebuild verifier");
      assert(db.selectValue("PRAGMA integrity_check") === "ok", "SQLite integrity failed before process interruption");
      retainedOwner = { db, pool, bytes, search }; retain = true;
      checks.push("foreground canonical reads succeed between bounded indexing turns; an open pending rebuild is retained for forced owner-process termination");
      return { checks, phase: "write", sha256: digest, byteLength: content.length, before, after, foregroundReads, admissions: admission, begins, verification, hit, interrupted };
    }
    assert(initial.rebuildingEpoch !== null, "Interrupted rebuild was not retained after process restart");
    checks.push("process restart retains the rebuild queue but starts fresh verification at zero with a new real OPFS handle");
    const completed = await drain();
    const hit = assertHit(), after = await inventory();
    assert(JSON.stringify(before) === JSON.stringify(after), "Restarted verification changed canonical records or sync history");
    assert(db.selectValue("PRAGMA integrity_check") === "ok", "SQLite integrity failed after process restart");
    checks.push("restarted rebuild reaches ready with an exact tail hit and unchanged original canonical/sync inventory", "foreground canonical reads remain available between resumed verification turns and SQLite integrity is ok");
    return { checks, phase: "restart", sha256: digest, byteLength: content.length, before, after, foregroundReads, admissions: admission, begins, verification, hit, completed };
  } finally {
    if (!retain) { await search.close(); bytes.close(); try { db.close(); } finally { pool.pauseVfs(); } }
  }
}
