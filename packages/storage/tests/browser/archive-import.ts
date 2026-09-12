import type { StorageClient, NormalizedImportStatus, StagedImportRecord, StorageOperations } from "@quixi/core/contracts";
const id = () => crypto.randomUUID();
const budget = { maxItems: 128, maxBytes: 100_000, cursor: null };
const assert = (value: unknown, message: string): void => { if (!value) throw new Error(message); };
const digest = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
export interface ImportFixture {
  importId: string; threadId: string; messageId: string; partCount: number; transferId: string; sha256: string; baseline: number;
  publication: StorageOperations["finalizeNormalizedImport"]["args"];
}
async function validate(client: StorageClient, importId: string, stagedBlobIds: string[] = []): Promise<NormalizedImportStatus> {
  for (let i = 0; i < 100; i++) {
    const status = await client.request(id(), "validateImportStep", { operationId: id(), importId, maxRecords: 128, stagedBlobIds: i === 0 ? stagedBlobIds : [] });
    if (status.state === "ready") return status;
  }
  throw new Error("Bounded validation failed to advance to readiness");
}
export async function prepareImport(client: StorageClient, partCount = 1001, sharedTransfer?: string): Promise<ImportFixture> {
  const baseline = (await client.request(id(), "diagnostics", null)).syncOperations;
  const importId = id(), threadId = id(), contextId = id(), messageId = id(), now = Date.now();
  const content = new TextEncoder().encode("A long imported canonical text. 🌍\n".repeat(1000));
  const sha256 = await digest(content);
  const transfer = sharedTransfer ? { transferId: sharedTransfer } : await client.request(id(), "beginBlobTransfer", { operationId: id(), purpose: "canonical_text", expectedBytes: content.length, expectedSha256: sha256 });
  if (!sharedTransfer) {
    await client.sendChunk({ transferId: transfer.transferId, sequence: 0, offset: 0, bytes: content, final: true });
    await client.request(id(), "finishBlobTransfer", { operationId: id(), transferId: transfer.transferId, expectedBytes: content.length, expectedSha256: sha256 });
  }
  await client.request(id(), "beginNormalizedImport", { operationId: id(), importId, threadId, mode: "create", expectedThreadRevision: null, recordedAt: now });
  const records: StagedImportRecord[] = [
    { collection: "threads", operationId: id(), recordedAt: now, record: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null } },
    { collection: "threadStates", operationId: id(), recordedAt: now, record: { threadId, title: "Imported many-part fixture", tags: [], pinned: false, archived: false, activeLeafMessageId: messageId, contextSnapshotId: contextId, routingProfile: null, revision: 0 } },
    { collection: "contexts", operationId: id(), recordedAt: now, record: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now } },
    { collection: "messages", operationId: id(), recordedAt: now, record: { id: messageId, threadId, parentId: null, role: "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount, sealed: true } },
    { collection: "attachments", operationId: id(), recordedAt: now, record: { id: id(), availability: "available", filename: "imported-text.txt", mimeType: "text/plain", sizeBytes: content.length, blobSha256: sha256, rawObjectId: null } },
  ];
  for (let order = 0; order < partCount; order++) records.push({ collection: "parts", operationId: id(), recordedAt: now, record: { id: id(), messageId, order, kind: "Text", data: order === 0 ? { textBlob: { sha256, byteLength: content.length, encoding: "utf-8" } } : { text: `Imported part ${order}` } } });
  for (let offset = 0, sequence = 0; offset < records.length; offset += 100, sequence++) {
    const args = { operationId: id(), importId, sequence, records: records.slice(offset, offset + 100) };
    await client.request(id(), "stageImportRecords", args);
    if (sequence === 0) await client.request(id(), "stageImportRecords", args);
    const visible = await client.request(id(), "readEntities", { collection: "threads", threadId, page: budget });
    assert(visible.items.length === 0, "Unpublished import escaped canonical reads");
  }
  assert((await client.request(id(), "diagnostics", null)).syncOperations === baseline, "Staging allocated sync sequences");
  const staged = await client.request(id(), "readStagedImportRecords", { importId, page: { ...budget, maxItems: 1 } });
  assert(staged.items.length === 1 && staged.nextCursor !== null, "Staged records are not bounded and paginated");
  const status = await validate(client, importId, [transfer.transferId]);
  assert(status.recordCount === records.length, "Staging replay duplicated records");
  return { importId, threadId, messageId, partCount, transferId: transfer.transferId, sha256, baseline, publication: { operationId: id(), importId, recordedAt: now, expectedRecordCount: status.recordCount, expectedManifestDigest: status.manifestDigest } };
}
export async function finishImportAfterRestart(client: StorageClient, fixture: ImportFixture): Promise<unknown> {
  let rejected = false;
  try { await client.request(id(), "finalizeNormalizedImport", fixture.publication); } catch (error) { rejected = (error as {code?: string}).code === "CONFLICT"; }
  assert(rejected, "Owner restart accepted stale validation evidence");
  await validate(client, fixture.importId);
  const result = await client.request(id(), "finalizeNormalizedImport", fixture.publication);
  assert(result.state === "published", "Validated import did not publish");
  await client.request(id(), "finalizeNormalizedImport", fixture.publication);
  return verifyImport(client, fixture);
}
export async function verifyImport(client: StorageClient, fixture: ImportFixture): Promise<unknown> {
  const status = await client.request(id(), "normalizedImportStatus", { importId: fixture.importId });
  assert(status.state === "published", "Import publication did not persist");
  const diagnostics = await client.request(id(), "diagnostics", null);
  assert(diagnostics.integrity === "ok" && diagnostics.syncOperations === fixture.baseline + fixture.publication.expectedRecordCount + 1, "Publication did not atomically capture records and its sync marker");
  let cursor: string | null = null, count = 0;
  do {
    const result: StorageOperations["readMessageParts"]["result"] = await client.request(id(), "readMessageParts", { messageId: fixture.messageId, page: { ...budget, cursor } });
    for (const item of result.items) {
      const part = item as { order: number; data: {textBlob?: {sha256: string}} };
      assert(part.order === count, "Imported part pagination changed order");
      if (count === 0) assert(part.data.textBlob?.sha256 === fixture.sha256, "Imported long-text reference changed");
      count++;
    }
    cursor = result.nextCursor;
  } while (cursor);
  assert(count === fixture.partCount, "Published many-part message is incomplete");
  const read = await client.request(id(), "readBlobTransfer", { sha256: fixture.sha256 });
  const chunk = await client.readChunk(read.transferId);
  assert(chunk.final && await digest(new Uint8Array(chunk.bytes)) === fixture.sha256, "Imported blob bytes failed readback");
  await client.acknowledgeChunk({ transferId: read.transferId, sequence: chunk.sequence, committedOffset: chunk.bytes.length });
  const hidden = await client.request(id(), "readStagedImportRecords", { importId: fixture.importId, page: budget });
  assert(hidden.items.length === 0, "Published group retained staged records");
  return { diagnostics, partCount: count, state: status.state };
}
export async function cancelImport(client: StorageClient): Promise<unknown> {
  const fixture = await prepareImport(client, 1);
  const status = await client.request(id(), "cancelNormalizedImport", { operationId: id(), importId: fixture.importId });
  assert(status.state === "cancelled", "Import cancellation failed");
  assert((await client.request(id(), "diagnostics", null)).syncOperations === fixture.baseline, "Cancelled import published sync operations");
  const page = await client.request(id(), "readStagedImportRecords", { importId: fixture.importId, page: budget });
  assert(page.items.length === 0, "Cancellation retained normalized staging");
  return { importId: fixture.importId, transferId: fixture.transferId, state: status.state };
}
export async function shareImportTransfer(client: StorageClient): Promise<unknown> {
  const first = await prepareImport(client, 1);
  const second = await prepareImport(client, 1, first.transferId);
  await client.request(id(), "cancelNormalizedImport", { operationId: id(), importId: first.importId });
  return { transferId: first.transferId, remainingImportId: second.importId };
}
