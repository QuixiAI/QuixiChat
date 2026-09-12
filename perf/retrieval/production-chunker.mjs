/** Retrieval quality of the production chunk policy on the plan 16 corpus.
 *
 * Reuses the frozen corpus, queries and judgments, the metric definitions of
 * metrics.py (source-level recall@k and MRR after collapsing chunk hits to the
 * best rank per document, stable ties in corpus order), and the production
 * pieces exactly as storage and the app use them: `StructuralChunker` with the
 * pinned Arctic offset tokenizer and the 256-token budget (ADR 0034), and the
 * WASM SIMD encoder from the versioned distribution. Compare with
 * baseline.json, which used the reference 256/32 window chunker through the
 * PyTorch reference model.
 *
 *   node --experimental-transform-types perf/retrieval/production-chunker.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { arch, platform, release } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StructuralChunker } from "../../packages/search/src/chunker.ts";
import { createStorageChunkTokenizer } from "../../packages/storage/src/worker/search/tokenizer.ts";
import { SEARCH_POLICY } from "../../packages/storage/src/worker/search/schema.ts";
import { createSimdEncoder, supportsWasmSimd } from "../../packages/quixi-embed/src/simd.ts";
import { MODEL_LOCK } from "../../packages/quixi-embed/src/lock.ts";

const here = fileURLToPath(new URL("./", import.meta.url));
const root = resolve(here, "../../");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = async (name) => readFile(resolve(here, name));
const corpus = (await read("corpus.jsonl")).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
const queries = JSON.parse(await read("queries.json"));
const qrels = JSON.parse(await read("qrels.json"));
const manifest = JSON.parse(await read("corpus-manifest.json"));
const baseline = JSON.parse(await read("baseline.json"));
for (const [name, expected] of Object.entries(manifest.files ?? {})) {
  const actual = sha256(await read(name));
  if (expected.sha256 && actual !== expected.sha256) throw new Error(`${name} does not match corpus-manifest.json`);
}
const scalarWasm = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/1.0.2/quixi-scalar.wasm")));
const simdWasm = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/1.0.2/quixi-simd.wasm")));
const tokenizerBytes = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/model/arctic-xs.qxtokenizer")));
const modelPath = resolve(root, "packages/quixi-embed/build/arctic-xs.qxmodel");
const model = new Uint8Array(await readFile(modelPath));
if (sha256(model) !== MODEL_LOCK.model.sha256) throw new Error("Model does not match the lock");
if (sha256(simdWasm) !== MODEL_LOCK.wasm.simd.sha256) throw new Error("SIMD WASM does not match the lock");
if (!supportsWasmSimd()) throw new Error("This Node lacks WASM SIMD");
const tokenizer = await createStorageChunkTokenizer({ wasm: scalarWasm, tokenizer: tokenizerBytes });
const policy = { maxCharacters: SEARCH_POLICY.maxCharacters, overlapCharacters: SEARCH_POLICY.overlapCharacters, tokenizer, maxTokens: SEARCH_POLICY.maxTokens };
// Production chunking, no context prefix: the corpus has no titles, so this
// measures the cut policy alone, as the reference run did.
const started = performance.now();
const chunks = [];
for (const document of corpus) {
  const chunker = new StructuralChunker({ sourceType: document.kind === "conversation" ? "message" : "document", sourceId: document.id, partId: null, sourceDigest: sha256(document.text), contextPrefix: "" }, policy);
  for (const chunk of [...chunker.push(document.text), ...chunker.finish()]) {
    const inspection = tokenizer.inspect(chunk.text, "document");
    if (inspection.overflow) throw new Error(`Chunk overflows the model: ${document.id}`);
    chunks.push({ id: chunk.id, document_id: document.id, text: chunk.text, start: chunk.position.start, end: chunk.position.end, tokens: inspection.tokenCount });
  }
}
const chunkingMs = performance.now() - started;
const chunkerVersion = new StructuralChunker({ sourceType: "document", sourceId: "x", partId: null, sourceDigest: "0".repeat(64), contextPrefix: "" }, policy).version;
const encoder = await createSimdEncoder({ wasm: simdWasm, model });
const loadMs = performance.now() - started - chunkingMs;
const embedStart = performance.now();
const vectors = chunks.map((chunk) => encoder.embedDocument(chunk.text));
const corpusEmbeddingMs = performance.now() - embedStart;
const queryStart = performance.now();
const queryVectors = queries.map((query) => encoder.embedQuery(query.text));
const queryEmbeddingMs = performance.now() - queryStart;
encoder.dispose();
tokenizer.dispose();
const dot = (a, b) => { let sum = 0; for (let i = 0; i < a.length; i++) sum += a[i] * b[i]; return sum; };
const documentRanking = (order) => [...new Set(order.map((index) => chunks[index].document_id))];
function evaluate(rankings) {
  const rows = {};
  for (const [query, judgments] of Object.entries(qrels)) {
    const relevant = new Set(Object.entries(judgments).filter(([, grade]) => grade > 0).map(([doc]) => doc));
    const ranking = rankings[query];
    const row = {};
    for (const k of [5, 10, 100, 500]) row[`recall@${k}`] = ranking.slice(0, k).filter((doc) => relevant.has(doc)).length / relevant.size;
    const first = ranking.findIndex((doc) => relevant.has(doc));
    row.mrr = first === -1 ? 0 : 1 / (first + 1);
    rows[query] = row;
  }
  const keys = Object.keys(Object.values(rows)[0]);
  const mean = Object.fromEntries(keys.map((key) => [key, Object.values(rows).reduce((sum, row) => sum + row[key], 0) / Object.keys(rows).length]));
  return { mean, per_query: rows };
}
const rankings = {}, topTen = {};
for (const [row, query] of queries.entries()) {
  const scores = vectors.map((vector) => dot(queryVectors[row], vector));
  if (scores.some((score) => !Number.isFinite(score))) throw new Error("Nonfinite score");
  const order = scores.map((score, index) => index).sort((a, b) => scores[b] - scores[a] || a - b);
  rankings[query.id] = documentRanking(order);
  topTen[query.id] = rankings[query.id].slice(0, 10);
}
const exact = evaluate(rankings);
// baseline.per_query is a list of { id, top10_exact, top10_reranked }.
const baselineTopTen = Object.fromEntries((baseline.per_query ?? []).map((entry) => [entry.id, entry.top10_exact ?? null]));
const changedTopTen = Object.entries(topTen).filter(([query, docs]) => baselineTopTen[query] && JSON.stringify(baselineTopTen[query].slice(0, 10)) !== JSON.stringify(docs)).map(([query]) => query);
const delta = Object.fromEntries(Object.entries(exact.mean).map(([key, value]) => [key, value - baseline.exact_fp32.mean[key]]));
const tokens = chunks.map((chunk) => chunk.tokens);
const report = {
  version: 1,
  measuredAt: new Date().toISOString(),
  environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version },
  model: { name: MODEL_LOCK.modelName, sourceRevision: MODEL_LOCK.sourceRevision, artifactSha256: MODEL_LOCK.model.sha256, route: "wasm-simd-fp32", runtime: MODEL_LOCK.runtimeVersion, tokenizerSha256: MODEL_LOCK.tokenizer.sha256 },
  corpus: { manifest, documents: corpus.length, queries: queries.length },
  chunker: { id: chunkerVersion, policy: { maxCharacters: policy.maxCharacters, overlapCharacters: policy.overlapCharacters, maxTokens: policy.maxTokens }, contextPrefix: "none (corpus has no titles; storage adds 'Title > role' or 'Title > sections' in production)", coordinateUnit: "utf-16 code units" },
  chunks: chunks.length,
  chunkTokens: { min: Math.min(...tokens), max: Math.max(...tokens), mean: tokens.reduce((a, b) => a + b, 0) / tokens.length, multiChunkDocuments: new Set(chunks.filter((chunk) => chunks.filter((other) => other.document_id === chunk.document_id).length > 1).map((chunk) => chunk.document_id)).size },
  exact_fp32: exact,
  baseline: { chunker: baseline.chunker, chunks: baseline.chunks, exact_fp32: baseline.exact_fp32.mean },
  delta_vs_baseline: delta,
  changed_top_ten_queries: changedTopTen,
  top_ten: topTen,
  timing: { chunkingMs, encoderLoadMs: loadMs, corpusEmbeddingMs, queryEmbeddingMs, note: "Single run on a development host; not a throughput claim." },
  limitations: [
    "Same synthetic corpus and judgments as the baseline; equal or better scores here do not establish quality on real archives.",
    "Vectors come from the production WASM SIMD route rather than the PyTorch reference; both are numerically gated by the plan 16 comparator.",
    "The context-prefix format used in production is not exercised because the corpus carries no titles.",
  ],
};
const output = resolve(here, "production-chunker.json");
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, chunks: chunks.length, baselineChunks: baseline.chunks, exact: exact.mean, delta, changedTopTen }, null, 2));
