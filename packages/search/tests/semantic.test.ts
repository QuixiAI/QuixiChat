import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import initialize from "../../storage/sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../storage/src/worker/canonical/index.ts";
import type { CanonicalSqlite } from "../../storage/src/worker/canonical/repository.ts";
import { SearchRepository } from "../../storage/src/worker/search/index.ts";
import type { SearchBlobAccess, SearchChunkTokenizer } from "../../storage/src/worker/search/index.ts";
import { createStorageChunkTokenizer } from "../../storage/src/worker/search/tokenizer.ts";
import { semanticInput, semanticInputDigest, SEMANTIC_CLAIM_LEASE_MS } from "../../storage/src/worker/search/semantic.ts";
import { SEARCH_POLICY } from "../../storage/src/worker/search/schema.ts";
import { MODEL_LOCK } from "@quixi/quixi-embed";
import type { CanonicalMutation, EmbeddingModelIdentity, SearchFilters, SearchOperations } from "@quixi/core/contracts";
import type { ContentPart, Message } from "@quixi/core/model";

const wasm = await readFile(new URL("../../storage/sqlite/dist/sqlite3.wasm", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../../storage/sqlite/artifacts.json", import.meta.url), "utf8"));
assert.equal(createHash("sha256").update(wasm).digest("hex"), manifest.artifacts["sqlite3.wasm"].sha256);
(globalThis as any).sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const initOptions = {
  instantiateWasm: async (imports: WebAssembly.Imports, success: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) => {
    const result = await WebAssembly.instantiate(wasm, imports);
    success(result.instance, result.module);
  },
  print: () => {}, printErr: () => {},
};
const sqlite = (await initialize(initOptions)) as { oo1: { DB: new (name: string, flags: string) => CanonicalSqlite & { close(): void; selectValue(sql: string, bind?: unknown[]): unknown } } };
const tokenizerWasm = new Uint8Array(await readFile(new URL("../../quixi-embed/artifacts/1.0.2/quixi-scalar.wasm", import.meta.url)));
const tokenizerBytes = new Uint8Array(await readFile(new URL("../../quixi-embed/artifacts/model/arctic-xs.qxtokenizer", import.meta.url)));
const chunkTokenizer: SearchChunkTokenizer = await createStorageChunkTokenizer({ wasm: tokenizerWasm, tokenizer: tokenizerBytes });
const lock = JSON.parse(await readFile(new URL("../../quixi-embed/artifacts/model/lock.json", import.meta.url), "utf8"));
const id = () => randomUUID(), now = 1700000000000;
/** Text sources only; byte reads are never admitted in these cases. */
const noBlobs: SearchBlobAccess = {
  openRead: async () => { throw new Error("no blobs"); }, beginVerifiedRead: async () => { throw new Error("no blobs"); },
  advanceVerifiedRead: async () => { throw new Error("no blobs"); }, sliceRead: () => { throw new Error("no blobs"); },
  readChunk: () => { throw new Error("no blobs"); }, acknowledge: () => {}, discard: async () => {},
};
function open(options: { tokenizer?: boolean; now?: () => number } = {}) {
  const db = new sqlite.oo1.DB(`/semantic-${id()}.sqlite3`, "c"),
    canonical = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  canonical.migrate();
  const make = (clock?: () => number) => new SearchRepository(db, noBlobs, { ...(options.tokenizer === false ? {} : { chunkTokenizer }), ...(clock ? { now: clock } : {}) });
  const search = make(options.now);
  search.initialize();
  return { db, canonical, search, reopen: (clock?: () => number) => { const next = make(clock); next.initialize(); return next; } };
}
function commit(repository: CanonicalRepository, kind: CanonicalMutation["kind"], payload: unknown) {
  return repository.commit({ transactionId: id(), mutations: [{ version: 1, operationId: id(), kind, recordedAt: now, payload } as CanonicalMutation], expectedThreadRevisions: [], stagedBlobIds: [] });
}
function thread(canonical: CanonicalRepository, title = "Research archive") {
  const threadId = id(), contextId = id();
  commit(canonical, "CreateThread", {
    thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null },
    context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now },
    state: { threadId, title, tags: ["research"], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 },
  });
  return threadId;
}
function message(canonical: CanonicalRepository, threadId: string, text: string) {
  const messageId = id(), partId = id();
  const record: Message = { id: messageId, threadId, parentId: null, role: "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true };
  const part: ContentPart = { id: partId, messageId, order: 0, kind: "Text", data: { text } };
  commit(canonical, "CreateMessage", { message: record, parts: [part] });
  return messageId;
}
async function drain(search: SearchRepository) {
  for (let i = 0; i < 2000; i++) {
    const status = await search.advance({ maxChunks: 16 });
    if (status.pendingSources === 0) return status;
  }
  throw new Error("Index did not finish bounded maintenance");
}
const model = (chunkingVersion: string, sourceHash: string = MODEL_LOCK.model.sha256): EmbeddingModelIdentity => ({
  modelName: MODEL_LOCK.modelName, modelVersion: MODEL_LOCK.sourceRevision, sourceHash, dimensions: 384,
  tokenizerVersion: chunkTokenizer.version, preprocessingVersion: MODEL_LOCK.preprocessingVersion, chunkingVersion, storageRepresentation: "float32",
});
/** Deterministic synthetic unit vectors: a topic direction plus a small
 * per-text perturbation, so nearest neighbours follow the topic. */
function vectorFor(topic: number, text: string): number[] {
  const values = new Array<number>(384).fill(0);
  values[topic] = 1;
  const digest = createHash("sha256").update(text).digest();
  for (let i = 0; i < 32; i++) values[100 + i] = (digest[i]! / 255 - 0.5) * 0.05;
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}
const queryVector = (topic: number) => vectorFor(topic, "query");
async function indexAll(search: SearchRepository, topicFor: (text: string) => number) {
  const claim = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
  const publication = search.publishSemanticVectors({ generation: claim.generation, items: claim.items.map((item) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: vectorFor(topicFor(item.text), item.text) })) });
  return { claim, publication };
}
const page = (search: SearchRepository, args: Partial<SearchOperations["searchArchive"]["args"]> & { mode: "exact" | "best" | "semantic" }, filters: SearchFilters = {}, cursor: string | null = null) =>
  search.search({ query: "", filters, page: { maxItems: 50, maxBytes: 200_000, cursor }, ...args });

