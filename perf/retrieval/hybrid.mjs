/** Plan 22 task 7: the complete hybrid benchmark through the production
 * storage repository, plus the product §50 chunk-size sweep.
 *
 * Part 1 (hybrid): the plan 16 corpus is committed to a canonical archive in
 * the pinned SQLite WASM (conversation-like records as messages in their own
 * threads; document and code records as registered document pages), indexed
 * by the production lexical chunker with the pinned Arctic tokenizer, then
 * enrolled and embedded with the WASM SIMD encoder through the real
 * claim→publish protocol. Every judged query is run in the three product
 * modes — Exact (BM25), Semantic (vector KNN) and Best (RRF k=60, ADR 0034)
 * — with no filter, with a source-type filter, and with a thread filter
 * covering half the threads. Metrics use metrics.py's definitions
 * (document-level recall@k and MRR after collapsing chunk hits to the best
 * rank per document; the judged set restricted to visible documents when a
 * filter applies). The same repository is run twice more with the coarse
 * stage forced on (`semanticCoarseThreshold: 1`) so the sign-bit coarse path
 * (ADR 0036 amendment 2) is measured end to end against the exact path.
 *
 * Part 2 (chunk sizes): the production structural chunker at every §50 token
 * budget (128–448) with exact FP32 semantic ranking from the same encoder,
 * outside storage, so the effect of the budget alone is visible.
 *
 *   node --experimental-transform-types perf/retrieval/hybrid.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { arch, platform, release, cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import initialize from "../../packages/storage/sqlite/dist/sqlite3.mjs";
import { CanonicalRepository } from "../../packages/storage/src/worker/canonical/index.ts";
import { SearchRepository } from "../../packages/storage/src/worker/search/index.ts";
import { createStorageChunkTokenizer } from "../../packages/storage/src/worker/search/tokenizer.ts";
import { SEARCH_POLICY } from "../../packages/storage/src/worker/search/schema.ts";
import { SEMANTIC_PROJECTION } from "../../packages/storage/src/worker/search/semantic.ts";
import { StructuralChunker } from "../../packages/search/src/chunker.ts";
import { createSimdEncoder, supportsWasmSimd } from "../../packages/quixi-embed/src/simd.ts";
import { MODEL_LOCK } from "../../packages/quixi-embed/src/lock.ts";

const here = fileURLToPath(new URL("./", import.meta.url)), root = resolve(here, "../../");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = async (name) => readFile(resolve(here, name));
const corpus = (await read("corpus.jsonl")).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
const queries = JSON.parse(await read("queries.json"));
const qrels = JSON.parse(await read("qrels.json"));
const manifest = JSON.parse(await read("corpus-manifest.json"));
for (const [name, expected] of Object.entries(manifest.files ?? {})) if (expected.sha256 && sha256(await read(name)) !== expected.sha256) throw new Error(`${name} does not match corpus-manifest.json`);
const sqliteWasm = await readFile(resolve(root, "packages/storage/sqlite/dist/sqlite3.wasm"));
const sqliteManifest = JSON.parse(await readFile(resolve(root, "packages/storage/sqlite/artifacts.json"), "utf8"));
if (sha256(sqliteWasm) !== sqliteManifest.artifacts["sqlite3.wasm"].sha256) throw new Error("sqlite3.wasm does not match artifacts.json");
const scalarWasm = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/1.0.2/quixi-scalar.wasm")));
const simdWasm = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/1.0.2/quixi-simd.wasm")));
const tokenizerBytes = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/model/arctic-xs.qxtokenizer")));
const model = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/build/arctic-xs.qxmodel")));
if (sha256(model) !== MODEL_LOCK.model.sha256) throw new Error("Model does not match the lock");
if (sha256(simdWasm) !== MODEL_LOCK.wasm.simd.sha256) throw new Error("SIMD WASM does not match the lock");
if (!supportsWasmSimd()) throw new Error("This Node lacks WASM SIMD");
globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const sqlite = await initialize({ instantiateWasm: async (imports, ok) => { const r = await WebAssembly.instantiate(sqliteWasm, imports); ok(r.instance, r.module); }, print: () => {}, printErr: () => {} });
const chunkTokenizer = await createStorageChunkTokenizer({ wasm: scalarWasm, tokenizer: tokenizerBytes });
const encoder = await createSimdEncoder({ wasm: simdWasm, model });
const id = () => randomUUID(), now = 1700000000000;
const noBlobs = { openRead: async () => { throw new Error("no blobs"); }, beginVerifiedRead: async () => { throw new Error("no blobs"); }, advanceVerifiedRead: async () => { throw new Error("no blobs"); }, sliceRead: () => { throw new Error("no blobs"); }, readChunk: () => { throw new Error("no blobs"); }, acknowledge: () => {}, discard: async () => {} };
const identity = (version) => ({ modelName: MODEL_LOCK.modelName, modelVersion: MODEL_LOCK.sourceRevision, sourceHash: MODEL_LOCK.model.sha256, dimensions: 384, tokenizerVersion: chunkTokenizer.version, preprocessingVersion: MODEL_LOCK.preprocessingVersion, chunkingVersion: version, storageRepresentation: "float32" });
// --- Metrics (metrics.py definitions) -----------------------------------------
function evaluate(rankings, visibleDocuments = null) {
  const rows = {};
  for (const [query, judgments] of Object.entries(qrels)) {
    const relevant = new Set(Object.entries(judgments).filter(([doc, grade]) => grade > 0 && (!visibleDocuments || visibleDocuments.has(doc))).map(([doc]) => doc));
    if (!relevant.size) continue;
    const ranking = rankings[query] ?? [], row = {};
    for (const k of [5, 10, 100, 500]) row[`recall@${k}`] = ranking.slice(0, k).filter((doc) => relevant.has(doc)).length / relevant.size;
    const first = ranking.findIndex((doc) => relevant.has(doc)); row.mrr = first === -1 ? 0 : 1 / (first + 1);
    rows[query] = row;
  }
  const keys = ["recall@5", "recall@10", "recall@100", "recall@500", "mrr"];
  return { queries: Object.keys(rows).length, mean: Object.fromEntries(keys.map((key) => [key, Object.values(rows).reduce((sum, row) => sum + row[key], 0) / Object.keys(rows).length])), per_query: rows };
}
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
const timing = (values) => ({ medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samples: values.length });
// --- Part 1: the production repository ----------------------------------------
function commit(canonical, kind, payload) { return canonical.commit({ transactionId: id(), mutations: [{ version: 1, operationId: id(), kind, recordedAt: now, payload }], expectedThreadRevisions: [], stagedBlobIds: [] }); }
async function buildArchive() {
  const db = new sqlite.oo1.DB(`/hybrid-${id()}.sqlite3`, "c"), canonical = new CanonicalRepository(db, { assertBlobAvailable: () => {} });
  canonical.migrate();
  const search = new SearchRepository(db, noBlobs, { chunkTokenizer });
  search.initialize();
  // Titles are uniform so no corpus identifier leaks into BM25 or the context prefix.
  const documentOf = new Map(), threadOf = new Map(), threads = [];
  const started = performance.now();
  for (const record of corpus) {
    if (record.kind === "conversation" || record.kind === "assistant-answer") {
      const threadId = id(), contextId = id(), messageId = id(), partId = id();
      commit(canonical, "CreateThread", { thread: { id: threadId, workspaceId: id(), createdAt: now, recordedAt: now, systemPrompt: null, preferredRoute: null, importSourceId: null }, context: { id: contextId, threadId, previousId: null, version: 1, systemPrompt: null, preferredRoute: null, recordedAt: now }, state: { threadId, title: "Conversation", tags: [], pinned: false, archived: false, activeLeafMessageId: null, contextSnapshotId: contextId, routingProfile: null, revision: 0 } });
      commit(canonical, "CreateMessage", { message: { id: messageId, threadId, parentId: null, role: record.kind === "assistant-answer" ? "assistant" : "user", createdAt: now, recordedAt: now, generationId: null, editedFromMessageId: null, partCount: 1, sealed: true }, parts: [{ id: partId, messageId, order: 0, kind: "Text", data: { text: record.text } }] });
      documentOf.set(messageId, record.id); threadOf.set(threadId, record.id); threads.push(threadId);
    } else {
      const attachmentId = id(), documentId = id(), bytes = new TextEncoder().encode(record.text), digest = sha256(bytes);
      commit(canonical, "RegisterAttachment", { attachment: { id: attachmentId, availability: "available", filename: `${record.kind}.txt`, mimeType: "text/plain", sizeBytes: bytes.length, blobSha256: digest, rawObjectId: null } });
      commit(canonical, "RegisterDocument", { document: { id: documentId, workspaceId: id(), attachmentId, title: "Document", createdAt: now, recordedAt: now, importSourceId: null } });
      search.registerExtractedText({ id: id(), documentId, attachmentSha256: digest, extractorVersion: "benchmark-page", text: record.text, page: 1, sectionPath: [], offsetBase: 0 });
      documentOf.set(documentId, record.id);
    }
  }
  const commitMs = performance.now() - started;
  const lexicalStart = performance.now();
  let status;
  for (let i = 0; i < 100000; i++) { status = await search.advance({ maxChunks: 64 }); if (status.pendingSources === 0) break; }
  if (status.pendingSources !== 0) throw new Error("Lexical indexing did not finish");
  const lexicalMs = performance.now() - lexicalStart;
  search.enrollSemantic({ operationId: id(), model: identity(search.version) });
  const embedStart = performance.now();
  let embedded = 0, reused = 0;
  for (;;) {
    const claim = search.claimSemanticChunks({ maxChunks: 64, maxBytes: 1_048_576 });
    reused += claim.reused;
    if (!claim.items.length) { if (search.semanticStatus().pendingChunks === 0) break; continue; }
    const publication = search.publishSemanticVectors({ generation: claim.generation, items: claim.items.map((item) => ({ chunkId: item.chunkId, textDigest: item.textDigest, vector: Array.from(encoder.embedDocument(item.text)) })) });
    if (publication.rejected.length) throw new Error(`Rejected publications: ${JSON.stringify(publication.rejected.slice(0, 3))}`);
    embedded += publication.accepted;
  }
  const embedMs = performance.now() - embedStart;
  const semantic = search.semanticStatus();
  return { db, search, documentOf, threadOf, threads, status, semantic, timing: { commitMs, lexicalMs, embedMs, embedded, reused } };
}
function documentRanking(items, documentOf) {
  const seen = new Set(), docs = [];
  for (const hit of items) { const doc = documentOf.get(hit.messageId ?? hit.documentId); if (doc && !seen.has(doc)) { seen.add(doc); docs.push(doc); } }
  return docs;
}
function runQueries(search, documentOf, filters, visible, queryVectors, label) {
  const modes = { exact: {}, semantic: {}, best: {} }, latency = { exact: [], semantic: [], best: [] };
  for (const [row, query] of queries.entries()) {
    for (const mode of ["exact", "semantic", "best"]) {
      // Product page bounds; pages are followed by cursor up to 500 hits so recall@500 is measured as the product would deliver it.
      const items = [];
      let cursor = null;
      const t = performance.now();
      do {
        const result = search.search({ mode, query: mode === "semantic" ? "" : query.text, filters, page: { maxItems: 100, maxBytes: 1_000_000, cursor }, ...(mode === "exact" ? {} : { queryVector: queryVectors[row] }) });
        items.push(...result.items);
        cursor = result.nextCursor;
      } while (cursor && items.length < 500);
      latency[mode].push(performance.now() - t);
      modes[mode][query.id] = documentRanking(items, documentOf);
    }
  }
  return { label, filters, results: Object.fromEntries(["exact", "semantic", "best"].map((mode) => [mode, { ...evaluate(modes[mode], visible), latency: timing(latency[mode]) }])) };
}
const report = {
  version: 1, measuredAt: new Date().toISOString(),
  environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version, cpu: cpus()[0]?.model ?? null, note: "Pinned SQLite WASM in Node (in-memory VFS); single observations on a development host, not browser OPFS timings." },
  model: { name: MODEL_LOCK.modelName, artifactSha256: MODEL_LOCK.model.sha256, route: "wasm-simd-fp32", runtime: MODEL_LOCK.runtimeVersion },
  corpus: { manifest, documents: corpus.length, queries: queries.length, kinds: Object.fromEntries([...new Set(corpus.map((r) => r.kind))].map((kind) => [kind, corpus.filter((r) => r.kind === kind).length])) },
  rrf: { k: 60, note: "ADR 0034: Best fuses the top-256 BM25 ranking with a bounded vec0 candidate set by reciprocal rank fusion" },
};
console.error("building the archive through storage");
const archive = await buildArchive();
const queryVectors = queries.map((query) => Array.from(encoder.embedQuery(query.text)));
report.archive = { chunkerVersion: archive.search.version, indexedChunks: archive.status.indexedChunks, vectors: archive.semantic.vectors, semanticIndexedChunks: archive.semantic.indexedChunks, projection: archive.semantic.projection, timing: archive.timing };
const allDocuments = new Set(corpus.map((r) => r.id));
const messageDocuments = new Set(corpus.filter((r) => r.kind === "conversation" || r.kind === "assistant-answer").map((r) => r.id));
const pageDocuments = new Set(corpus.filter((r) => !messageDocuments.has(r.id)).map((r) => r.id));
// The contract bounds a filter list to 32 ids: the thread filter covers the
// 32 threads holding the most judged-relevant documents plus fill, so it is
// a narrow filter the way the product applies it (a few conversations).
const judgedDocuments = new Set(Object.values(qrels).flatMap((j) => Object.entries(j).filter(([, g]) => g > 0).map(([d]) => d)));
const threadOrder = [...archive.threads].sort((a, b) => Number(judgedDocuments.has(archive.threadOf.get(b))) - Number(judgedDocuments.has(archive.threadOf.get(a))));
const halfThreads = threadOrder.slice(0, 32);
const halfDocuments = new Set(halfThreads.map((threadId) => archive.threadOf.get(threadId)));
report.hybrid = {
  unfiltered: runQueries(archive.search, archive.documentOf, {}, allDocuments, queryVectors, "no filter"),
  messagesOnly: runQueries(archive.search, archive.documentOf, { sourceTypes: ["message"] }, messageDocuments, queryVectors, "sourceTypes: message"),
  documentsOnly: runQueries(archive.search, archive.documentOf, { sourceTypes: ["document"] }, pageDocuments, queryVectors, "sourceTypes: document"),
  threadFilter: runQueries(archive.search, archive.documentOf, { threadIds: halfThreads }, halfDocuments, queryVectors, `threadIds: ${halfThreads.length} of ${archive.threads.length} threads (${[...halfDocuments].filter((d) => judgedDocuments.has(d)).length} judged documents inside)`),
};
// Coarse stage forced on over the same archive: the end-to-end sign-bit path.
const coarseSearch = new SearchRepository(archive.db, noBlobs, { chunkTokenizer, semanticCoarseThreshold: 1 });
coarseSearch.initialize();
report.coarse = {
  candidates: SEMANTIC_PROJECTION.coarseCandidates, representation: SEMANTIC_PROJECTION.representation,
  note: `semanticCoarseThreshold: 1 forces Hamming top-${SEMANTIC_PROJECTION.coarseCandidates} + float rerank on a ${archive.semantic.vectors}-vector index (every vector is a candidate, so this proves the path and its overhead, not its scale benefit; see browser-knn for scale)`,
  unfiltered: runQueries(coarseSearch, archive.documentOf, {}, allDocuments, queryVectors, "coarse, no filter"),
  threadFilter: runQueries(coarseSearch, archive.documentOf, { threadIds: halfThreads }, halfDocuments, queryVectors, "coarse, thread filter"),
  status: coarseSearch.semanticStatus().projection,
};
await coarseSearch.close();
await archive.search.close();
archive.db.close();
// --- Part 2: chunk-size sweep -------------------------------------------------
console.error("chunk-size sweep");
report.chunkSizes = {};
for (const maxTokens of [128, 192, 256, 320, 384, 448]) {
  const policy = { maxCharacters: SEARCH_POLICY.maxCharacters, overlapCharacters: SEARCH_POLICY.overlapCharacters, tokenizer: chunkTokenizer, maxTokens };
  const chunks = [];
  for (const document of corpus) {
    const chunker = new StructuralChunker({ sourceType: document.kind === "conversation" ? "message" : "document", sourceId: document.id, partId: null, sourceDigest: sha256(document.text), contextPrefix: "" }, policy);
    for (const chunk of [...chunker.push(document.text), ...chunker.finish()]) {
      const inspection = chunkTokenizer.inspect(chunk.text, "document");
      if (inspection.overflow) throw new Error(`Chunk overflows the model at ${maxTokens}: ${document.id}`);
      chunks.push({ document_id: document.id, text: chunk.text, tokens: inspection.tokenCount });
    }
  }
  const vectors = chunks.map((chunk) => encoder.embedDocument(chunk.text));
  const rankings = {};
  for (const [row, query] of queries.entries()) {
    const q = queryVectors[row];
    const scores = vectors.map((vector) => { let sum = 0; for (let i = 0; i < 384; i++) sum += vector[i] * q[i]; return sum; });
    const order = scores.map((_, index) => index).sort((a, b) => scores[b] - scores[a] || a - b);
    const seen = new Set(), docs = [];
    for (const index of order) { const doc = chunks[index].document_id; if (!seen.has(doc)) { seen.add(doc); docs.push(doc); } }
    rankings[query.id] = docs;
  }
  const tokens = chunks.map((chunk) => chunk.tokens);
  report.chunkSizes[maxTokens] = { chunks: chunks.length, tokens: { min: Math.min(...tokens), max: Math.max(...tokens), mean: tokens.reduce((a, b) => a + b, 0) / tokens.length }, multiChunkDocuments: new Set(chunks.filter((chunk) => chunks.filter((other) => other.document_id === chunk.document_id).length > 1).map((chunk) => chunk.document_id)).size, exact_fp32: evaluate(rankings).mean };
  console.error(JSON.stringify({ maxTokens, chunks: chunks.length, exact: report.chunkSizes[maxTokens].exact_fp32 }));
}
encoder.dispose();
chunkTokenizer.dispose();
report.limitations = [
  "Same synthetic corpus and 18 judged queries as plan 16; equal scores across variants show the corpus cannot separate them, not that they are equal on real archives.",
  "Documents are single texts committed as one message per thread (uniform title) or one registered page; multi-message threads, provider metadata and dates are not exercised by these filters.",
  "Timings are Node in-memory SQLite, single observations; browser OPFS costs are in browser-knn-*.json.",
];
await writeFile(resolve(here, "hybrid-report.json"), JSON.stringify(report, null, 2) + "\n");
const summary = (block) => Object.fromEntries(Object.entries(block.results).map(([mode, r]) => [mode, { ...Object.fromEntries(Object.entries(r.mean).map(([k, v]) => [k, Number(v.toFixed(4))])), queries: r.queries, medianMs: Number(r.latency.medianMs.toFixed(1)) }]));
console.log(JSON.stringify({ archive: report.archive, hybrid: Object.fromEntries(Object.entries(report.hybrid).map(([k, v]) => [k, summary(v)])), coarse: { unfiltered: summary(report.coarse.unfiltered), threadFilter: summary(report.coarse.threadFilter) }, chunkSizes: Object.fromEntries(Object.entries(report.chunkSizes).map(([k, v]) => [k, { chunks: v.chunks, ...Object.fromEntries(Object.entries(v.exact_fp32).map(([m, x]) => [m, Number(x.toFixed(4))])) }])) }, null, 2));
