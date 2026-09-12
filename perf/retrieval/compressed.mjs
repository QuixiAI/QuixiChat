/** Plan 22 representation benchmark (product §77–§81) on the plan 16 corpus
 * with real Arctic XS vectors from the production chunker and WASM SIMD route,
 * scaled to 100k/500k/1M vectors with deterministic distractors derived from
 * the real vector distribution.
 *
 * Measured per pool size: exact float32 full scan; int8 full scan (per-vector
 * and global scale); sign-bit coarse retrieval at 200/500/1000 candidates with
 * float32 or int8 rerank; int8 coarse with float32 rerank. Reports judged
 * Recall@5/10, MRR, coarse judged Recall@100/500, candidate overlap with the
 * exact float top-k chunks, per-query latency in this Node process (typed
 * arrays, single thread), and index bytes. Distractors are unjudged and count
 * as nonrelevant; they cannot make the judged metrics better, only worse.
 *
 *   node --experimental-transform-types perf/retrieval/compressed.mjs [--sizes 100000,500000,1000000]
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { arch, platform, release, cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StructuralChunker } from "../../packages/search/src/chunker.ts";
import { createStorageChunkTokenizer } from "../../packages/storage/src/worker/search/tokenizer.ts";
import { SEARCH_POLICY } from "../../packages/storage/src/worker/search/schema.ts";
import { createSimdEncoder } from "../../packages/quixi-embed/src/simd.ts";
import { MODEL_LOCK } from "../../packages/quixi-embed/src/lock.ts";

const here = fileURLToPath(new URL("./", import.meta.url));
const root = resolve(here, "../../");
const D = 384;
const sizes = (process.argv.find((arg) => arg.startsWith("--sizes="))?.slice(8) ?? "100000,500000,1000000").split(",").map(Number);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const corpus = (await readFile(resolve(here, "corpus.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const queries = JSON.parse(await readFile(resolve(here, "queries.json"), "utf8"));
const qrels = JSON.parse(await readFile(resolve(here, "qrels.json"), "utf8"));
// --- Real vectors through the production route -----------------------------
const scalarWasm = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/1.0.2/quixi-scalar.wasm")));
const simdWasm = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/1.0.2/quixi-simd.wasm")));
const tokenizerBytes = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/artifacts/model/arctic-xs.qxtokenizer")));
const model = new Uint8Array(await readFile(resolve(root, "packages/quixi-embed/build/arctic-xs.qxmodel")));
if (sha256(model) !== MODEL_LOCK.model.sha256) throw new Error("Model does not match the lock");
const tokenizer = await createStorageChunkTokenizer({ wasm: scalarWasm, tokenizer: tokenizerBytes });
const policy = { maxCharacters: SEARCH_POLICY.maxCharacters, overlapCharacters: SEARCH_POLICY.overlapCharacters, tokenizer, maxTokens: SEARCH_POLICY.maxTokens };
const chunks = [];
for (const document of corpus) {
  const chunker = new StructuralChunker({ sourceType: document.kind === "conversation" ? "message" : "document", sourceId: document.id, partId: null, sourceDigest: sha256(document.text), contextPrefix: "" }, policy);
  for (const chunk of [...chunker.push(document.text), ...chunker.finish()]) chunks.push({ document_id: document.id, text: chunk.text });
}
const encoder = await createSimdEncoder({ wasm: simdWasm, model });
const real = chunks.map((chunk) => encoder.embedDocument(chunk.text));
const queryVectors = queries.map((query) => encoder.embedQuery(query.text));
encoder.dispose(); tokenizer.dispose();
const R = real.length;
// --- Deterministic distractors from the real distribution ------------------
/** xorshift128+ seeded; recorded so the pools are reproducible. */
function rng(seed) {
  let s0 = BigInt(seed) & 0xffffffffffffffffn, s1 = (BigInt(seed) * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
  return () => { let x = s0, y = s1; s0 = y; x ^= (x << 23n) & 0xffffffffffffffffn; x ^= x >> 17n; x ^= y ^ (y >> 26n); s1 = x; return Number((x + y) & 0x1fffffffffffffn) / 0x20000000000000; };
}
const GENERATOR = { id: "real-mixture-v1", seed: 20260912, mix: "normalize(a*v_i + b*v_j + 0.15*gaussian) with a,b uniform in [0.3,1], i,j random real chunk vectors", note: "Keeps the model's anisotropic distribution; distractors are unjudged and never relevant." };
function buildPool(size) {
  const pool = new Float32Array(size * D);
  for (let i = 0; i < R; i++) pool.set(real[i], i * D);
  const next = rng(GENERATOR.seed + size);
  const gaussian = () => { const u = 1 - next(), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  for (let n = R; n < size; n++) {
    const i = Math.floor(next() * R), j = Math.floor(next() * R), a = 0.3 + 0.7 * next(), b = 0.3 + 0.7 * next();
    const base = n * D; let norm = 0;
    for (let d = 0; d < D; d++) { const value = a * real[i][d] + b * real[j][d] + 0.15 * gaussian(); pool[base + d] = value; norm += value * value; }
    norm = Math.sqrt(norm); for (let d = 0; d < D; d++) pool[base + d] /= norm;
  }
  return pool;
}
// --- Representations ---------------------------------------------------------
function quantizeInt8PerVector(pool, size) {
  const q = new Int8Array(size * D), scales = new Float32Array(size);
  for (let n = 0; n < size; n++) {
    let max = 0; for (let d = 0; d < D; d++) max = Math.max(max, Math.abs(pool[n * D + d]));
    const scale = max / 127 || 1; scales[n] = scale;
    for (let d = 0; d < D; d++) q[n * D + d] = Math.round(pool[n * D + d] / scale);
  }
  return { q, scales };
}
function quantizeInt8Global(pool, size) {
  let max = 0; for (let i = 0; i < size * D; i++) max = Math.max(max, Math.abs(pool[i]));
  const scale = max / 127, q = new Int8Array(size * D);
  for (let i = 0; i < size * D; i++) q[i] = Math.round(pool[i] / scale);
  return { q, scale };
}
function quantizeBits(pool, size) {
  const bits = new Uint8Array(size * (D / 8));
  for (let n = 0; n < size; n++) for (let d = 0; d < D; d++) if (pool[n * D + d] >= 0) bits[n * 48 + (d >> 3)] |= 1 << (d & 7);
  return bits;
}
const popcount = new Uint8Array(256); for (let i = 0; i < 256; i++) { let c = 0, v = i; while (v) { c += v & 1; v >>= 1; } popcount[i] = c; }
const queryInt8 = (vector) => { let max = 0; for (const value of vector) max = Math.max(max, Math.abs(value)); const scale = max / 127 || 1; return { q: Int8Array.from(vector, (value) => Math.round(value / scale)), scale }; };
const queryBits = (vector) => { const bits = new Uint8Array(48); for (let d = 0; d < D; d++) if (vector[d] >= 0) bits[d >> 3] |= 1 << (d & 7); return bits; };
/** Top-k indices by descending score (ascending distance when negated), stable by index. */
function topK(scores, k) {
  const size = scores.length; const heapIndex = new Int32Array(k), heapScore = new Float64Array(k); let count = 0;
  const swap = (a, b) => { const i = heapIndex[a], s = heapScore[a]; heapIndex[a] = heapIndex[b]; heapScore[a] = heapScore[b]; heapIndex[b] = i; heapScore[b] = s; };
  const less = (a, b) => heapScore[a] < heapScore[b] || (heapScore[a] === heapScore[b] && heapIndex[a] > heapIndex[b]);
  for (let n = 0; n < size; n++) {
    const score = scores[n];
    if (count < k) { heapIndex[count] = n; heapScore[count] = score; let c = count++; while (c > 0) { const p = (c - 1) >> 1; if (less(c, p)) { swap(c, p); c = p; } else break; } }
    else if (score > heapScore[0] || (score === heapScore[0] && n < heapIndex[0])) {
      heapIndex[0] = n; heapScore[0] = score; let c = 0;
      for (;;) { const l = 2 * c + 1, r = l + 1; let m = c; if (l < count && less(l, m)) m = l; if (r < count && less(r, m)) m = r; if (m === c) break; swap(c, m); c = m; }
    }
  }
  const out = []; for (let i = 0; i < count; i++) out.push(heapIndex[i]);
  return out.sort((a, b) => scores[b] - scores[a] || a - b);
}
const dotFloat = (pool, n, query) => { let sum = 0; const base = n * D; for (let d = 0; d < D; d++) sum += pool[base + d] * query[d]; return sum; };
const dotInt8 = (q, n, query) => { let sum = 0; const base = n * D; for (let d = 0; d < D; d++) sum += q[base + d] * query[d]; return sum; };
const hamming = (bits, n, query) => { let distance = 0; const base = n * 48; for (let b = 0; b < 48; b++) distance += popcount[bits[base + b] ^ query[b]]; return distance; };
// --- Metrics -----------------------------------------------------------------
const documentOf = (index) => index < R ? chunks[index].document_id : `distractor-${index}`;
const collapse = (order) => { const seen = new Set(), docs = []; for (const index of order) { const doc = documentOf(index); if (!seen.has(doc)) { seen.add(doc); docs.push(doc); } } return docs; };
function judged(rankings) {
  const rows = {};
  for (const [query, judgments] of Object.entries(qrels)) {
    const relevant = new Set(Object.entries(judgments).filter(([, grade]) => grade > 0).map(([doc]) => doc)), ranking = rankings[query], row = {};
    for (const k of [5, 10, 100, 500]) row[`recall@${k}`] = ranking.slice(0, k).filter((doc) => relevant.has(doc)).length / relevant.size;
    const first = ranking.findIndex((doc) => relevant.has(doc)); row.mrr = first === -1 ? 0 : 1 / (first + 1);
    rows[query] = row;
  }
  const keys = Object.keys(Object.values(rows)[0]);
  return Object.fromEntries(keys.map((key) => [key, Object.values(rows).reduce((sum, row) => sum + row[key], 0) / Object.keys(rows).length]));
}
const overlap = (candidates, exact, k) => { const truth = new Set(exact.slice(0, k)); let hit = 0; for (const c of candidates) if (truth.has(c)) hit++; return hit / truth.size; };
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]; };
const timing = (values) => ({ medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samples: values.length });
// --- Run -----------------------------------------------------------------------
const report = {
  version: 1, measuredAt: new Date().toISOString(),
  environment: { platform: platform(), release: release(), arch: arch(), osVersion: platform() === "darwin" ? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim() : release(), node: process.version, cpu: cpus()[0]?.model ?? null, note: "Single-threaded JavaScript typed-array scans in Node; not browser, WASM or sqlite-vec timings." },
  model: { name: MODEL_LOCK.modelName, artifactSha256: MODEL_LOCK.model.sha256, route: "wasm-simd-fp32", runtime: MODEL_LOCK.runtimeVersion },
  chunker: { policy: { maxCharacters: policy.maxCharacters, overlapCharacters: policy.overlapCharacters, maxTokens: policy.maxTokens }, realChunks: R },
  generator: GENERATOR, queries: queries.length, sizes: {},
};
const REPS = 3, CANDIDATES = [200, 500, 1000];
for (const size of sizes) {
  console.error(`pool ${size}`);
  const pool = buildPool(size);
  const int8 = quantizeInt8PerVector(pool, size), int8g = quantizeInt8Global(pool, size), bits = quantizeBits(pool, size);
  const result = { bytes: { float32: size * D * 4, int8: size * D + size * 4, int8Global: size * D, binary: size * 48 }, pipelines: {} };
  const exactRanks = {}, exactChunkTop = {};
  const scoresFloat = new Float64Array(size), scoresInt = new Float64Array(size), distances = new Float64Array(size);
  const lat = { float: [], int8: [], int8Global: [], binaryCoarse: [], int8Coarse: [], rerankFloat: {}, rerankInt8: {} };
  const rankings = { float: {}, int8: {}, int8Global: {}, binaryCoarse: {}, int8Coarse: {} };
  for (const k of CANDIDATES) { rankings[`binary${k}float`] = {}; rankings[`binary${k}int8`] = {}; rankings[`int8${k}float`] = {}; rankings[`int8g${k}float`] = {}; }
  const coarseOverlap = { binary: { 100: [], 500: [] }, int8: { 100: [], 500: [] }, int8Global: { 100: [], 500: [] } };
  for (let rep = 0; rep < REPS; rep++) for (const [row, query] of queries.entries()) {
    const qv = queryVectors[row], qi = queryInt8(qv), qb = queryBits(qv);
    let t = performance.now(); for (let n = 0; n < size; n++) scoresFloat[n] = dotFloat(pool, n, qv); const exact = topK(scoresFloat, 1000); lat.float.push(performance.now() - t);
    t = performance.now(); for (let n = 0; n < size; n++) scoresInt[n] = dotInt8(int8.q, n, qi.q) * int8.scales[n]; const int8Rank = topK(scoresInt, 1000); lat.int8.push(performance.now() - t);
    t = performance.now(); for (let n = 0; n < size; n++) scoresInt[n] = dotInt8(int8g.q, n, qi.q); const int8gRank = topK(scoresInt, 1000); lat.int8Global.push(performance.now() - t);
    t = performance.now(); for (let n = 0; n < size; n++) distances[n] = -hamming(bits, n, qb); const binaryRank = topK(distances, 1000); lat.binaryCoarse.push(performance.now() - t);
    if (rep === 0) {
      exactRanks[query.id] = exact; exactChunkTop[query.id] = exact;
      rankings.float[query.id] = collapse(exact); rankings.int8[query.id] = collapse(int8Rank); rankings.int8Global[query.id] = collapse(int8gRank); rankings.binaryCoarse[query.id] = collapse(binaryRank); rankings.int8Coarse[query.id] = collapse(int8Rank);
      for (const k of [100, 500]) { coarseOverlap.binary[k].push(overlap(binaryRank.slice(0, k), exact, k)); coarseOverlap.int8[k].push(overlap(int8Rank.slice(0, k), exact, k)); coarseOverlap.int8Global[k].push(overlap(int8gRank.slice(0, k), exact, k)); }
    }
    for (const k of CANDIDATES) {
      // Binary coarse → float rerank / int8 rerank; int8 coarse → float rerank.
      t = performance.now(); const cand = binaryRank.slice(0, k); const reranked = cand.map((n) => [n, dotFloat(pool, n, qv)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n); (lat.rerankFloat[k] ??= []).push(performance.now() - t);
      t = performance.now(); const rerankedInt = cand.map((n) => [n, dotInt8(int8.q, n, qi.q) * int8.scales[n]]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n); (lat.rerankInt8[k] ??= []).push(performance.now() - t);
      const int8Cand = int8Rank.slice(0, k).map((n) => [n, dotFloat(pool, n, qv)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n);
      const int8gCand = int8gRank.slice(0, k).map((n) => [n, dotFloat(pool, n, qv)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([n]) => n);
      if (rep === 0) { rankings[`binary${k}float`][query.id] = collapse(reranked); rankings[`binary${k}int8`][query.id] = collapse(rerankedInt); rankings[`int8${k}float`][query.id] = collapse(int8Cand); rankings[`int8g${k}float`][query.id] = collapse(int8gCand); }
    }
  }
  result.pipelines.float32FullScan = { judged: judged(rankings.float), latency: timing(lat.float) };
  result.pipelines.int8FullScan = { judged: judged(rankings.int8), latency: timing(lat.int8), scale: "per-vector symmetric max/127" };
  result.pipelines.int8GlobalFullScan = { judged: judged(rankings.int8Global), latency: timing(lat.int8Global), scale: `global symmetric ${int8g.scale}` };
  result.pipelines.binaryCoarse = { judged: judged(rankings.binaryCoarse), latency: timing(lat.binaryCoarse), candidateOverlapWithExactChunks: { 100: coarseOverlap.binary[100].reduce((a, b) => a + b, 0) / queries.length, 500: coarseOverlap.binary[500].reduce((a, b) => a + b, 0) / queries.length } };
  result.pipelines.int8Coarse = { candidateOverlapWithExactChunks: { 100: coarseOverlap.int8[100].reduce((a, b) => a + b, 0) / queries.length, 500: coarseOverlap.int8[500].reduce((a, b) => a + b, 0) / queries.length } };
  result.pipelines.int8GlobalCoarse = { candidateOverlapWithExactChunks: { 100: coarseOverlap.int8Global[100].reduce((a, b) => a + b, 0) / queries.length, 500: coarseOverlap.int8Global[500].reduce((a, b) => a + b, 0) / queries.length } };
  for (const k of CANDIDATES) {
    result.pipelines[`binaryCoarse${k}_float32Rerank`] = { judged: judged(rankings[`binary${k}float`]), rerankLatency: timing(lat.rerankFloat[k]) };
    result.pipelines[`binaryCoarse${k}_int8Rerank`] = { judged: judged(rankings[`binary${k}int8`]), rerankLatency: timing(lat.rerankInt8[k]) };
    result.pipelines[`int8Coarse${k}_float32Rerank`] = { judged: judged(rankings[`int8${k}float`]) };
    result.pipelines[`int8GlobalCoarse${k}_float32Rerank`] = { judged: judged(rankings[`int8g${k}float`]) };
  }
  report.sizes[size] = result;
  console.error(JSON.stringify({ size, float: result.pipelines.float32FullScan.judged, int8: result.pipelines.int8FullScan.judged, binaryCoarse: result.pipelines.binaryCoarse, b500f: result.pipelines.binaryCoarse500_float32Rerank.judged, b1000f: result.pipelines.binaryCoarse1000_float32Rerank.judged, latency: { float: result.pipelines.float32FullScan.latency, int8: result.pipelines.int8FullScan.latency, binary: result.pipelines.binaryCoarse.latency } }));
  await writeFile(resolve(here, "compressed-report.json"), JSON.stringify(report, null, 2) + "\n");
}
report.finishedAt = new Date().toISOString();
await writeFile(resolve(here, "compressed-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("wrote perf/retrieval/compressed-report.json");