test("typed lock mirrors artifacts/model/lock.json", () => {
  assert.equal(MODEL_LOCK.model.sha256, lock.model.sha256);
  assert.equal(MODEL_LOCK.model.bytes, lock.model.bytes);
  assert.equal(MODEL_LOCK.tokenizer.sha256, lock.tokenizer.sha256);
  assert.equal(MODEL_LOCK.wasm.scalar.sha256, lock.wasm.scalar.sha256);
  assert.equal(MODEL_LOCK.wasm.simd.sha256, lock.wasm.simd.sha256);
  assert.equal(MODEL_LOCK.sourceRevision, lock.sourceRevision);
  assert.equal(MODEL_LOCK.runtimeVersion, lock.runtimeVersion);
});

test("model-aware chunking bounds every chunk and its context-prefixed input to the model budget", async () => {
  const { db, canonical, search } = open();
  try {
    assert.match(search.version, /arctic-xs-offsets-1\.0\.2:d15cd90acf9df739:256:/);
    const threadId = thread(canonical, "A very long title ".repeat(40));
    const sentence = "The migration check finished before the release decision was recorded in the archive. ";
    message(canonical, threadId, sentence.repeat(120));
    await drain(search);
    const chunks = db.exec({ sql: "SELECT payload FROM quixi_search_chunks", rowMode: "object", returnValue: "resultRows" }) as { payload: string }[];
    assert.ok(chunks.length >= 6, `token budget splits long text (${chunks.length} chunks)`);
    for (const row of chunks) {
      const chunk = JSON.parse(row.payload) as { text: string; contextPrefix: string };
      const inspection = chunkTokenizer.inspect(chunk.text, "document");
      assert.ok(!inspection.overflow && inspection.tokenCount <= SEARCH_POLICY.maxTokens + 2, `chunk fits ${inspection.tokenCount}`);
    }
    search.enrollSemantic({ operationId: id(), model: model(search.version) });
    const claim = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    assert.equal(claim.items.length, chunks.length);
    for (const item of claim.items) {
      assert.ok(!chunkTokenizer.inspect(item.text, "document").overflow, "claimed input fits with its context prefix");
      assert.equal(item.textDigest, semanticInputDigest(item.text));
      assert.ok(item.text.includes("\n\n"), "context prefix precedes the text");
    }
    const lexicalOnly = open({ tokenizer: false });
    try { assert.match(lexicalOnly.search.version, /:none:none:/); } finally { await lexicalOnly.search.close(); lexicalOnly.db.close(); }
  } finally { await search.close(); db.close(); }
});

