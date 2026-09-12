/** sqlite-vec cost of the ADR 0036 path in the pinned SQLite WASM build (run in
 * Node; the same WASM the storage worker loads, so this measures the engine,
 * not browser OPFS I/O): int8 coarse KNN (k=500) over N vectors plus a float32
 * rerank of the candidates, against a float32 KNN over the same N.
 *   node perf/retrieval/sqlite-vec-knn.mjs [--size=100000]
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import initialize from "../../packages/storage/sqlite/dist/sqlite3.mjs";
const here = fileURLToPath(new URL("./", import.meta.url)), root = resolve(here, "../../");
const size = Number(process.argv.find((a) => a.startsWith("--size="))?.slice(7) ?? 100000), D = 384, SCALE = 0.4 / 127;
const wasm = await readFile(resolve(root, "packages/storage/sqlite/dist/sqlite3.wasm"));
const manifest = JSON.parse(await readFile(resolve(root, "packages/storage/sqlite/artifacts.json"), "utf8"));
if (createHash("sha256").update(wasm).digest("hex") !== manifest.artifacts["sqlite3.wasm"].sha256) throw new Error("sqlite3.wasm does not match artifacts.json");
globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, "opfs-wl": true } } };
const sqlite = await initialize({ instantiateWasm: async (imports, success) => { const r = await WebAssembly.instantiate(wasm, imports); success(r.instance, r.module); }, print: () => {}, printErr: () => {} });
const db = new sqlite.oo1.DB(":memory:", "c");
db.exec(`CREATE VIRTUAL TABLE f USING vec0(embedding float[${D}]); CREATE VIRTUAL TABLE q8 USING vec0(embedding int8[${D}]);`);
// Deterministic pseudo-vectors with Arctic-like component magnitudes (max ~0.38).
let seed = 20260912; const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const vector = () => { const v = new Float32Array(D); let n = 0; for (let d = 0; d < D; d++) { v[d] = rand() - 0.5; n += v[d] * v[d]; } n = Math.sqrt(n); for (let d = 0; d < D; d++) v[d] = v[d] / n * 0.9; v[0] = Math.sqrt(1 - 0.81); return v; };
const int8 = (v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x / SCALE))));
const t0 = performance.now();
db.exec("BEGIN");
const insF = db.prepare("INSERT INTO f(rowid,embedding) VALUES(?,?)"), insQ = db.prepare("INSERT INTO q8(rowid,embedding) VALUES(?,vec_int8(?))");
for (let i = 1; i <= size; i++) { const v = vector(); insF.bind([i, new Uint8Array(v.buffer)]).stepReset(); insQ.bind([i, new Uint8Array(int8(v).buffer)]).stepReset(); }
insF.finalize(); insQ.finalize(); db.exec("COMMIT");
const buildMs = performance.now() - t0;
const queries = Array.from({ length: 12 }, vector);
const time = (fn) => { const samples = []; for (let rep = 0; rep < 3; rep++) for (const q of queries) { const t = performance.now(); fn(q); samples.push(performance.now() - t); } samples.sort((a, b) => a - b); return { medianMs: samples[Math.floor(samples.length / 2)], p95Ms: samples[Math.floor(samples.length * 0.95)] }; };
const floatKnn = time((q) => db.exec({ sql: "SELECT rowid,distance FROM f WHERE embedding MATCH ? AND k=64", bind: [new Uint8Array(q.buffer)], returnValue: "resultRows" }));
const int8Knn = time((q) => db.exec({ sql: "SELECT rowid FROM q8 WHERE embedding MATCH vec_int8(?) AND k=500", bind: [new Uint8Array(int8(q).buffer)], returnValue: "resultRows" }));
const coarseRerank = time((q) => db.exec({ sql: "SELECT v.rowid,vec_distance_L2(v.embedding,?) AS d FROM (SELECT rowid FROM q8 WHERE embedding MATCH vec_int8(?) AND k=500) c CROSS JOIN f v ON v.rowid=c.rowid ORDER BY d LIMIT 64", bind: [new Uint8Array(q.buffer), new Uint8Array(int8(q).buffer)], returnValue: "resultRows" }));
// Agreement between the coarse→rerank top-64 and the float top-64 on these pools.
let agree = 0; for (const q of queries) { const a = db.exec({ sql: "SELECT rowid FROM f WHERE embedding MATCH ? AND k=64", bind: [new Uint8Array(q.buffer)], returnValue: "resultRows" }).map((r) => r[0]); const b = new Set(db.exec({ sql: "SELECT v.rowid FROM (SELECT rowid FROM q8 WHERE embedding MATCH vec_int8(?) AND k=500) c CROSS JOIN f v ON v.rowid=c.rowid ORDER BY vec_distance_L2(v.embedding,?) LIMIT 64", bind: [new Uint8Array(int8(q).buffer), new Uint8Array(q.buffer)], returnValue: "resultRows" }).map((r) => r[0])); agree += a.filter((id) => b.has(id)).length / a.length; }
const report = { size, buildMs, floatKnnTop64: floatKnn, int8CoarseTop500: int8Knn, int8CoarseThenFloatRerankTop64: coarseRerank, top64AgreementWithFloat: agree / queries.length, note: "Pinned SQLite WASM (sqlite-vec) in Node; brute-force vec0 scans, pseudo-random unit-ish vectors; not browser OPFS timings." };
db.close();
await writeFile(resolve(here, `sqlite-vec-knn-${size}.json`), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
