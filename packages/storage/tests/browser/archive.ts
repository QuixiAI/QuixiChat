import { verifyIncrementalSearch, verifyIncrementalSearchResult } from "./archive-search-verification.ts";
import { createIsolatedStorageClient as createStorageClient } from "../isolated-client.ts";
import type { ArchiveStorageClient } from "../../src/client/archive.ts";
import type { MutationBatch, Progress, SearchIndexStatus, SyncOperationPage } from "@quixi/core/contracts";
import { prepareImport, finishImportAfterRestart, verifyImport, cancelImport, shareImportTransfer } from "./archive-import.ts";
import type { ImportFixture } from "./archive-import.ts";
import { prepareProducer, verifyProducer, verifySearch } from "./archive-lifecycle.ts";
import type { ProducerFixture } from "./archive-lifecycle.ts";
const id = () => crypto.randomUUID();
const pageBudget = { maxItems: 100, maxBytes: 100_000, cursor: null };
const hash = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function rejected(action: Promise<unknown>, code: string): Promise<void> {
  try { await action; } catch (error) { assert((error as {code?: string}).code === code, `Expected ${code}, got ${String(error)}`); return; }
  throw new Error(`Expected ${code} rejection`);
}
let client: ArchiveStorageClient;
let currentArchiveId: string;
let changes: string[] = [];
let progress: Progress[] = [];
let searchStatus: SearchIndexStatus | null = null;
let dropReply: { requestId?: string; transferId?: string } | undefined;
let suppressedReplies = 0;
// Drop only the real worker reply after execution. No storage calls or results
// are mocked; this models a lost response at the client/worker boundary.
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener("message", event => {
      if (event.data.type !== "reply" || !event.data.ok || !dropReply) return;
      if (event.data.id === dropReply.requestId || dropReply.transferId && event.data.result?.transferId === dropReply.transferId) {
        dropReply = undefined; suppressedReplies++; event.stopImmediatePropagation();
      }
    });
  }
};
interface Fixture { batch: MutationBatch; digest: string; byteLength: number; threadId: string; messageId: string }
async function readBytes(digest: string): Promise<Uint8Array<ArrayBuffer>> {
  const transfer = await client.request(id(), "readBlobTransfer", { sha256: digest });
  const output = new Uint8Array(transfer.byteLength);
  for (;;) {
    const chunk = await client.readChunk(transfer.transferId); output.set(chunk.bytes, chunk.offset);
    await client.acknowledgeChunk({ transferId: transfer.transferId, sequence: chunk.sequence, committedOffset: chunk.offset + chunk.bytes.length });
    if (chunk.final) return output;
  }
}
async function verify(fixture: Fixture): Promise<unknown> {
  const diagnostics = await client.request(id(), "diagnostics", null);
  assert(diagnostics.integrity === "ok" && diagnostics.syncOperations === 3, "Canonical integrity or atomic operation count changed");
  const threads = await client.request(id(), "readEntities", { collection: "threads", threadId: null, page: pageBudget });
  assert(threads.items.length === 1, "Canonical thread did not persist");
  const parts = await client.request(id(), "readMessageParts", { messageId: fixture.messageId, page: pageBudget });
  assert(parts.items.length === 1, "Canonical message parts did not persist");
  let cursor: string | null = null; const sequences: number[] = [];
  do {
    const sync: SyncOperationPage = await client.request(id(), "readSyncOperations", { afterSequence: 0, page: { ...pageBudget, maxItems: 1, cursor } });
    assert(sync.items.length === 1 && sync.highWaterSequence === 3, "Bounded sync page changed its snapshot");
    sequences.push(sync.items[0]!.sequence); cursor = sync.nextCursor;
  } while (cursor);
  assert(sequences.join(",") === "1,2,3", "Paged sync history skipped or repeated an operation");
  assert(await hash(await readBytes(fixture.digest)) === fixture.digest, "Published bytes changed");
  await client.request(id(), "commit", fixture.batch);
  assert((await client.request(id(), "diagnostics", null)).syncOperations === 3, "Transaction replay duplicated sync operations");
  return diagnostics;
}
async function write(): Promise<Fixture> {
  const bytes = new Uint8Array(5 * 1_048_576 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 17) % 251;
  const digest = await hash(bytes);
  const transfer = await client.request(id(), "beginBlobTransfer", { operationId: id(), purpose: "attachment", expectedBytes: bytes.length, expectedSha256: digest });
  const chunk = (sequence: number) => { const offset = sequence * 1_048_576; return { transferId: transfer.transferId, sequence, offset, bytes: bytes.slice(offset, offset + 1_048_576), final: offset + 1_048_576 >= bytes.length }; };
  const pending = [0, 1, 2, 3].map(sequence => client.sendChunk(chunk(sequence)));
  await rejected(client.sendChunk(chunk(4)), "OVERLOADED");
  await Promise.all(pending);
  await client.sendChunk(chunk(4)); await client.sendChunk(chunk(5));
  await client.request(id(), "finishBlobTransfer", { operationId: id(), transferId: transfer.transferId, expectedBytes: bytes.length, expectedSha256: digest });
  await rejected(client.request(id(), "readBlobTransfer", { sha256: digest }), "NOT_FOUND");
  const threadId = id(), contextId = id(), messageId = id(), attachmentId = id(), now = Date.now();
  const batch: MutationBatch = { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [transfer.transferId], mutations: [
    { version: 1, operationId: id(), kind: "CreateThread", recordedAt: now, payload: {
      thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
      context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
      state: { threadId, title: "Production client fixture", tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
    } },
    { version: 1, operationId: id(), kind: "RegisterAttachment", recordedAt: now, payload: { attachment: { id: attachmentId, availability: "available", filename: "fixture.bin", mimeType: "application/octet-stream", sizeBytes: bytes.length, blobSha256: digest, rawObjectId: null } } },
    { version: 1, operationId: id(), kind: "CreateMessage", recordedAt: now, payload: {
      message: { id: messageId, threadId, parentId: null, role: "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true },
      parts: [{ id: id(), messageId, order: 0, kind: "Text", data: { text: "A real production-client transaction." } }],
    } },
  ] };
  const commitRequest = id(); const droppedBefore = suppressedReplies;
  dropReply = { requestId: commitRequest };
  await rejected(client.request(commitRequest, "commit", batch), "UNKNOWN_OUTCOME");
  assert(suppressedReplies === droppedBefore + 1, "Commit response-loss injection did not run");
  for (const mutation of batch.mutations) assert((await client.request(id(), "operationStatus", { operationId: mutation.operationId })).status === "committed", "Lost response was treated as a failed canonical write");
  assert((await client.cancel(commitRequest, batch.mutations[0]!.operationId)).outcome === "committed", "Cancellation after lost response did not reconcile the committed operation");
  const download = await client.request(id(), "readBlobTransfer", { sha256: digest });
  const first = [0, 1, 2, 3].map(() => client.readChunk(download.transferId));
  await rejected(client.readChunk(download.transferId), "OVERLOADED");
  const received = await Promise.all(first);
  await rejected(client.readChunk(download.transferId), "OVERLOADED");
  const output = new Uint8Array(bytes.length);
  for (const index of [2, 0, 3, 1]) {
    const item = received[index]!; output.set(item.bytes, item.offset);
    await client.acknowledgeChunk({ transferId: item.transferId, sequence: item.sequence, committedOffset: item.offset + item.bytes.length });
  }
  for (let sequence = 4; sequence < 6; sequence++) {
    const item = await client.readChunk(download.transferId); output.set(item.bytes, item.offset);
    assert(item.sequence === sequence, "Rejected read consumed an owner sequence");
    if (item.final) await rejected(client.readChunk(download.transferId), "INVALID_REQUEST");
    await client.acknowledgeChunk({ transferId: item.transferId, sequence: item.sequence, committedOffset: item.offset + item.bytes.length });
  }
  assert(await hash(output) === digest, "Cross-worker bytes changed or detached before consumption");
  const fixture = { batch, digest, byteLength: bytes.length, threadId, messageId };
  await verify(fixture);
  await rejected(client.request(id(), "beginBlobTransfer", { operationId: batch.mutations[0]!.operationId, purpose: "attachment", expectedBytes: 0, expectedSha256: null }), "CONFLICT");
  assert((await client.request(id(), "operationStatus", { operationId: batch.mutations[0]!.operationId })).status === "committed", "A cross-journal identity collision altered the canonical operation");
  const invalid: MutationBatch = { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: [
    { version: 1, operationId: id(), kind: "SetTitle", recordedAt: now, payload: { threadId, value: "Must roll back" } },
    { version: 1, operationId: id(), kind: "SetTitle", recordedAt: now, payload: { threadId: id(), value: "Missing thread" } },
  ] };
  let failed = false; try { await client.request(id(), "commit", invalid); } catch { failed = true; }
  assert(failed, "Invalid transaction succeeded");
  const states = await client.request(id(), "readEntities", { collection: "threadStates", threadId, page: pageBudget });
  assert((states.items[0] as {title: string}).title === "Production client fixture", "Failed transaction left a partial title write");
  assert((await client.request(id(), "operationStatus", { operationId: invalid.mutations[0]!.operationId })).status === "not_found", "Failed transaction left a sync operation");
  return fixture;
}
Object.assign(window, {
  archiveTest: async (operation: string, value: unknown): Promise<unknown> => {
    switch (operation) {
      case "open": currentArchiveId = String(value); client = createStorageClient({ archiveId: currentArchiveId, timeoutMs: 5_000 }); changes = []; progress = []; searchStatus = null; client.onChange(ids => changes.push(...ids)); client.onProgress(item => progress.push(item)); client.onSearchChange(status => { searchStatus = status; }); return client.request(id(), "diagnostics", null);
      case "search_progress": return searchStatus;
      case "prepare_producer": return prepareProducer(client, currentArchiveId, value as { registered?: boolean; create?: boolean });
      case "verify_producer": { const args = value as { fixture: ProducerFixture; expected: 'streaming'|'partial'|'absent' }; return verifyProducer(client, args.fixture, args.expected); }
      case "verify_incremental_search": return verifyIncrementalSearch(client);
      case "verify_incremental_search_result": return verifyIncrementalSearchResult(client, value as { threadId: string; messageId: string; partId: string });
      case "verify_search": return verifySearch(client, value as ProducerFixture);
      case "damage_search": {
        await client.close();
        const worker = new Worker(new URL('./search-damage.ts', import.meta.url), { type: 'module' });
        try {
          return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Offline search damage worker timed out')), 10_000);
            worker.onmessage = ({ data }) => { clearTimeout(timer); if (data.ok) resolve(data); else reject(new Error(data.error)); };
            worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
            worker.postMessage(currentArchiveId);
          });
        } finally { worker.terminate(); }
      }
      case "repair_search": {
        const fixture = value as ProducerFixture;
        await rejected(client.request(id(), 'searchStatus', null), 'MIGRATION_FAILED');
        const before = await client.request(id(), 'diagnostics', null);
        await client.request(id(), 'commit', { transactionId: id(), expectedThreadRevisions: [], stagedBlobIds: [], mutations: [{ version: 1, operationId: id(), recordedAt: Date.now(), kind: 'SetTitle', payload: { threadId: fixture.threadId, value: 'History remains writable during search repair' } }] });
        const afterWrite = await client.request(id(), 'diagnostics', null);
        assert(afterWrite.syncOperations === before.syncOperations + 1, 'Damaged derived search prevented a canonical write');
        await client.request(id(), 'rebuildSearch', { operationId: id() });
        const result = await verifySearch(client, fixture);
        const after = await client.request(id(), 'diagnostics', null);
        assert(after.canonicalRecords === afterWrite.canonicalRecords && after.syncOperations === afterWrite.syncOperations, 'Search repair changed canonical history or sync');
        return result;
      }
      case "diagnostics": return client.request(id(), "diagnostics", null);
      case "write": return write();
      case "ranges": {
        const fixture = value as Fixture;
        const anchor = await client.request(id(), "readBlobTransfer", { sha256: fixture.digest });
        await rejected(client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset: fixture.byteLength, byteLength: 1 }), "INVALID_REQUEST");
        await rejected(client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset: Number.MAX_SAFE_INTEGER, byteLength: 1 }), "INVALID_REQUEST");
        const children = [];
        for (let i = 0; i < 7; i++) children.push(await client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset: i * 1_048_576 % fixture.byteLength, byteLength: 17 }));
        await rejected(client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset: 0, byteLength: 1 }), "OVERLOADED");
        for (const child of children) {
          const chunk = await client.readChunk(child.transferId);
          assert(chunk.offset === 0 && chunk.final && chunk.bytes.length === 17, "Range offsets or final marker are not relative to the selection");
          for (let i = 0; i < chunk.bytes.length; i++) assert(chunk.bytes[i] === ((child.range.offset + i) * 31 + 17) % 251, "Range changed source bytes");
          await client.acknowledgeChunk({ transferId: child.transferId, sequence: 0, committedOffset: 17 });
        }
        // Repeated small reads reuse the held verified file, without buffering or
        // reopening the full export for each selected source span.
        for (let i = 0; i < 128; i++) {
          const offset = i * 317;
          const child = await client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset, byteLength: 3 });
          const chunk = await client.readChunk(child.transferId);
          assert(chunk.bytes[0] === (offset * 31 + 17) % 251, "Repeated range lookup drifted");
          await client.acknowledgeChunk({ transferId: child.transferId, sequence: 0, committedOffset: 3 });
        }
        const tail = await client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset: fixture.byteLength - 17, byteLength: 17 });
        const empty = await client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset: fixture.byteLength, byteLength: 0 });
        await client.request(id(), "discardBlobTransfer", { transferId: anchor.transferId });
        const tailChunk = await client.readChunk(tail.transferId);
        assert(tailChunk.final && tailChunk.bytes.length === 17, "Discarding parent prematurely closed a child's verified handle");
        await client.acknowledgeChunk({ transferId: tail.transferId, sequence: 0, committedOffset: 17 });
        const emptyChunk = await client.readChunk(empty.transferId);
        assert(emptyChunk.final && emptyChunk.offset === 0 && emptyChunk.bytes.length === 0, "Empty EOF range did not have a terminal acknowledgement");
        await client.acknowledgeChunk({ transferId: empty.transferId, sequence: 0, committedOffset: 0 });
        await rejected(client.request(id(), "sliceBlobTransfer", { transferId: anchor.transferId, offset: 0, byteLength: 1 }), "NOT_FOUND");
        return { boundedChildLeases: 7, repeatedRanges: 128, childrenSurviveParentDiscard: true, emptyEofAcknowledged: true };
      }
      case "verify": return verify(value as Fixture);
      case "events": return { changes, progress };
      case "prepare_import": return prepareImport(client);
      case "finish_import_after_restart": return finishImportAfterRestart(client, value as ImportFixture);
      case "verify_import": return verifyImport(client, value as ImportFixture);
      case "cancel_import": return cancelImport(client);
      case "share_import_transfer": return shareImportTransfer(client);
      case "cancel_import_id": return client.request(id(), "cancelNormalizedImport", { operationId: id(), importId: String(value) });
      case "stage_files": {
        const root = await navigator.storage.getDirectory();
        const archive = await root.getDirectoryHandle(`quixi-${String(value)}`);
        const temporary = await archive.getDirectoryHandle("temp");
        const transfers = await temporary.getDirectoryHandle("blob-transfers");
        const names: string[] = [];
        for await (const name of (transfers as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }).keys()) names.push(name);
        return names;
      }
      case "close": await client.close(); return null;
      case "request_admission": {
        const requests = Array.from({ length: 64 }, () => client.request(id(), "diagnostics", null));
        await rejected(client.request(id(), "diagnostics", null), "OVERLOADED");
        await Promise.all(requests);
        assert((await client.request(id(), "diagnostics", null)).integrity === "ok", "Control admission did not recover");
        return { admitted: 64, rejectedBeforeDispatch: 1, recovered: true };
      }
      case "lost_chunk_reply": {
        const transfer = await client.request(id(), "beginBlobTransfer", { operationId: id(), purpose: "attachment", expectedBytes: 2, expectedSha256: null });
        const before = suppressedReplies; dropReply = { transferId: transfer.transferId };
        await rejected(client.sendChunk({ transferId: transfer.transferId, sequence: 0, offset: 0, bytes: new Uint8Array([1]), final: false }), "UNKNOWN_OUTCOME");
        assert(suppressedReplies === before + 1, "Chunk reply-loss injection did not run");
        await rejected(client.sendChunk({ transferId: transfer.transferId, sequence: 1, offset: 1, bytes: new Uint8Array([2]), final: true }), "INVALID_REQUEST");
        await client.request(id(), "discardBlobTransfer", { transferId: transfer.transferId });
        const restarted = await client.request(id(), "beginBlobTransfer", { operationId: id(), purpose: "attachment", expectedBytes: 2, expectedSha256: null });
        const bytes = new Uint8Array([1, 2]);
        await client.sendChunk({ transferId: restarted.transferId, sequence: 0, offset: 0, bytes, final: true });
        await client.request(id(), "finishBlobTransfer", { operationId: id(), transferId: restarted.transferId, expectedBytes: 2, expectedSha256: await hash(bytes) });
        await client.request(id(), "discardBlobTransfer", { transferId: restarted.transferId });
        return { suppressedReplies: suppressedReplies - before, recovered: true };
      }
      case "leave_upload": {
        const args = { operationId: id(), purpose: "attachment" as const, expectedBytes: 2, expectedSha256: null };
        const transfer = await client.request(id(), "beginBlobTransfer", args);
        await client.sendChunk({ transferId: transfer.transferId, sequence: 0, offset: 0, bytes: new Uint8Array([1]), final: false });
        return { args, transferId: transfer.transferId };
      }
      case "verify_interrupted": {
        const prior = value as { args: Parameters<ArchiveStorageClient["request"]>[2]; transferId: string };
        await rejected(client.request(id(), "beginBlobTransfer", prior.args as import("@quixi/core/contracts").StorageOperations["beginBlobTransfer"]["args"]), "CONFLICT");
        await client.request(id(), "discardBlobTransfer", { transferId: prior.transferId });
        return { interruptedReplayRejected: true, discarded: true };
      }
      case "cancel_before_dispatch": {
        const archiveId = String(value);
        let release!: () => void;
        let acquired!: () => void;
        const ready = new Promise<void>(resolve => { acquired = resolve; });
        const hold = navigator.locks.request(`quixi:archive:${archiveId}:owner`, async () => { acquired(); await new Promise<void>(resolve => { release = resolve; }); });
        await ready;
        const isolated = createStorageClient({ archiveId, timeoutMs: 5_000 });
        try {
          const requestId = id();
          const pending = rejected(isolated.request(requestId, "diagnostics", null), "CANCELLED");
          const outcome = await isolated.cancel(requestId, null);
          await pending; assert(outcome.outcome === "not_dispatched", "Cancellation did not distinguish pre-dispatch outcome");
          return outcome;
        } finally { release(); await hold; await isolated.close(); }
      }
      default: throw new Error("Unknown archive test operation");
    }
  },
});