test("enrolment, bounded claims, publication and hybrid RRF explanations with consistent filters", async () => {
  const { db, canonical, search } = open();
  try {
    const cats = thread(canonical, "Cats"), storage = thread(canonical, "Storage");
    message(canonical, cats, "Kittens purr when they are content and warm.");
    message(canonical, cats, "Adult felines sleep for most of the day.");
    message(canonical, storage, "The OPFS decision was recorded after the migration check passed.");
    message(canonical, storage, "Durable commits need synchronous access handles.");
    await drain(search);
    let status = search.semanticStatus();
    assert.equal(status.state, "disabled");
    assert.equal(search.status().semantic.state, "unavailable");
    assert.throws(() => page(search, { mode: "semantic", queryVector: queryVector(1) }), /not enabled/);
    const identity = model(search.version);
    status = search.enrollSemantic({ operationId: id(), model: identity });
    assert.equal(status.state, "enrolled");
    assert.equal(status.pendingChunks, 4);
    assert.equal(status.generation, 2);
    assert.throws(() => page(search, { mode: "semantic" }), /needs the query embedded/);
    // Bounded claim: two chunks, newest first, each leased.
    const first = search.claimSemanticChunks({ maxChunks: 2, maxBytes: 1_048_576 });
    assert.equal(first.items.length, 2);
    assert.equal(first.generation, 2);
    const second = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    assert.equal(second.items.length, 2, "leased chunks are not offered again");
    assert.equal(new Set([...first.items, ...second.items].map((item) => item.chunkId)).size, 4);
    const topic = (text: string) => (/kitten|feline/i.test(text) ? 1 : 2);
    for (const claim of [first, second]) {
      const publication = search.publishSemanticVectors({ generation: 2, items: claim.items.map((item) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: vectorFor(topic(item.text), item.text) })) });
      assert.equal(publication.accepted, 2);
      assert.deepEqual(publication.rejected, []);
    }
    status = search.semanticStatus();
    assert.equal(status.indexedChunks, 4);
    assert.equal(status.pendingChunks, 0);
    assert.equal(status.vectors, 4);
    assert.equal(status.vectorBytes, 4 * 384 * 4);
    assert.equal(search.status().semantic.state, "ready");
    // Semantic mode: topic neighbours first, explained as semantic matches.
    const semantic = page(search, { mode: "semantic", queryVector: queryVector(1) });
    assert.equal(semantic.modeUsed, "semantic");
    assert.equal(semantic.items.length, 4);
    assert.deepEqual(semantic.items.slice(0, 2).map((hit) => hit.title).sort(), ["Cats", "Cats"]);
    assert.ok(semantic.items.every((hit) => hit.explanation === "Semantic match"));
    assert.ok(semantic.items[0]!.score > semantic.items[3]!.score);
    // Best: fused ranks explain their origin; a lexical-only hit stays.
    const best = page(search, { mode: "best", query: "migration", queryVector: queryVector(1) });
    assert.equal(best.modeUsed, "hybrid");
    const byTitle = (title: string) => best.items.filter((hit) => hit.title === title);
    assert.equal(byTitle("Cats").length, 2);
    assert.ok(byTitle("Cats").every((hit) => hit.explanation === "Semantic match"));
    const migration = best.items.find((hit) => /migration/.test(hit.excerpt.text))!;
    assert.equal(migration.explanation, "Exact + semantic match");
    assert.ok(migration.excerpt.highlights.length >= 1, "lexical highlight retained in fused hit");
    assert.equal(best.items[0], migration, "a hit ranked by both lists wins RRF");
    // Exact never uses the vector; lexical-only Best without a vector stays lexical.
    const exact = page(search, { mode: "exact", query: "migration", queryVector: queryVector(1) });
    assert.equal(exact.modeUsed, "exact");
    assert.equal(exact.items.length, 1);
    assert.equal(page(search, { mode: "best", query: "migration" }).modeUsed, "best_lexical");
    // Filters apply identically to both rankings.
    const filtered = page(search, { mode: "best", query: "migration", queryVector: queryVector(1) }, { threadIds: [storage] });
    assert.ok(filtered.items.every((hit) => hit.threadId === storage));
    assert.equal(filtered.items.length, 2);
    const semanticFiltered = page(search, { mode: "semantic", queryVector: queryVector(1) }, { threadIds: [cats] });
    assert.equal(semanticFiltered.items.length, 2);
    // Deterministic fused pages: bounded cursor continues without repeats.
    const one = search.search({ query: "migration", mode: "best", filters: {}, page: { maxItems: 1, maxBytes: 200_000, cursor: null }, queryVector: queryVector(1) });
    assert.equal(one.items.length, 1);
    assert.ok(one.nextCursor);
    const two = search.search({ query: "migration", mode: "best", filters: {}, page: { maxItems: 1, maxBytes: 200_000, cursor: one.nextCursor }, queryVector: queryVector(1) });
    assert.notEqual(two.items[0]!.chunkId, one.items[0]!.chunkId);
    assert.throws(() => search.search({ query: "other", mode: "best", filters: {}, page: { maxItems: 1, maxBytes: 200_000, cursor: one.nextCursor }, queryVector: queryVector(1) }), /restart pagination/);
    assert.throws(() => page(search, { mode: "semantic", queryVector: new Array(384).fill(0) }), /unit/);
    // Same-identity re-enrolment keeps vectors; a different identity drops them.
    assert.equal(search.enrollSemantic({ operationId: id(), model: identity }).vectors, 4);
    const replaced = search.enrollSemantic({ operationId: id(), model: model(search.version, "f".repeat(64)) });
    assert.equal(replaced.vectors, 0);
    assert.equal(replaced.generation, 3);
    assert.equal(replaced.pendingChunks, 4);
  } finally { await search.close(); db.close(); }
});

