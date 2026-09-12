import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import initialize from "../../storage/sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../storage/src/worker/canonical/index.ts";
import type {
  CanonicalSqlite,
  SqlValue,
} from "../../storage/src/worker/canonical/repository.ts";
import { SearchRepository } from "../../storage/src/worker/search/index.ts";
import type { SearchBlobAccess } from "../../storage/src/worker/search/index.ts";
import type {
  CanonicalMutation,
  SearchFilters,
  ByteChunk,
} from "@quixi/core/contracts";
import type { ContentPart, Message, Generation } from "@quixi/core/model";
const wasm = await readFile(
  new URL("../../storage/sqlite/dist/sqlite3.wasm", import.meta.url),
);
const manifest = JSON.parse(
  await readFile(
    new URL("../../storage/sqlite/artifacts.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(
  createHash("sha256").update(wasm).digest("hex"),
  manifest.artifacts["sqlite3.wasm"].sha256,
);
(globalThis as any).sqlite3ApiConfig = {
  disable: { vfs: { opfs: true, "opfs-wl": true } },
};
const initOptions = {
  instantiateWasm: async (
    imports: WebAssembly.Imports,
    success: (
      instance: WebAssembly.Instance,
      module: WebAssembly.Module,
    ) => void,
  ) => {
    const result = await WebAssembly.instantiate(wasm, imports);
    success(result.instance, result.module);
  },
  print: () => {},
  printErr: () => {},
};
const sqlite = (await initialize(initOptions)) as {
  oo1: {
    DB: new (
      name: string,
      flags: string,
    ) => CanonicalSqlite & { close(): void };
  };
};
const id = () => randomUUID(),
  now = 1700000000000,
  hash = (bytes: Uint8Array) =>
    createHash("sha256").update(bytes).digest("hex");
class Bytes implements SearchBlobAccess {
  data = new Map<string, Uint8Array>();
  readers = new Map<
    string,
    { bytes: Uint8Array; offset: number; length: number }
  >();
  incremental = false;
  verifiers = new Map<string, { sha: string; verifiedBytes: number }>();
  verificationSteps: Array<{ transferId: string; maxBytes: number; verifiedBytes: number; delta: number }> = [];
  discarded: string[] = [];
  opens = 0;
  async beginVerifiedRead(sha: string, next: () => string, signal?: AbortSignal) {
    if (!this.incremental) {
      const read = await this.openRead(sha, next, signal);
      return { ...read, verifiedBytes: read.byteLength, complete: true };
    }
    this.opens++;
    if (signal?.aborted)
      throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    const bytes = this.data.get(sha);
    if (!bytes) throw new Error("Synthetic source missing");
    const transferId = next();
    this.readers.set(transferId, { bytes, offset: 0, length: bytes.length });
    this.verifiers.set(transferId, { sha, verifiedBytes: 0 });
    return { transferId, byteLength: bytes.length, verifiedBytes: 0, complete: false };
  }
  async advanceVerifiedRead(transferId: string, maxBytes: number, signal?: AbortSignal) {
    assert(maxBytes > 0 && maxBytes <= 131072);
    if (this.verifyWait) await this.verifyWait();
    if (signal?.aborted)
      throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    const read = this.readers.get(transferId)!;
    const verifier = this.verifiers.get(transferId)!;
    assert(read && verifier);
    const delta = Math.min(maxBytes, read.length - verifier.verifiedBytes);
    verifier.verifiedBytes += delta;
    this.verificationSteps.push({ transferId, maxBytes, verifiedBytes: verifier.verifiedBytes, delta });
    const complete = verifier.verifiedBytes === read.length;
    if (complete) {
      if (hash(read.bytes) !== verifier.sha)
        throw new Error("Synthetic source verification failed");
      this.verifiers.delete(transferId);
    }
    return { transferId, byteLength: read.length, verifiedBytes: verifier.verifiedBytes, complete };
  }
  peakRange = 0;
  overloadedOpen = false;
  overloadedSlice = false;
  verifyWait: (() => Promise<void>) | null = null;
  async openRead(sha: string, next: () => string, signal?: AbortSignal) {
    this.opens++;
    if (this.overloadedOpen)
      throw Object.assign(new Error("Synthetic transfer admission full"), {
        code: "OVERLOADED",
      });
    if (this.verifyWait) await this.verifyWait();
    if (signal?.aborted)
      throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
    const bytes = this.data.get(sha);
    if (!bytes || hash(bytes) !== sha)
      throw new Error("Synthetic source verification failed");
    const transferId = next();
    this.readers.set(transferId, { bytes, offset: 0, length: bytes.length });
    return { transferId, byteLength: bytes.length };
  }
  sliceRead(
    parent: string,
    next: () => string,
    range: { offset: number; byteLength: number },
  ) {
    if (this.overloadedSlice)
      throw Object.assign(new Error("Synthetic range admission full"), {
        code: "OVERLOADED",
      });
    assert(!this.verifiers.has(parent), "Unverified bytes must not reach the chunker");
    const source = this.readers.get(parent)!;
    assert(source);
    assert(range.offset + range.byteLength <= source.bytes.length);
    this.peakRange = Math.max(this.peakRange, range.byteLength);
    const transferId = next();
    this.readers.set(transferId, {
      bytes: source.bytes,
      offset: range.offset,
      length: range.byteLength,
    });
    return { transferId };
  }
  readChunk(transferId: string): ByteChunk {
    const read = this.readers.get(transferId)!;
    return {
      transferId,
      offset: 0,
      sequence: 0,
      bytes: read.bytes.slice(read.offset, read.offset + read.length),
      final: true,
    };
  }
  acknowledge(value: { transferId: string }) {
    this.readers.delete(value.transferId);
  }
  async discard(transferId: string) {
    this.discarded.push(transferId);
    this.verifiers.delete(transferId);
    return this.readers.delete(transferId);
  }
}
function open() {
  const db = new sqlite.oo1.DB(`/search-${id()}.sqlite3`, "c"),
    canonical = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  canonical.migrate();
  const bytes = new Bytes(),
    search = new SearchRepository(db, bytes);
  search.initialize();
  return { db, canonical, bytes, search };
}
function commit(
  repository: CanonicalRepository,
  kind: CanonicalMutation["kind"],
  payload: unknown,
) {
  const mutation = {
    version: 1,
    operationId: id(),
    kind,
    recordedAt: now,
    payload,
  } as CanonicalMutation;
  return repository.commit({
    transactionId: id(),
    mutations: [mutation],
    expectedThreadRevisions: [],
    stagedBlobIds: [],
  });
}
function thread(
  canonical: CanonicalRepository,
  title = "Research archive",
  importSourceId: string | null = null,
) {
  const threadId = id(),
    contextId = id();
  commit(canonical, "CreateThread", {
    thread: {
      id: threadId,
      workspaceId: id(),
      createdAt: now,
      recordedAt: now,
      systemPrompt: null,
      preferredRoute: null,
      importSourceId,
    },
    context: {
      id: contextId,
      threadId,
      previousId: null,
      version: 1,
      systemPrompt: null,
      preferredRoute: null,
      recordedAt: now,
    },
    state: {
      threadId,
      title,
      tags: ["research", "verified"],
      pinned: false,
      archived: false,
      activeLeafMessageId: null,
      contextSnapshotId: contextId,
      routingProfile: null,
      revision: 0,
    },
  });
  return { threadId, contextId };
}
function message(
  canonical: CanonicalRepository,
  threadId: string,
  text: string | { sha256: string; byteLength: number },
  parentId: string | null = null,
) {
  const messageId = id(),
    partId = id();
  const record: Message = {
    id: messageId,
    threadId,
    parentId,
    role: "user",
    createdAt: now,
    recordedAt: now,
    generationId: null,
    editedFromMessageId: null,
    partCount: 1,
    sealed: true,
  };
  const part: ContentPart = {
    id: partId,
    messageId,
    order: 0,
    kind: "Text",
    data:
      typeof text === "string"
        ? { text }
        : { textBlob: { ...text, encoding: "utf-8" } },
  };
  commit(canonical, "CreateMessage", { message: record, parts: [part] });
  return { messageId, partId };
}
async function drain(search: SearchRepository) {
  for (let i = 0; i < 2000; i++) {
    const status = await search.advance({ maxChunks: 16 });
    if (status.pendingSources === 0) return status;
  }
  throw new Error("Index did not finish bounded maintenance");
}
const query = (
  search: SearchRepository,
  text: string,
  filters: SearchFilters = {},
  maxItems = 100,
  cursor: string | null = null,
) =>
  search.search({
    query: text,
    mode: "best",
    filters,
    page: { maxItems, maxBytes: 100000, cursor },
  });

test("pinned WASM: tail text is searchable with accurate UTF-16 positions and one retained verified source", async () => {
  const { db, canonical, bytes, search } = open();
  try {
    const t = thread(canonical);
    const text =
      "Introduction 🧪\n\n" +
      "ordinary bounded paragraph.\n\n".repeat(30000) +
      "TAIL_NEEDLE exact_archive_identifier";
    const buffer = new TextEncoder().encode(text),
      sha256 = hash(buffer);
    bytes.data.set(sha256, buffer);
    const source = message(canonical, t.threadId, {
      sha256,
      byteLength: buffer.length,
    });
    const first = await search.advance({ maxChunks: 1 });
    assert.equal(first.indexedChunks, 0);
    assert.equal(query(search, "TAIL_NEEDLE").items.length, 0);
    assert.equal(bytes.readers.size, 1);
    const status = await drain(search);
    assert.equal(status.state, "ready");
    assert.equal(bytes.opens, 1);
    assert(bytes.peakRange <= 65536);
    assert.equal(bytes.readers.size, 0);
    const result = query(search, "TAIL_NEEDLE");
    assert.equal(result.modeUsed, "best_lexical");
    assert.equal(result.items.length, 1);
    const hit = result.items[0]!;
    assert.equal(hit.messageId, source.messageId);
    assert.equal(hit.position.partId, source.partId);
    assert(
      text.slice(hit.position.start, hit.position.end).includes("TAIL_NEEDLE"),
    );
    assert.equal(
      hit.excerpt.text.slice(
        hit.excerpt.highlights[0]!.start,
        hit.excerpt.highlights[0]!.end,
      ),
      "TAIL_NEEDLE",
    );
    assert.equal(status.semantic.state, "unavailable");
  } finally {
    await search.close();
    db.close();
  }
});

test("scope triggers hide stale titles/tags and tombstones during held source indexing", async () => {
  const { db, canonical, bytes, search } = open();
  try {
    const t = thread(canonical, "OriginalTitle");
    const text = "needle ".repeat(30000),
      buffer = new TextEncoder().encode(text),
      sha256 = hash(buffer);
    bytes.data.set(sha256, buffer);
    const source = message(canonical, t.threadId, {
      sha256,
      byteLength: buffer.length,
    });
    await search.advance({ maxChunks: 1 });
    commit(canonical, "SetTitle", {
      threadId: t.threadId,
      value: "ChangedTitle",
    });
    await drain(search);
    assert.equal(query(search, "OriginalTitle").items.length, 0);
    assert(query(search, "ChangedTitle").items.length > 0);
    assert.equal(bytes.opens, 2);
    commit(canonical, "SetTags", {
      threadId: t.threadId,
      value: ["replacement"],
    });
    assert.equal(query(search, "needle").items.length, 0);
    await drain(search);
    assert.equal(
      query(search, "needle", { tags: ["research"] }).items.length,
      0,
    );
    assert(query(search, "needle", { tags: ["replacement"] }).items.length > 0);
    const state = canonical.get("threadStates", t.threadId)!;
    commit(canonical, "TombstoneBranch", {
      tombstone: {
        id: id(),
        threadId: t.threadId,
        rootMessageId: source.messageId,
        createdAt: now,
        reason: null,
      },
      state: {
        ...state,
        activeLeafMessageId: null,
        revision: state.revision + 1,
      },
    });
    assert.equal(query(search, "needle").items.length, 0);
    await drain(search);
    assert.equal(query(search, "needle").items.length, 0);
  } finally {
    await search.close();
    db.close();
  }
});

test("rebuild preserves usable old epoch and canonical records/operations; stale cursors reject", async () => {
  const { db, canonical, search } = open();
  try {
    const t = thread(canonical);
    for (let i = 0; i < 5; i++)
      message(canonical, t.threadId, `duplicate matching needle record ${i}`);
    await drain(search);
    const first = query(search, "needle", {}, 2);
    assert.equal(first.items.length, 2);
    assert(first.nextCursor);
    const second = query(search, "needle", {}, 2, first.nextCursor);
    assert.equal(second.items.length, 2);
    assert(
      !first.items.some((a) =>
        second.items.some((b) => a.chunkId === b.chunkId),
      ),
    );
    const records = db.selectValue("SELECT count(*) FROM quixi_records"),
      ops = db.selectValue("SELECT count(*) FROM quixi_sync_ops");
    const operationId = id(),
      before = search.status().activeEpoch;
    search.rebuild({ operationId });
    const rebuilding = search.rebuild({ operationId });
    assert.equal(rebuilding.activeEpoch, before);
    assert.equal(query(search, "needle").items.length, 5);
    assert.throws(
      () => query(search, "needle", {}, 2, first.nextCursor),
      /cursor/,
    );
    await drain(search);
    assert.notEqual(search.status().activeEpoch, before);
    assert.equal(query(search, "needle").items.length, 5);
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_records"), records);
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_sync_ops"), ops);
    assert.equal(db.selectValue("PRAGMA integrity_check"), "ok");
  } finally {
    await search.close();
    db.close();
  }
});

test("source/provider/model/date/tag/media/origin filters and explicit dependency gates", async () => {
  const { db, canonical, search } = open();
  try {
    const imported = id();
    commit(canonical, "RegisterImportSource", {
      source: {
        id: imported,
        provider: "anthropic",
        method: "fixture",
        sourceThreadId: null,
        sourceUrl: null,
        importerName: "synthetic",
        importerVersion: "1",
        sourceFormatVersion: null,
        sourceFingerprint: null,
        importedAt: now,
      },
      rawObjects: [],
    });
    const t = thread(canonical, "Imported research", imported),
      parent = message(canonical, t.threadId, "common needle user");
    const generationId = id(),
      outputId = id();
    const generation: Generation = {
      id: generationId,
      threadId: t.threadId,
      parentMessageId: parent.messageId,
      outputMessageId: outputId,
      contextSnapshotId: t.contextId,
      provider: "openai",
      providerAccountId: "synthetic",
      model: "test-model",
      parameters: {},
      status: "complete",
      createdAt: now,
      recordedAt: now,
      completedAt: now,
      tokensIn: null,
      tokensOut: null,
      cachedTokens: null,
      estimatedCost: null,
      reportedCost: null,
      lastSequence: 0,
      rawResponseId: null,
      compatibility: [],
    };
    const output: Message = {
      id: outputId,
      threadId: t.threadId,
      parentId: parent.messageId,
      role: "assistant",
      createdAt: now,
      recordedAt: now,
      generationId,
      editedFromMessageId: null,
      partCount: 1,
      sealed: true,
    };
    commit(canonical, "CreateGeneration", {
      generation,
      output,
      parts: [
        {
          id: id(),
          messageId: outputId,
          order: 0,
          kind: "Text",
          data: { text: '```ts\nconst needle = "exact_code_identifier";\n```' },
        },
      ],
    });
    await drain(search);
    assert.equal(
      query(search, "needle", {
        providers: ["openai"],
        models: ["test-model"],
        threadIds: [t.threadId],
        after: now,
        before: now,
        tags: ["research", "verified"],
        mediaTypes: ["text/plain"],
        hasCode: true,
        origin: "imported",
        sourceTypes: ["code"],
      }).items.length,
      1,
    );
    assert.equal(query(search, "needle", { origin: "native" }).items.length, 0);
    assert.equal(query(search, "needle", { hasCode: false }).items.length, 1);
    assert.throws(
      () => query(search, "needle", { portability: "fully_portable" }),
      /plan10/,
    );
    assert.throws(
      () => query(search, "needle", { sourceTypes: ["ocr"] }),
      /plan15/,
    );
    assert.throws(
      () =>
        search.search({
          query: "needle",
          mode: "semantic",
          filters: {},
          page: { maxItems: 10, maxBytes: 10000, cursor: null },
        }),
      /not enabled/,
    );
    assert.throws(() => query(search, '"unclosed'), /quoted/);
  } finally {
    await search.close();
    db.close();
  }
});

test("plain documents and registered PDF pages share chunks and distinct page identities", async () => {
  const { db, canonical, bytes, search } = open();
  try {
    const data = new TextEncoder().encode(
        "long document paragraph. ".repeat(1500) + "document_tail_needle",
      ),
      sha256 = hash(data),
      attachmentId = id(),
      documentId = id();
    bytes.data.set(sha256, data);
    commit(canonical, "RegisterAttachment", {
      attachment: {
        id: attachmentId,
        availability: "available",
        filename: "source.txt",
        mimeType: "text/plain",
        sizeBytes: data.length,
        blobSha256: sha256,
        rawObjectId: null,
      },
    });
    commit(canonical, "RegisterDocument", {
      document: {
        id: documentId,
        workspaceId: id(),
        attachmentId,
        title: "Source document",
        createdAt: now,
        recordedAt: now,
        importSourceId: null,
      },
    });
    await drain(search);
    assert.equal(
      query(search, "document_tail_needle", {
        documentIds: [documentId],
        sourceTypes: ["document"],
      }).items.length,
      1,
    );
    const pdfAttachment = id(),
      pdfDocument = id(),
      pdfBytes = new TextEncoder().encode(
        "%PDF-1.4 synthetic fixture; no extraction executed",
      ),
      pdfSha = hash(pdfBytes);
    bytes.data.set(pdfSha, pdfBytes);
    commit(canonical, "RegisterAttachment", {
      attachment: {
        id: pdfAttachment,
        availability: "available",
        filename: "source.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdfBytes.length,
        blobSha256: pdfSha,
        rawObjectId: null,
      },
    });
    commit(canonical, "RegisterDocument", {
      document: {
        id: pdfDocument,
        workspaceId: id(),
        attachmentId: pdfAttachment,
        title: "Registered PDF pages",
        createdAt: now,
        recordedAt: now,
        importSourceId: null,
      },
    });
    for (const page of [1, 2])
      search.registerExtractedText({
        id: id(),
        documentId: pdfDocument,
        attachmentSha256: pdfSha,
        extractorVersion: "synthetic-page-registration",
        text: "same page needle",
        page,
        sectionPath: ["Identical"],
        offsetBase: 0,
      });
    await drain(search);
    assert.equal(query(search, "document_tail_needle").items.length, 1);
    const pages = query(search, "same page");
    assert.equal(pages.items.length, 2);
    assert.notEqual(pages.items[0]!.chunkId, pages.items[1]!.chunkId);
    assert.deepEqual(
      pages.items.map((item) => item.position.page).sort(),
      [1, 2],
    );
    assert.equal(
      db.selectValue(
        "SELECT count(*) FROM quixi_records WHERE collection='documents'",
      ),
      2,
    );
  } finally {
    await search.close();
    db.close();
  }
});

test("owner restart discards invisible partial runs and retrying a repaired failure can complete a rebuild", async () => {
  const { db, canonical, bytes, search } = open();
  let reopened: SearchRepository | null = null;
  try {
    const t = thread(canonical),
      text = "restart needle ".repeat(12000),
      buffer = new TextEncoder().encode(text),
      sha256 = hash(buffer);
    bytes.data.set(sha256, buffer);
    message(canonical, t.threadId, { sha256, byteLength: buffer.length });
    await search.advance({ maxChunks: 1 });
    assert.equal(search.status().indexedChunks, 0);
    await search.close();
    reopened = new SearchRepository(db, bytes);
    reopened.initialize();
    await drain(reopened);
    assert(query(reopened, "needle").items.length > 0);
    assert.equal(bytes.opens, 2);
    bytes.data.delete(sha256);
    reopened.rebuild({ operationId: id() });
    let failed = await drain(reopened);
    assert(failed.failedSources > 0);
    assert(
      query(reopened, "needle").items.length > 0,
      "Previous valid epoch disappeared during a failed rebuild",
    );
    bytes.data.set(sha256, buffer);
    reopened.rebuild({ operationId: id() });
    await drain(reopened);
    assert.equal(reopened.status().failedSources, 0);
    assert.equal(reopened.status().state, "ready");
    assert.equal(bytes.readers.size, 0);
  } finally {
    await reopened?.close();
    await search.close();
    db.close();
  }
});

test("initial verified-file scan exposes phase and abort leaves a retryable dirty source", async () => {
  const { db, canonical, bytes, search } = open();
  try {
    const t = thread(canonical),
      buffer = new TextEncoder().encode("verification needle ".repeat(3000)),
      sha256 = hash(buffer);
    bytes.data.set(sha256, buffer);
    message(canonical, t.threadId, { sha256, byteLength: buffer.length });
    let release!: () => void;
    bytes.verifyWait = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const controller = new AbortController(),
      pending = search.advance({ maxChunks: 1 }, controller.signal);
    assert.equal(search.status().activeSource?.phase, "verifying");
    controller.abort();
    release();
    await pending;
    assert.equal(search.status().failedSources, 0);
    assert.equal(search.status().indexedChunks, 0);
    assert.equal(bytes.readers.size, 0);
    bytes.verifyWait = null;
    await drain(search);
    assert(query(search, "needle").items.length > 0);
  } finally {
    await search.close();
    db.close();
  }
});

test("append during a held source restarts that source and ordinary generation metadata does not dirty completed parts", async () => {
  const { db, canonical, search } = open();
  try {
    const t = thread(canonical),
      parent = message(canonical, t.threadId, "parent only"),
      generationId = id(),
      outputId = id(),
      partId = id(),
      text = "earlierneedle " + "content ".repeat(1900);
    const generation: Generation = {
      id: generationId,
      threadId: t.threadId,
      parentMessageId: parent.messageId,
      outputMessageId: outputId,
      contextSnapshotId: t.contextId,
      provider: "openai",
      providerAccountId: "synthetic",
      model: "test-model",
      parameters: {},
      status: "streaming",
      createdAt: now,
      recordedAt: now,
      completedAt: null,
      tokensIn: null,
      tokensOut: null,
      cachedTokens: null,
      estimatedCost: null,
      reportedCost: null,
      lastSequence: 0,
      rawResponseId: null,
      compatibility: [],
    };
    const output: Message = {
      id: outputId,
      threadId: t.threadId,
      parentId: parent.messageId,
      role: "assistant",
      createdAt: now,
      recordedAt: now,
      generationId,
      editedFromMessageId: null,
      partCount: 1,
      sealed: false,
    };
    commit(canonical, "CreateGeneration", {
      generation,
      output,
      parts: [
        {
          id: partId,
          messageId: outputId,
          order: 0,
          kind: "Text",
          data: { text },
        },
      ],
    });
    for (
      let i = 0;
      i < 20 && search.status().activeSource?.sourceId !== `p:${partId}`;
      i++
    )
      await search.advance({ maxChunks: 1 });
    assert.equal(search.status().activeSource?.sourceId, `p:${partId}`);
    commit(canonical, "AppendGenerationOutput", {
      generationId,
      sequence: 1,
      newParts: [],
      textAppend: { partId, text: " late_appended_needle" },
    });
    await drain(search);
    assert.equal(query(search, "late_appended_needle").items.length, 1);
    const before = search.status().revision;
    commit(canonical, "CompleteGeneration", {
      generationId,
      status: "complete",
      completedAt: now,
      tokensIn: 2,
      tokensOut: 3,
      cachedTokens: null,
      estimatedCost: null,
      reportedCost: null,
      rawResponseId: null,
    });
    assert.equal(search.status().revision, before);
    assert(query(search, "earlierneedle").items.length > 0);
  } finally {
    await search.close();
    db.close();
  }
});

test("Unicode and embedded control text retain searchable tail and exact source offsets", async () => {
  const { db, canonical, search } = open();
  try {
    const t = thread(canonical);
    const text = "naïve résumé 🧪 before\0after_control_needle e\u0301";
    message(canonical, t.threadId, text);
    await drain(search);
    const result = query(search, "after_control_needle");
    assert.equal(result.items.length, 1);
    assert(result.items[0]!.excerpt.text.includes("after_control_needle"));
    assert.equal(result.items[0]!.position.end, text.length);
    assert.equal(query(search, "résumé").items.length, 1);
  } finally {
    await search.close();
    db.close();
  }
});

test("transient transfer pressure retries; repeated foreground yields clean partial runs before new builds", async () => {
  const { db, canonical, bytes, search } = open();
  try {
    const t = thread(canonical),
      buffer = new TextEncoder().encode(
        "bounded pressure needle ".repeat(15000),
      ),
      sha256 = hash(buffer);
    bytes.data.set(sha256, buffer);
    message(canonical, t.threadId, { sha256, byteLength: buffer.length });
    bytes.overloadedOpen = true;
    await search.advance({ maxChunks: 1 });
    assert.equal(search.status().failedSources, 0);
    assert.equal(bytes.readers.size, 0);
    bytes.overloadedOpen = false;
    bytes.overloadedSlice = true;
    await search.advance({ maxChunks: 1 });
    assert.equal(search.status().failedSources, 0);
    assert.equal(bytes.readers.size, 1);
    bytes.overloadedSlice = false;
    for (let round = 0; round < 8; round++) {
      await search.advance({ maxChunks: 2 });
      assert.equal(
        db.selectValue("SELECT count(*) FROM quixi_search_chunks"),
        2,
      );
      assert.equal(query(search, "needle").items.length, 0);
      await search.yieldResources();
      assert.equal(bytes.readers.size, 0);
      const opens = bytes.opens;
      await search.advance({ maxChunks: 1 });
      assert.equal(
        db.selectValue("SELECT count(*) FROM quixi_search_chunks"),
        1,
      );
      assert.equal(bytes.opens, opens);
      await search.advance({ maxChunks: 1 });
      assert.equal(
        db.selectValue("SELECT count(*) FROM quixi_search_chunks"),
        0,
      );
      assert.equal(bytes.opens, opens);
    }
    await drain(search);
    assert.equal(search.status().failedSources, 0);
    assert(query(search, "needle").items.length > 0);
    assert.equal(bytes.readers.size, 0);
  } finally {
    await search.close();
    db.close();
  }
});

test("missing derived tables isolate canonical writes; explicit repair restores triggers and indexing", async () => {
  const { db, canonical, search } = open();
  try {
    const t = thread(canonical);
    message(canonical, t.threadId, "repair original needle");
    await drain(search);
    db.exec("DROP TABLE quixi_search_queue");
    assert.throws(() => search.initialize(), /missing/);
    message(canonical, t.threadId, "repair later needle");
    const records = db.selectValue("SELECT count(*) FROM quixi_records"),
      ops = db.selectValue("SELECT count(*) FROM quixi_sync_ops");
    assert.equal(
      db.selectValue(
        "SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name IN('quixi_search_dirty_insert','quixi_search_dirty_update','quixi_search_dirty_delete')",
      ),
      0,
    );
    const operationId = id();
    search.repairDerived({ operationId });
    await drain(search);
    assert.equal(query(search, "repair").items.length, 2);
    const before = search.status().revision;
    search.repairDerived({ operationId });
    assert.equal(search.status().revision, before);
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_records"), records);
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_sync_ops"), ops);
    message(canonical, t.threadId, "repair following needle");
    await drain(search);
    assert.equal(query(search, "repair").items.length, 3);
    assert.equal(db.selectValue("PRAGMA integrity_check"), "ok");
  } finally {
    await search.close();
    db.close();
  }
});

test("repair can release held bytes even when the derived build table disappeared", async () => {
  const { db, canonical, bytes, search } = open();
  try {
    const t = thread(canonical),
      buffer = new TextEncoder().encode("held repair needle ".repeat(5000)),
      sha256 = hash(buffer);
    bytes.data.set(sha256, buffer);
    message(canonical, t.threadId, { sha256, byteLength: buffer.length });
    await search.advance({ maxChunks: 1 });
    assert.equal(bytes.readers.size, 1);
    db.exec("DROP TABLE quixi_search_builds");
    await assert.rejects(search.yieldResources());
    assert.equal(bytes.readers.size, 0);
    search.repairDerived({ operationId: id() });
    await drain(search);
    assert(query(search, "needle").items.length > 0);
  } finally {
    await search.close();
    db.close();
  }
});

test("tombstone during held source indexing prevents partial publication and releases the reader", async () => {
  const { db, canonical, bytes, search } = open();
  try {
    const t = thread(canonical),
      buffer = new TextEncoder().encode("deleted held needle ".repeat(15000)),
      sha256 = hash(buffer);
    bytes.data.set(sha256, buffer);
    const source = message(canonical, t.threadId, {
      sha256,
      byteLength: buffer.length,
    });
    await search.advance({ maxChunks: 1 });
    assert.equal(bytes.readers.size, 1);
    const state = canonical.get("threadStates", t.threadId)!;
    commit(canonical, "TombstoneBranch", {
      tombstone: {
        id: id(),
        threadId: t.threadId,
        rootMessageId: source.messageId,
        createdAt: now,
        reason: null,
      },
      state: {
        ...state,
        activeLeafMessageId: null,
        revision: state.revision + 1,
      },
    });
    await drain(search);
    assert.equal(query(search, "needle").items.length, 0);
    assert.equal(bytes.readers.size, 0);
    assert.equal(db.selectValue("SELECT count(*) FROM quixi_search_chunks"), 0);
  } finally {
    await search.close();
    db.close();
  }
});

test("search result bytes are bounded and FTS operators remain literal user terms", async () => {
  const { db, canonical, search } = open();
  try {
    const t = thread(canonical);
    message(canonical, t.threadId, "literal OR needle");
    message(canonical, t.threadId, "needle without operator");
    await drain(search);
    // Best and Exact require every term (ADR 0037); OR stays a literal word.
    assert.equal(query(search, "OR needle").items.length, 1);
    assert.equal(query(search, "OR needle").items[0]!.excerpt.text, "literal OR needle");
    assert.equal(search.search({ query: "OR needle", mode: "exact", filters: {}, page: { maxItems: 100, maxBytes: 100000, cursor: null } }).items.length, 1);
    const args = {
      query: "needle",
      mode: "exact" as const,
      filters: {},
      page: { maxItems: 100, maxBytes: 32, cursor: null },
    };
    assert.throws(() => search.search(args), /byte budget/);
    const budget = search.search({
      ...args,
      page: { ...args.page, maxItems: 1, maxBytes: 10000 },
    }).bytes;
    const result = search.search({
      ...args,
      page: { ...args.page, maxBytes: budget },
    });
    assert(result.bytes <= budget);
    assert.equal(result.modeUsed, "exact");
    assert(result.nextCursor);
  } finally {
    await search.close();
    db.close();
  }
});

function canonicalDigest(db: CanonicalSqlite) {
  return createHash("sha256").update(JSON.stringify({
    records: db.exec({ sql: "SELECT collection,id,payload FROM quixi_records ORDER BY collection,id", rowMode: "object", returnValue: "resultRows" }),
    operations: db.exec({ sql: "SELECT * FROM quixi_sync_ops ORDER BY sequence", rowMode: "object", returnValue: "resultRows" }),
  })).digest("hex");
}
function incrementalSource(f: ReturnType<typeof open>) {
  const t = thread(f.canonical),
    data = new TextEncoder().encode("verification ordinary text ".repeat(24000) + " incremental_tail_needle"),
    sha256 = hash(data);
  f.bytes.incremental = true;
  f.bytes.data.set(sha256, data);
  return { ...t, ...message(f.canonical, t.threadId, { sha256, byteLength: data.length }), data, sha256 };
}
const verifiedTotal = (bytes: Bytes) => bytes.verificationSteps.reduce((sum, step) => sum + step.delta, 0);

test("incremental verification spends at most one byte budget per admission and publishes no prefix", async () => {
  const f = open();
  try {
    const source = incrementalSource(f), before = canonicalDigest(f.db);
    let total = 0, previous = 0, slices = 0;
    while (total < source.data.length) {
      const status = await f.search.advance({ maxChunks: 16 });
      total = verifiedTotal(f.bytes);
      assert(total > previous, "A runnable verification admission must advance");
      assert(total - previous <= 131072, "Multiple verifier steps must share the admission budget");
      assert.equal(f.bytes.opens, 1);
      assert.equal(f.bytes.readers.size, 1);
      if (total < source.data.length) {
        assert.equal(status.activeSource?.phase, "verifying");
        assert.equal(status.activeSource?.readBytes, total);
        assert.equal(status.activeSource?.sourceBytes, source.data.length);
        assert.equal(f.db.selectValue("SELECT count(*) FROM quixi_search_chunks"), 0);
        assert.equal(query(f.search, "verification").items.length, 0);
        assert.equal(f.bytes.peakRange, 0);
      }
      previous = total;
      assert(++slices < 20);
    }
    assert(slices > 1);
    assert.equal(new Set(f.bytes.verificationSteps.map(step => step.transferId)).size, 1);
    await drain(f.search);
    assert.equal(query(f.search, "incremental_tail_needle").items.length, 1);
    assert.equal(f.bytes.opens, 1, "Chunking reuses the verified parent");
    assert.equal(f.bytes.readers.size, 0);
    assert.equal(f.bytes.verifiers.size, 0);
    assert.equal(canonicalDigest(f.db), before);
  } finally { await f.search.close(); f.db.close(); }
});

test("foreground cancellation discards a partially verified source and retry hashes from byte zero", async () => {
  const f = open();
  try {
    incrementalSource(f);
    await f.search.advance({ maxChunks: 16 });
    const held = [...f.bytes.verifiers.keys()][0]!;
    assert(held);
    const firstBytes = verifiedTotal(f.bytes);
    assert(firstBytes > 0);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.bytes.verifyWait = () => new Promise<void>(resolve => { release = resolve; entered(); });
    const abort = new AbortController();
    const pending = f.search.advance({ maxChunks: 16 }, abort.signal);
    await waiting;
    abort.abort();
    release();
    await pending;
    assert(f.bytes.discarded.includes(held));
    assert.equal(f.bytes.readers.size, 0);
    assert.equal(f.bytes.verifiers.size, 0);
    assert.equal(f.search.status().failedSources, 0);
    assert.equal(f.search.status().activeSource, null);
    assert.equal(query(f.search, "verification").items.length, 0);
    assert.equal(verifiedTotal(f.bytes), firstBytes);
    f.bytes.verifyWait = null;
    await f.search.advance({ maxChunks: 16 });
    const next = [...f.bytes.verifiers.entries()][0]!;
    assert(next && next[0] !== held);
    assert(next[1].verifiedBytes > 0 && next[1].verifiedBytes <= 131072);
    await drain(f.search);
    assert.equal(f.bytes.opens, 2);
    assert.equal(query(f.search, "incremental_tail_needle").items.length, 1);
  } finally { await f.search.close(); f.db.close(); }
});

test("owner restart drops verification handles and re-verifies the complete original before indexing", async () => {
  const f = open();
  let restarted: SearchRepository | null = null;
  try {
    const source = incrementalSource(f), before = canonicalDigest(f.db);
    await f.search.advance({ maxChunks: 16 });
    const held = [...f.bytes.verifiers.keys()][0]!;
    assert(held);
    await f.search.close();
    assert(f.bytes.discarded.includes(held));
    assert.equal(f.bytes.readers.size, 0);
    restarted = new SearchRepository(f.db, f.bytes);
    restarted.initialize();
    await restarted.advance({ maxChunks: 16 });
    assert.equal(restarted.status().activeSource?.phase, "verifying");
    assert.equal(restarted.status().activeSource?.readBytes, 131072);
    assert.equal(query(restarted, "verification").items.length, 0);
    await drain(restarted);
    const retries = f.bytes.verificationSteps.filter(step => step.transferId !== held);
    assert.equal(retries.reduce((sum, step) => sum + step.delta, 0), source.data.length);
    assert.equal(f.bytes.opens, 2);
    assert.equal(query(restarted, "incremental_tail_needle").items.length, 1);
    assert.equal(canonicalDigest(f.db), before);
  } finally { await restarted?.close(); await f.search.close(); f.db.close(); }
});

for (const invalidation of ["title", "tombstone"] as const) {
  test(`${invalidation} invalidation discards a partially verified parent before any source publication`, async () => {
    const f = open();
    try {
      const source = incrementalSource(f);
      await f.search.advance({ maxChunks: 16 });
      const held = [...f.bytes.verifiers.keys()][0]!;
      assert(held);
      if (invalidation === "title") {
        commit(f.canonical, "SetTitle", { threadId: source.threadId, value: "Replacement title" });
      } else {
        const state = f.canonical.get("threadStates", source.threadId)!;
        commit(f.canonical, "TombstoneBranch", {
          tombstone: { id: id(), threadId: source.threadId, rootMessageId: source.messageId, createdAt: now, reason: null },
          state: { ...state, activeLeafMessageId: null, revision: state.revision + 1 },
        });
      }
      const before = canonicalDigest(f.db);
      await f.search.advance({ maxChunks: 16 });
      assert(f.bytes.discarded.includes(held));
      assert(!f.bytes.readers.has(held));
      assert.equal(query(f.search, "verification").items.length, 0);
      assert.equal(f.db.selectValue("SELECT count(*) FROM quixi_search_chunks"), 0);
      await drain(f.search);
      assert.equal(f.bytes.opens, invalidation === "title" ? 2 : 1);
      assert.equal(query(f.search, "incremental_tail_needle").items.length, invalidation === "title" ? 1 : 0);
      assert.equal(f.bytes.readers.size, 0);
      assert.equal(canonicalDigest(f.db), before);
    } finally { await f.search.close(); f.db.close(); }
  });
}

test("late digest mismatch releases verification without derived publication or canonical changes", async () => {
  const f = open();
  try {
    const source = incrementalSource(f);
    source.data[source.data.length - 1] = source.data[source.data.length - 1]! ^ 1;
    const before = canonicalDigest(f.db);
    await f.search.advance({ maxChunks: 16 });
    assert.equal(f.search.status().failedSources, 0, "Digest failure occurs at completion");
    assert.equal(f.search.status().activeSource?.phase, "verifying");
    const failed = await drain(f.search);
    assert.equal(failed.failedSources, 1);
    assert.match(failed.lastFailure!.reason, /verification failed/);
    const attempts = new Map<string, number>();
    for (const step of f.bytes.verificationSteps)
      attempts.set(step.transferId, (attempts.get(step.transferId) ?? 0) + step.delta);
    assert(attempts.size > 0);
    for (const total of attempts.values()) assert.equal(total, source.data.length);
    assert.equal(f.bytes.peakRange, 0);
    assert.equal(f.bytes.readers.size, 0);
    assert.equal(f.bytes.verifiers.size, 0);
    assert.equal(f.db.selectValue("SELECT count(*) FROM quixi_search_chunks"), 0);
    assert.equal(query(f.search, "verification").items.length, 0);
    assert.equal(canonicalDigest(f.db), before);
    assert.equal(f.db.selectValue("PRAGMA integrity_check"), "ok");
  } finally { await f.search.close(); f.db.close(); }
});
