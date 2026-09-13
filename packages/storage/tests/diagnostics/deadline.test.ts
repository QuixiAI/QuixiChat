/** The storage client's per-request deadline (StorageRequestOptions.timeoutMs):
 * the explicit diagnostics report reads the whole database file, so it is
 * requested with INTEGRITY_CHECK_DEADLINE_MS instead of the client default.
 * A fake worker stands in for the Storage Worker so reply timing is exact. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ArchiveStorageClient } from "../../src/client/archive.ts";
import { ARCHIVE_PROTOCOL_VERSION, ArchiveStorageError } from "../../src/archive-protocol.ts";
import { INTEGRITY_CHECK_DEADLINE_MS } from "@quixi/core/contracts";

const light = { backend: "sqlite-wasm-opfs-sahpool", ownerId: "owner", schemaVersion: 12, integrity: "ok", databaseBytes: 65536, canonicalRecords: 0, syncOperations: 0, persisted: null, usage: null, quota: null };
/** Replies to every request after `replyAfterMs`; answers close immediately; records cancellations. */
function fakeWorker(replyAfterMs: number) {
  const posted: unknown[] = [];
  const worker = {
    onmessage: null as null | ((event: { data: unknown }) => void),
    onerror: null, onmessageerror: null,
    postMessage(message: { type: string; call?: { id: string; kind: string } }) {
      posted.push(message);
      if (message.type === "close") queueMicrotask(() => worker.onmessage?.({ data: { version: ARCHIVE_PROTOCOL_VERSION, type: "closed" } }));
      if (message.type === "call" && message.call?.kind === "request")
        setTimeout(() => worker.onmessage?.({ data: { version: ARCHIVE_PROTOCOL_VERSION, type: "reply", id: message.call!.id, ok: true, result: light } }), replyAfterMs);
    },
    terminate() {},
    posted,
  };
  return worker;
}
const client = (worker: ReturnType<typeof fakeWorker>, timeoutMs: number) =>
  new ArchiveStorageClient({ selection: { archiveId: "test-deadline", selectionRevision: 0 }, timeoutMs }, worker as unknown as Worker);
const code = (error: unknown) => (error instanceof ArchiveStorageError ? error.detail.code : String(error));

test("a per-request deadline outlives the client default", async () => {
  const worker = fakeWorker(120);
  const storage = client(worker, 40);
  const value = await storage.request(randomUUID(), "diagnostics", null, { timeoutMs: 1_000 });
  assert.equal(value.integrity, "ok");
  assert.equal(worker.posted.filter((m) => (m as { call?: { kind: string } }).call?.kind === "cancel").length, 0);
  await storage.close();
});

test("without the option the default deadline still applies and the outcome is unknown", async () => {
  const worker = fakeWorker(120);
  const storage = client(worker, 40);
  await assert.rejects(storage.request(randomUUID(), "diagnostics", null), (error: unknown) => code(error) === "UNKNOWN_OUTCOME");
  await storage.close();
});

test("an invalid per-request deadline is refused before dispatch", async () => {
  const worker = fakeWorker(0);
  const storage = client(worker, 40);
  for (const timeoutMs of [0, -1, 1.5, 600_001, Number.NaN])
    await assert.rejects(storage.request(randomUUID(), "diagnostics", null, { timeoutMs }), (error: unknown) => code(error) === "INVALID_REQUEST");
  assert.equal(worker.posted.filter((m) => (m as { type: string }).type === "call").length, 0);
  assert.equal(INTEGRITY_CHECK_DEADLINE_MS, 600_000);
  await storage.close();
});