test("stale generations, changed chunks, duplicates and malformed vectors are rejected individually", async () => {
  const { db, canonical, search } = open();
  try {
    const threadId = thread(canonical);
    message(canonical, threadId, "First passage about vector publication.");
    message(canonical, threadId, "Second passage about vector publication.");
    await drain(search);
    search.enrollSemantic({ operationId: id(), model: model(search.version) });
    const claim = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    assert.equal(claim.items.length, 2);
    const [a, b] = claim.items as [typeof claim.items[number], typeof claim.items[number]];
    const good = (item: typeof a) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: vectorFor(3, item.text) });
    let publication = search.publishSemanticVectors({ generation: claim.generation + 1, items: [good(a)] });
    assert.deepEqual(publication.rejected, [{ chunkId: a.chunkId, reason: "stale_generation" }]);
    publication = search.publishSemanticVectors({ generation: claim.generation, items: [{ ...good(a), textDigest: "0".repeat(64) }, { ...good(b), vector: new Array(384).fill(0) }] });
    assert.deepEqual(publication.rejected, [{ chunkId: a.chunkId, reason: "chunk_changed" }, { chunkId: b.chunkId, reason: "invalid_vector" }]);
    assert.equal(publication.accepted, 0);
    publication = search.publishSemanticVectors({ generation: claim.generation, items: [good(a), good(a), good(b)] });
    assert.equal(publication.accepted, 2);
    assert.deepEqual(publication.rejected, [{ chunkId: a.chunkId, reason: "duplicate" }]);
    publication = search.publishSemanticVectors({ generation: claim.generation, items: [good(b)] });
    assert.deepEqual(publication.rejected, [{ chunkId: b.chunkId, reason: "duplicate" }]);
    assert.equal(search.semanticStatus().vectors, 2);
    // The delete boundary rejects later publications for the old generation.
    const deleted = search.deleteSemanticIndex({ operationId: id() });
    assert.equal(deleted.state, "disabled");
    assert.equal(deleted.vectors, 0);
    publication = search.publishSemanticVectors({ generation: claim.generation, items: [good(a)] });
    assert.deepEqual(publication.rejected, [{ chunkId: a.chunkId, reason: "stale_generation" }]);
  } finally { await search.close(); db.close(); }
});

test("pause refuses claims, resume and restart continue only missing chunks, and expired leases return", async () => {
  let clock = now;
  const { db, canonical, search, reopen } = open({ now: () => clock });
  try {
    const threadId = thread(canonical);
    for (let n = 0; n < 4; n++) message(canonical, threadId, `Passage ${n} about resumable indexing work. `.repeat(20));
    await drain(search);
    search.enrollSemantic({ operationId: id(), model: model(search.version) });
    const first = search.claimSemanticChunks({ maxChunks: 2, maxBytes: 1_048_576 });
    search.publishSemanticVectors({ generation: first.generation, items: first.items.map((item) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: vectorFor(4, item.text) })) });
    assert.equal(search.setSemanticState({ state: "paused" }).state, "paused");
    assert.equal(search.status().semantic.state, "ready", "stored vectors remain searchable while paused");
    assert.equal(search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 }).items.length, 0);
    assert.equal(search.setSemanticState({ state: "enrolled" }).state, "enrolled");
    // Owner restart: the same database, a fresh repository, only missing chunks.
    const restarted = reopen(() => clock);
    const remaining = restarted.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    assert.equal(remaining.items.length, 2);
    assert.ok(remaining.items.every((item) => !first.items.some((done) => done.chunkId === item.chunkId)));
    assert.equal(restarted.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 }).items.length, 0, "leased");
    clock += SEMANTIC_CLAIM_LEASE_MS + 1;
    const again = restarted.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    assert.deepEqual(again.items.map((item) => item.chunkId).sort(), remaining.items.map((item) => item.chunkId).sort());
    // Byte bound: one oversized item still makes progress; a second waits.
    const bounded = restarted.claimSemanticChunks({ maxChunks: 64, maxBytes: 1024 });
    assert.equal(bounded.items.length, 0, "the lease from the previous claim still holds");
    clock += SEMANTIC_CLAIM_LEASE_MS + 1;
    assert.equal(restarted.claimSemanticChunks({ maxChunks: 64, maxBytes: 1024 }).items.length, 1);
    await restarted.close();
  } finally { await search.close(); db.close(); }
});

test("lexical rebuilds relink vectors by exact input digest without inference; source edits invalidate", async () => {
  const { db, canonical, search } = open();
  try {
    const threadId = thread(canonical);
    message(canonical, threadId, "A passage that survives a lexical rebuild.");
    message(canonical, threadId, "Another passage that survives a lexical rebuild.");
    await drain(search);
    search.enrollSemantic({ operationId: id(), model: model(search.version) });
    const { publication } = await indexAll(search, () => 5);
    assert.equal(publication.accepted, 2);
    search.rebuild({ operationId: id() });
    await drain(search);
    const relinked = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    assert.equal(relinked.items.length, 0);
    assert.equal(relinked.reused, 0, "identical chunk identity keeps its link through the epoch swap");
    const status = search.semanticStatus();
    assert.equal(status.indexedChunks, 2);
    assert.equal(status.vectors, 2);
    // A title edit changes context, hence chunk identity: the old vector is
    // orphaned and the chunk needs a new input, never a silently reused one.
    commit(canonical, "SetTitle", { threadId, value: "Renamed archive" });
    await drain(search);
    const after = search.semanticStatus();
    assert.equal(after.pendingChunks, 2);
    assert.equal(after.indexedChunks, 0);
    const refreshed = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    assert.equal(refreshed.items.length, 2);
    assert.ok(refreshed.items.every((item) => item.text.startsWith("Renamed archive")));
    for (let i = 0; i < 10 && search.maintainSemantic(64).remaining; i++);
    assert.equal(search.semanticStatus().vectors, 0, "orphaned vectors are removed by bounded maintenance");
  } finally { await search.close(); db.close(); }
});

test("deleting or breaking the semantic index leaves canonical history and lexical search intact", async () => {
  const { db, canonical, search, reopen } = open();
  try {
    const threadId = thread(canonical);
    message(canonical, threadId, "Canonical passage kept through semantic deletion.");
    await drain(search);
    search.enrollSemantic({ operationId: id(), model: model(search.version) });
    await indexAll(search, () => 6);
    const records = Number(db.selectValue("SELECT count(*) FROM quixi_records")), syncOps = Number(db.selectValue("SELECT count(*) FROM quixi_sync_ops"));
    const operationId = id();
    const deleted = search.deleteSemanticIndex({ operationId });
    assert.equal(deleted.vectors, 0);
    assert.equal(search.deleteSemanticIndex({ operationId }).generation, deleted.generation, "idempotent by operation identity");
    assert.equal(Number(db.selectValue("SELECT count(*) FROM quixi_records")), records);
    assert.equal(Number(db.selectValue("SELECT count(*) FROM quixi_sync_ops")), syncOps);
    assert.equal(page(search, { mode: "best", query: "canonical" }).items.length, 1);
    assert.equal(search.status().semantic.state, "unavailable");
    // A damaged semantic namespace never disables lexical search; explicit
    // deletion repairs it and enrolment can start again.
    db.exec("DROP TABLE quixi_semantic_links");
    const broken = reopen();
    assert.equal(broken.status().state, "ready");
    assert.match(broken.status().semantic.reason ?? "", /unusable/);
    assert.equal(page(broken, { mode: "best", query: "canonical" }).items.length, 1);
    assert.throws(() => broken.enrollSemantic({ operationId: id(), model: model(broken.version) }), /delete and rebuild/);
    assert.equal(broken.deleteSemanticIndex({ operationId: id() }).state, "disabled");
    assert.equal(broken.enrollSemantic({ operationId: id(), model: model(broken.version) }).pendingChunks, 1);
    await broken.close();
  } finally { await search.close(); db.close(); }
});

test("extracted document pages flow through the same claim pipeline; identical passages share one vector", async () => {
  const { db, canonical, search } = open();
  try {
    const threadId = thread(canonical, "Notes");
    message(canonical, threadId, "A chat message about tomato sauce.");
    const pdfAttachment = id(), pdfDocument = id();
    const pdfBytes = new TextEncoder().encode("%PDF-1.4 synthetic fixture; no extraction executed");
    commit(canonical, "RegisterAttachment", { attachment: { id: pdfAttachment, availability: "available", filename: "source.pdf", mimeType: "application/pdf", sizeBytes: pdfBytes.length, blobSha256: createHash("sha256").update(pdfBytes).digest("hex"), rawObjectId: null } });
    commit(canonical, "RegisterDocument", { document: { id: pdfDocument, workspaceId: id(), attachmentId: pdfAttachment, title: "Registered PDF pages", createdAt: now, recordedAt: now, importSourceId: null } });
    for (const pageNumber of [1, 2])
      search.registerExtractedText({ id: id(), documentId: pdfDocument, attachmentSha256: createHash("sha256").update(pdfBytes).digest("hex"), extractorVersion: "synthetic-page-registration", text: "Simmer the sauce gently for twenty minutes.", page: pageNumber, sectionPath: ["Recipes"], offsetBase: 0 });
    await drain(search);
    search.enrollSemantic({ operationId: id(), model: model(search.version) });
    assert.equal(search.semanticStatus().pendingChunks, 3, "message and both pages are pending");
    const claim = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    const pages = claim.items.filter((item) => item.text.startsWith("Registered PDF pages > Recipes"));
    assert.equal(pages.length, 2, "both pages are offered; the scheduler's singleflight merges identical inputs");
    assert.equal(new Set(pages.map((item) => item.textDigest)).size, 1, "identical page passages share one embedding input digest");
    assert.equal(claim.items.length, 3);
    const published = search.publishSemanticVectors({ generation: claim.generation, items: claim.items.map((item) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: vectorFor(item.text.includes("Recipes") ? 7 : 8, item.text) })) });
    assert.equal(published.accepted, 3);
    const status = search.semanticStatus();
    assert.equal(status.indexedChunks, 3);
    assert.equal(status.vectors, 2, "the second page links to the first page's stored vector");
    const hits = page(search, { mode: "semantic", queryVector: queryVector(7) }, { sourceTypes: ["document"] });
    assert.equal(hits.items.length, 2);
    assert.deepEqual(hits.items.map((hit) => hit.position.page).sort(), [1, 2]);
    assert.ok(hits.items.every((hit) => hit.documentId === pdfDocument && hit.explanation === "Semantic match"));
    assert.equal(page(search, { mode: "semantic", queryVector: queryVector(7) }, { sourceTypes: ["message"] }).items.length, 1);
  } finally { await search.close(); db.close(); }
});

test("embedding inputs use the product context format", () => {
  assert.equal(semanticInput("Thread > user", "body"), "Thread > user\n\nbody");
  assert.equal(semanticInput("", "body"), "body");
});
